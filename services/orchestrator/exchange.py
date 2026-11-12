"""Dated indicative currency conversion. Supplier amounts remain unchanged."""
import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

import httpx

from shared.contracts import utcnow

RATES_URL = "https://open.er-api.com/v6/latest/USD"
PROVIDER_URL = "https://www.exchangerate-api.com"
ZERO_DECIMAL = {"BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"}
THREE_DECIMAL = {"BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"}


class ExchangeUnavailable(Exception):
    pass


def amount(value, factor, currency, *, unit=False):
    places = 6 if unit else 0 if currency in ZERO_DECIMAL else 3 if currency in THREE_DECIMAL else 2
    rounded = (Decimal(str(value)) * factor).quantize(Decimal(10) ** -places, rounding=ROUND_HALF_UP)
    text = format(rounded, "f")
    return text.rstrip("0").rstrip(".") if unit and "." in text else text


class ExchangeRates:
    def __init__(self, client=None):
        self.client = client
        self._cached = None
        self._lock = asyncio.Lock()

    async def snapshot(self):
        async with self._lock:
            now = utcnow()
            if self._cached and self._cached["expires_at"] > now:
                return self._cached
            try:
                if self.client:
                    response = await self.client.get(RATES_URL)
                else:
                    async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
                        response = await client.get(RATES_URL)
                response.raise_for_status()
                data = response.json(parse_float=Decimal)
                updated = datetime.fromtimestamp(data["time_last_update_unix"], timezone.utc)
                next_update = datetime.fromtimestamp(data["time_next_update_unix"], timezone.utc)
                rates = {code: Decimal(str(value)) for code, value in data["rates"].items()
                         if isinstance(code, str) and len(code) == 3 and code.isalpha() and code.isupper()}
                if (data.get("result") != "success" or data.get("base_code") != "USD"
                        or not now - timedelta(days=2) <= updated <= now + timedelta(minutes=5)
                        or next_update <= updated or rates.get("USD") != 1
                        or any(not value.is_finite() or value <= 0 for value in rates.values())):
                    raise ValueError("Incomplete, stale, or invalid exchange rates.")
                self._cached = {"rates": rates, "as_of": updated.isoformat(), "retrieved_at": now.isoformat(),
                                "expires_at": min(next_update, now + timedelta(hours=24))}
                return self._cached
            except (httpx.HTTPError, KeyError, TypeError, ValueError, InvalidOperation, OverflowError) as error:
                raise ExchangeUnavailable("Currency conversion is unavailable. Original supplier prices are preserved.") from error

    async def currencies(self):
        return sorted((await self.snapshot())["rates"])

    async def convert(self, result, target):
        if not target:
            return result
        converted = deepcopy(result)
        try:
            snapshot = await self.snapshot()
            rates = snapshot["rates"]
            currencies = {entry["currency"] for entry in result.get("budgets", []) + result.get("offers", []) + result.get("reference_estimates", [])}
            if target not in rates or any(code not in rates for code in currencies):
                raise ExchangeUnavailable("The selected currency cannot be converted with the available rates. Original prices are preserved.")
            factors = {code: rates[target] / rates[code] for code in currencies}
            converted["currency_conversion"] = {
                "status": "available", "target_currency": target,
                "rates": {code: str(rate) for code, rate in factors.items()},
                "as_of": snapshot["as_of"], "retrieved_at": snapshot["retrieved_at"],
                "source": {"url": PROVIDER_URL, "title": "Rates By Exchange Rate API"},
                "notice": "Indicative conversion only. Card issuer fees, taxes, and unconfirmed delivery costs are excluded.",
            }
            for offer in converted.get("offers", []):
                offer["converted_price"] = amount(offer["price"], factors[offer["currency"]], target, unit=True)
            for budget in converted.get("budgets", []) + converted.get("reference_estimates", []):
                factor = factors[budget["currency"]]
                budget["converted"] = {field: amount(budget[field], factor, target) if budget.get(field) is not None else None
                                       for field in ("product_subtotal", "known_shipping", "confirmed_total")}
                for line in budget.get("lines", []):
                    for field in ("unit_price", "line_total"):
                        if line.get(field) is not None:
                            line["converted_" + field] = amount(line[field], factor, target, unit=field=="unit_price")
                    for allocation in line.get("allocations", []):
                        for field in ("unit_price", "line_total"):
                            allocation["converted_" + field] = amount(allocation[field], factor, target, unit=field=="unit_price")
            return converted
        except (ExchangeUnavailable, InvalidOperation, OverflowError) as error:
            converted = deepcopy(result)
            message = str(error) if isinstance(error, ExchangeUnavailable) else "Currency conversion could not be calculated. Original supplier prices are preserved."
            converted["currency_conversion"] = {"status": "unavailable", "target_currency": target, "message": message}
            return converted


exchange_rates = ExchangeRates()
