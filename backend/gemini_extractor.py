import logging
import mimetypes
import os
import time
from typing import Literal

from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel

logger = logging.getLogger(__name__)


Category = Literal[
    "Food",
    "Groceries",
    "Transport",
    "Travel",
    "Shopping",
    "Bills",
    "Medical",
    "Entertainment",
    "Education",
    "General",
]


PROMPT = """Extract structured data from this receipt image.

- vendor: merchant/store/canteen name shown near the top of the receipt (e.g. "3108-MB Area Cobra Canteen"). Exclude generic document headings like "GROCERY BILL (ORIGINAL)" or "TAX INVOICE".
- total_amount: final total paid, as a number in the receipt's currency. Pick the definitively-labeled total (Total, Grand Total, Net Amount, Amount Due, AMT PD), not subtotals or tax lines.
- date: transaction date as ISO YYYY-MM-DD; empty string if unreadable. Note: on narrow thermal receipts, 4-digit years or dates may wrap across lines (e.g. "DT 18/11/202" followed by "6" means 2026-11-18; "DT 18-Nov-26" means 2026-11-18).
- source_currency: ISO 4217 code (USD, INR, EUR, GBP, JPY, etc.). Indian receipts (Rs, Canteen, Jabalpur) use INR. Use "MIXED" if more than one currency appears on the receipt.
- detected_currencies: every ISO 4217 code seen on the receipt.
- items: each purchased line item with name, qty, and total line amount in source currency.
  * TWO-LINE / STACKED RECEIPT TABLE FORMATS:
    Many POS/canteen receipts print each item across two lines in one of two formats:

    Format 1 (Quantity & Price ABOVE description):
      Header: Index/ Qty Rate AMT Amount
              Item Description TAX% +TAX
      Line 1: 050511K  2  544.56  0.00  1089.12  <-- Qty, Unit Rate, and Line Amount are on this line!
      Line 2: FOOTBALL NIVIA  0.00%              <-- Description is on this line!
      -> Name: "FOOTBALL NIVIA", Qty: 2, Amount: 1089.12

    Format 2 (Description on Line 1, Total Amount on Line 2):
      Header: Index  Item description  Qty Rate+TA
              X      Amount
      Line 1: 001024A  BLADE 7 O CLOCK PLAT  8  25.94  <-- Description, Qty (8), Unit Rate (25.94)
      Line 2: 207.52                                    <-- Line Total Amount (8 * 25.94 = 207.52)
      -> Name: "BLADE 7 O CLOCK PLAT", Qty: 8, Amount: 207.52

  * CRITICAL RULES FOR ALL ITEMS:
    1. 'name': Always extract the human-readable product name (e.g. "POLISH CHERRY BLOSSOM BL", "FOOTBALL NIVIA"). NEVER use alphanumeric index/item codes (like "028015T", "050511K") as the name.
    2. 'qty': Extract the item count if shown (e.g. 8 for blades, 2 for football).
    3. 'amount': ALWAYS extract the final EXTENDED line amount (Qty * Unit Rate), NEVER the unit rate or tax amount. For example, 8 blades at 25.94 has line amount 207.52 — 'amount' MUST be 207.52, NOT 25.94.
- category: classify the receipt as one of:
    Food (restaurants, cafes, food delivery, coffee shops)
    Groceries (supermarkets, canteens, grocery stores, produce, household staples)
    Transport (taxi, ride-share, fuel, public transit, flights, parking)
    Travel (hotels, lodging, vacation rentals, travel insurance)
    Shopping (clothing, electronics, home goods, retail)
    Bills (utilities, rent, phone, internet, insurance, subscriptions)
    Medical (pharmacy, prescriptions, doctor, dental, vision, hospital, copay)
    Entertainment (movies, concerts, events, games, books)
    Education (tuition, courses, training, school supplies)
    General (anything that doesn't clearly fit above)
  Use General when uncertain. Pick exactly one."""


class ReceiptItem(BaseModel):
    name: str = ""
    amount: float = 0.0
    qty: float | None = None


# Defaults let the prompt-only Z.AI backend degrade gracefully when the model
# omits a field; Gemini's response_schema always populates them.
class ReceiptData(BaseModel):
    vendor: str = "Unknown"
    total_amount: float = 0.0
    date: str = ""
    source_currency: str = "INR"
    detected_currencies: list[str] = []
    items: list[ReceiptItem] = []
    category: Category = "General"


class ReceiptExtractionError(RuntimeError):
    pass


class GeminiExtractor:
    def __init__(self):
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY environment variable is not set")
        self.client = genai.Client(api_key=api_key, http_options={"api_version": "v1beta"})
        self.model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
        self.max_retries = int(os.environ.get("GEMINI_MAX_RETRIES", "2"))
        self.retry_backoff_seconds = float(os.environ.get("GEMINI_RETRY_BACKOFF_SECONDS", "1.5"))

    def extract(self, image_path: str) -> ReceiptData:
        mime, _ = mimetypes.guess_type(image_path)
        if not mime:
            mime = "application/octet-stream"
        with open(image_path, "rb") as f:
            image_bytes = f.read()
        attempts = self.max_retries + 1
        for attempt in range(1, attempts + 1):
            try:
                response = self.client.models.generate_content(
                    model=self.model,
                    contents=[
                        types.Part.from_bytes(data=image_bytes, mime_type=mime),
                        PROMPT,
                    ],
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        response_schema=ReceiptData,
                        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
                    ),
                )
                if response.parsed is None:
                    raise ReceiptExtractionError("OCR model returned an empty structured response.")
                return response.parsed
            except genai_errors.ServerError as exc:
                logger.warning(
                    "Gemini server error on attempt %s/%s: %s",
                    attempt,
                    attempts,
                    exc,
                )
                if attempt >= attempts:
                    raise ReceiptExtractionError("OCR service is temporarily unavailable. Please retry.") from exc
            except genai_errors.ClientError as exc:
                logger.warning("Gemini client error: %s", exc)
                raise ReceiptExtractionError("OCR request was rejected by Gemini. Verify API key and quota.") from exc
            except genai_errors.APIError as exc:
                logger.warning("Gemini API error: %s", exc)
                if attempt >= attempts:
                    raise ReceiptExtractionError("OCR failed due to an upstream API error. Please retry.") from exc
            except Exception as exc:
                logger.exception("Unexpected Gemini extraction failure")
                raise ReceiptExtractionError("OCR processing failed unexpectedly. Please retry.") from exc
            if attempt < attempts:
                time.sleep(self.retry_backoff_seconds * attempt)

        raise ReceiptExtractionError("OCR failed unexpectedly after retries.")
