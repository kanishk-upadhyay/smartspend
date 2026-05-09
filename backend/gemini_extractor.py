import mimetypes
import os
import logging
import time
from typing import Literal, Optional

from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel

logger = logging.getLogger(__name__)


Category = Literal["Food", "Transport", "Shopping", "Bills", "General"]


PROMPT = """Extract structured data from this receipt image.

- vendor: merchant/store name shown on the receipt (usually near the top)
- total_amount: final total paid, as a number in the receipt's currency
- date: transaction date as ISO YYYY-MM-DD; empty string if unreadable
- source_currency: ISO 4217 code (USD, INR, EUR, GBP, JPY, etc.). Use "MIXED" if more than one currency appears on the receipt.
- detected_currencies: every ISO 4217 code seen on the receipt
- items: each purchased line item with name and amount in source currency. Include qty if explicitly shown. Exclude tax, total, subtotal, discount, tip, and payment lines.
- category: classify the receipt as one of:
    Food (restaurants, cafes, groceries, food delivery)
    Transport (taxi, ride-share, fuel, public transit, flights, parking)
    Shopping (clothing, electronics, home goods, retail)
    Bills (utilities, rent, phone, internet, insurance, subscriptions)
    General (anything that doesn't clearly fit above)
  Use General when uncertain. Pick exactly one.

Pick the definitively-labeled total (Total, Grand Total, Amount Due), not subtotals."""


class ReceiptItem(BaseModel):
    name: str
    amount: float
    qty: Optional[float] = None


class ReceiptData(BaseModel):
    vendor: str
    total_amount: float
    date: str
    source_currency: str
    detected_currencies: list[str]
    items: list[ReceiptItem]
    category: Category


class ReceiptExtractionError(RuntimeError):
    pass


class GeminiExtractor:
    def __init__(self):
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY environment variable is not set")
        self.client = genai.Client(api_key=api_key)
        self.model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
        self.max_retries = int(os.environ.get("GEMINI_MAX_RETRIES", "2"))
        self.retry_backoff_seconds = float(os.environ.get("GEMINI_RETRY_BACKOFF_SECONDS", "1.5"))

    def extract(self, image_path: str) -> ReceiptData:
        mime, _ = mimetypes.guess_type(image_path)
        if not mime or not mime.startswith("image/"):
            mime = "image/jpeg"
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
                    config={
                        "response_mime_type": "application/json",
                        "response_schema": ReceiptData,
                    },
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
