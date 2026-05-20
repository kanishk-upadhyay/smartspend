import json
import urllib.error
import urllib.request
from datetime import datetime, timedelta

from gemini_extractor import GeminiExtractor

DEFAULT_CURRENCY = "INR"
MIXED_CURRENCY = "MIXED"
_FX_CACHE_MAX = 512


class OCRProcessor:
    def __init__(self):
        self.extractor = GeminiExtractor()
        # Only successful lookups are cached so a transient CDN failure doesn't
        # permanently break FX conversion for that (currency, date) pair.
        self._fx_cache: dict[tuple[str, str, str], tuple[float, str]] = {}

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

        date_obj = datetime.fromisoformat(receipt_date_iso).date()
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

    def extract_data(self, image_path):
        receipt = self.extractor.extract(image_path)

        receipt_date_iso = receipt.date or None
        if receipt_date_iso:
            try:
                datetime.fromisoformat(receipt_date_iso)
            except ValueError:
                receipt_date_iso = None

        source_currency = (receipt.source_currency or DEFAULT_CURRENCY).upper()
        raw_total = float(receipt.total_amount or 0.0)

        primary_currency = DEFAULT_CURRENCY
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
            items = [{**i, "currency": DEFAULT_CURRENCY, "source_currency": MIXED_CURRENCY} for i in raw_items]
        elif source_currency == DEFAULT_CURRENCY:
            total_amount = raw_total
            items = [{**i, "currency": DEFAULT_CURRENCY, "source_currency": DEFAULT_CURRENCY} for i in raw_items]
        else:
            rate, fx_rate_date, warning = self.get_historical_rate(source_currency, DEFAULT_CURRENCY, receipt_date_iso)
            if rate is None:
                currency_warning = warning or f"Could not convert {source_currency} to {DEFAULT_CURRENCY} using the receipt date."
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
                        "currency": DEFAULT_CURRENCY,
                        "source_currency": source_currency,
                        "fx_rate_date": fx_rate_date,
                    }
                    for i in raw_items
                ]

        item_warning = None if items else "No item rows detected on this receipt."

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
