"""
Z.AI GLM-4.6V-Flash receipt extractor.

Used as the fallback OCR backend when Gemini is unavailable or fails.
The Z.AI SDK is OpenAI-compatible, but:
  - Images must be sent as base64 data URLs (not raw bytes).
  - Structured output uses response_format={"type": "json_object"} with
    the expected schema embedded in the prompt — Z.AI does not support
    Gemini-style response_schema / native Pydantic binding.
  - Response text is parsed manually: json.loads() → Pydantic validation.
"""

import base64
import json
import logging
import mimetypes
import os
import time

from pydantic import ValidationError
from zai import ZaiClient

# Re-use the shared data models and prompt from the Gemini extractor so
# both backends produce identical output types.
from gemini_extractor import PROMPT, ReceiptData, ReceiptExtractionError

logger = logging.getLogger(__name__)

# Appended to the shared PROMPT so the model knows the exact JSON shape
# expected, since Z.AI cannot enforce a schema natively.
_SCHEMA_SUFFIX = """

Return ONLY a single valid JSON object — no markdown fences, no explanation, \
no trailing text. The object MUST match this schema exactly:
{
  "vendor": "<string>",
  "total_amount": <number>,
  "date": "<YYYY-MM-DD or empty string>",
  "source_currency": "<ISO 4217 code, or MIXED>",
  "detected_currencies": ["<ISO 4217 code>", ...],
  "items": [
    {
      "name": "<string>",
      "amount": <number>,
      "qty": <number or null>
    }
  ],
  "category": "<Food|Groceries|Transport|Travel|Shopping|Bills|Medical|Entertainment|Education|General>"
}"""

ZAI_PROMPT = PROMPT + _SCHEMA_SUFFIX


class ZaiExtractor:
    """Calls GLM-4.6V-Flash (or another Z.AI vision model) to extract
    structured receipt data from a local image file."""

    def __init__(self) -> None:
        api_key = os.environ.get("ZAI_API_KEY")
        if not api_key:
            raise RuntimeError("ZAI_API_KEY environment variable is not set")
        self.client = ZaiClient(api_key=api_key)
        self.model = os.environ.get("ZAI_MODEL", "glm-4.6v-flash")
        self.max_retries = int(os.environ.get("ZAI_MAX_RETRIES", "2"))
        self.retry_backoff_seconds = float(
            os.environ.get("ZAI_RETRY_BACKOFF_SECONDS", "1.5")
        )

    def extract(self, image_path: str) -> ReceiptData:
        """Extract structured data from *image_path* and return a ReceiptData.

        Raises ReceiptExtractionError on all unrecoverable failures so that
        the caller can fall back to the next backend without catching
        library-specific exceptions.
        """
        mime, _ = mimetypes.guess_type(image_path)
        if not mime:
            mime = "application/octet-stream"

        with open(image_path, "rb") as fh:
            image_bytes = fh.read()

        # Z.AI vision models accept images as base64-encoded data URLs.
        b64 = base64.b64encode(image_bytes).decode("utf-8")
        data_url = f"data:{mime};base64,{b64}"

        attempts = self.max_retries + 1
        last_exc: Exception | None = None

        for attempt in range(1, attempts + 1):
            try:
                response = self.client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "image_url",
                                    "image_url": {"url": data_url},
                                },
                                {
                                    "type": "text",
                                    "text": ZAI_PROMPT,
                                },
                            ],
                        }
                    ],
                    response_format={"type": "json_object"},
                )

                if not response.choices:
                    raise ReceiptExtractionError(
                        "Z.AI returned an empty response (no choices). "
                        "The request may have been filtered or rate-limited."
                    )
                raw_content = response.choices[0].message.content or ""
                try:
                    payload = json.loads(raw_content)
                except json.JSONDecodeError as exc:
                    raise ReceiptExtractionError(
                        "Z.AI returned non-JSON output. Check model response."
                    ) from exc

                try:
                    return ReceiptData(**payload)
                except (ValidationError, TypeError) as exc:
                    raise ReceiptExtractionError(
                        f"Z.AI response did not match the expected schema: {exc}"
                    ) from exc

            except ReceiptExtractionError:
                # Schema / parse errors — retry won't help if it's structural,
                # but occasionally a transient model glitch causes bad output.
                raise
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                logger.warning(
                    "Z.AI API error on attempt %s/%s: %s", attempt, attempts, exc
                )
                if attempt >= attempts:
                    raise ReceiptExtractionError(
                        f"Z.AI OCR service error after {attempts} attempt(s). "
                        "Check ZAI_API_KEY and network."
                    ) from exc

            time.sleep(self.retry_backoff_seconds * attempt)

        raise ReceiptExtractionError(
            f"Z.AI OCR failed unexpectedly after retries. Last error: {last_exc}"
        )
