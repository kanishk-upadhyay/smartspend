import json
import logging
import urllib.error
import urllib.request
from datetime import datetime, timedelta

from gemini_extractor import GeminiExtractor, ReceiptExtractionError

logger = logging.getLogger(__name__)

DEFAULT_CURRENCY = "INR"
MIXED_CURRENCY = "MIXED"
_FX_CACHE_MAX = 512


def _try_build_zai_extractor():
    """Import and construct ZaiExtractor only if zai-sdk is installed and
    ZAI_API_KEY is set — returns None silently otherwise so the app still
    starts with Gemini-only mode."""
    try:
        from zai_extractor import ZaiExtractor  # noqa: PLC0415
        return ZaiExtractor()
    except RuntimeError as exc:
        logger.info("Z.AI fallback not configured: %s", exc)
        return None
    except Exception as exc:  # noqa: BLE001
        logger.warning("Z.AI fallback unavailable: %s", exc)
        return None


class OCRProcessor:
    def __init__(self):
        # ── Primary: Gemini (best schema accuracy + PDF support) ──────────
        self._primary: GeminiExtractor | None = None
        try:
            self._primary = GeminiExtractor()
            logger.info("OCR primary: Gemini model=%s", self._primary.model)
        except RuntimeError as exc:
            logger.warning("Gemini primary not configured: %s", exc)

        # ── Fallback: Z.AI GLM-4.6V-Flash (free tier) ────────────────────
        self._fallback = _try_build_zai_extractor()
        if self._fallback:
            logger.info("OCR fallback: Z.AI model=%s", self._fallback.model)

        if not self._primary and not self._fallback:
            raise RuntimeError(
                "No OCR backend configured. "
                "Set GEMINI_API_KEY (primary) and/or ZAI_API_KEY (fallback)."
            )

        # Only successful FX lookups are cached so a transient CDN failure
        # doesn't permanently poison the cache for a (currency, date) pair.
        self._fx_cache: dict[tuple[str, str, str], tuple[float, str]] = {}

    def _extract(self, image_path: str):
        """Try Gemini first; fall back to Z.AI on ReceiptExtractionError."""
        if self._primary:
            try:
                return self._primary.extract(image_path)
            except ReceiptExtractionError as exc:
                if not self._fallback:
                    raise
                logger.warning(
                    "Gemini primary failed (%s) — retrying with Z.AI fallback.", exc
                )
                return self._fallback.extract(image_path)
        return self._fallback.extract(image_path)  # type: ignore[union-attr]

    def get_historical_rate(self, source_currency, target_currency, receipt_date_iso):
        if source_currency == target_currency:
            return 1.0, receipt_date_iso, None

        if not receipt_date_iso:
            return None, None, "Receipt date missing, cannot fetch historical FX rate."

        cache_key = (source_currency, target_currency, receipt_date_iso)
        cached = self._fx_cache.get(cache_key)
        if cached is not None:
            rate, query_date = cached
            return rate, query_date, None

        # Defense in depth: never let an unparseable date crash a caller. A bad
        # value is treated exactly like a missing one.
        try:
            date_obj = datetime.fromisoformat(receipt_date_iso).date()
        except (TypeError, ValueError):
            return None, None, "Receipt date invalid, cannot fetch historical FX rate."
        for offset in range(0, 8):
            query_date = (date_obj - timedelta(days=offset)).isoformat()
            url = (
                "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/"
                f"v1/{query_date}/currencies/{source_currency.lower()}/{target_currency.lower()}.json"
            )
            try:
                request = urllib.request.Request(url, headers={"User-Agent": "SmartSpend/1.0"})
                with urllib.request.urlopen(request, timeout=8) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                rate = payload.get(target_currency.lower())
                if rate is not None:
                    rate_value = float(rate)
                    if len(self._fx_cache) >= _FX_CACHE_MAX:
                        self._fx_cache.pop(next(iter(self._fx_cache)), None)
                    self._fx_cache[cache_key] = (rate_value, query_date)
                    return rate_value, query_date, None
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, json.JSONDecodeError):
                continue

        return None, None, f"Could not fetch historical FX rate for {source_currency} -> {target_currency} on or before {receipt_date_iso}."

    def extract_data(self, image_path, base_currency: str = DEFAULT_CURRENCY):
        receipt = self._extract(image_path)

        target_currency = (base_currency or DEFAULT_CURRENCY).upper()

        receipt_date_iso = receipt.date or None
        if receipt_date_iso:
            try:
                datetime.fromisoformat(receipt_date_iso)
            except ValueError:
                receipt_date_iso = None

        source_currency = (receipt.source_currency or DEFAULT_CURRENCY).upper()
        raw_total = float(receipt.total_amount or 0.0)

        primary_currency = target_currency
        currency_warning = None
        fx_rate_date = None

        raw_items = [
            {
                "name": item.name,
                "amount": float(item.amount),
                "raw_amount": float(item.amount),
                "qty": item.qty,
            }
            for item in receipt.items
        ]

        if source_currency == MIXED_CURRENCY:
            currency_warning = "Multiple currencies detected. Review the receipt before saving."
            total_amount = raw_total
            items = [{**i, "currency": target_currency, "source_currency": MIXED_CURRENCY} for i in raw_items]
        elif source_currency == target_currency:
            total_amount = raw_total
            items = [{**i, "currency": target_currency, "source_currency": target_currency} for i in raw_items]
        else:
            rate, fx_rate_date, warning = self.get_historical_rate(source_currency, target_currency, receipt_date_iso)
            if rate is None:
                currency_warning = warning or f"Could not convert {source_currency} to {target_currency} using the receipt date."
                total_amount = raw_total
                primary_currency = source_currency
                items = [
                    {**i, "currency": source_currency, "source_currency": source_currency}
                    for i in raw_items
                ]
            else:
                total_amount = raw_total * rate
                items = [
                    {
                        **i,
                        "amount": i["raw_amount"] * rate,
                        "currency": target_currency,
                        "source_currency": source_currency,
                        "fx_rate_date": fx_rate_date,
                    }
                    for i in raw_items
                ]

        if not items:
            item_warning = "No item rows detected on this receipt."
        else:
            item_sum = sum(i["raw_amount"] for i in raw_items)
            if (
                item_sum > 0
                and raw_total > 0
                and abs(item_sum - raw_total) / max(raw_total, item_sum) > 0.10
            ):
                item_warning = (
                    f"Line items sum to {item_sum:.2f} but receipt total is "
                    f"{raw_total:.2f} — verify before saving."
                )
            else:
                item_warning = None

        return {
            "vendor": receipt.vendor or "Unknown",
            "total_amount": total_amount,
            "raw_total_amount": raw_total,
            "date": receipt_date_iso or "Unknown",
            "receipt_date": receipt_date_iso,
            "currency": primary_currency,
            "source_currency": source_currency,
            "detected_currencies": list(receipt.detected_currencies or []),
            "currency_warning": currency_warning,
            "fx_rate_date": fx_rate_date,
            "item_warning": item_warning,
            "items": items,
            "category": receipt.category,
        }


ocr_engine = OCRProcessor()
