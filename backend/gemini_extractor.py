import mimetypes
import os
from typing import Literal, Optional

from google import genai
from google.genai import types
from pydantic import BaseModel


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


class GeminiExtractor:
    def __init__(self):
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY environment variable is not set")
        self.client = genai.Client(api_key=api_key)

    def extract(self, image_path: str) -> ReceiptData:
        mime, _ = mimetypes.guess_type(image_path)
        if not mime or not mime.startswith("image/"):
            mime = "image/jpeg"
        with open(image_path, "rb") as f:
            image_bytes = f.read()
        response = self.client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[
                types.Part.from_bytes(data=image_bytes, mime_type=mime),
                PROMPT,
            ],
            config={
                "response_mime_type": "application/json",
                "response_schema": ReceiptData,
            },
        )
        return response.parsed
