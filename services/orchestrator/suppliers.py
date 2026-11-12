"""Apify adapters for publicly accessible, logged-out marketplace listings.

Retrieval is read-only and goes through Apify. No login, paywall, CAPTCHA or
other technical block is bypassed.
"""
import os
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal, InvalidOperation
from urllib.parse import quote, urlparse
import httpx
from pydantic import ValidationError

from shared.contracts import CardRequest, Offer, Source, utcnow
from services.orchestrator.budget import card_number, normalized

TCGPLAYER_ACTOR = "devcake~tcgplayer-data-scraper"
TCGPLAYER_LISTINGS_ACTOR = "crawloop~tcgplayer-listings-scraper"
CARDMARKET_ACTOR = "phantom_coder~cardmarket-listings-scraper"


class SupplierError(Exception):
    def __init__(self, message, *, outcome="unavailable", layer="apify", http_status=None):
        super().__init__(message)
        self.outcome, self.layer, self.http_status = outcome, layer, http_status


def http_outcome(status):
    return {401: "unauthorized", 402: "billing_required", 403: "blocked", 404: "not_found", 429: "rate_limited"}.get(status, "http_error")


@dataclass
class SupplierQuery:
    offers: list[Offer] = field(default_factory=list)
    outcome: str = "empty"
    layer: str = "tcgdex"
    message: str = "No price data returned; availability is unverified."
    http_status: int | None = None

    def diagnostic(self, supplier, card, phase):
        return {"supplier": supplier, "card_id": card.card_id, "phase": phase,
                "layer": self.layer, "outcome": self.outcome, "message": self.message,
                "http_status": self.http_status, "retrieved_at": utcnow().isoformat()}



def tcgplayer_input(card: CardRequest) -> dict:
    return {"queries":[f"{card.name} {card.set_name} {card.number}"], "sortOption":"Price: Low to High",
            "startPage":1, "pageCount":1, "enrichData":False}


def cardmarket_input(card: CardRequest) -> dict:
    url = str(card.cardmarket_url or "")
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in {"www.cardmarket.com", "cardmarket.com"} or "/Pokemon/Products/Singles/" not in parsed.path:
        raise SupplierError("Cardmarket needs a researched, exact Pokémon product URL; no slug is guessed.")
    return {"productUrl":url, "language":card.language, "minCondition":card.condition,
            "maxResults":50, "enableFairValue":False, "sellerCountry":"any"}


def decimal(value):
    return None if value is None else Decimal(str(value))


def tcgdex_set_id(card_id: str, local_id) -> str:
    """Return the set portion of a TCGdex id, tolerating hyphens in set ids.

    TCGdex ids are ``<set-id>-<local-id>`` and some set ids themselves contain
    hyphens (for example ``tk-bw-e-2`` belongs to set ``tk-bw-e``). Splitting on
    the first hyphen would collapse every ``tk-*`` set to ``tk``.
    """
    local = str(local_id or "")
    suffix = f"-{local}"
    if local and card_id.endswith(suffix):
        return card_id[: -len(suffix)]
    return card_id.rsplit("-", 1)[0]


def tcgplayer_offers(rows: list[dict]) -> list[Offer]:
    offers = []
    for row in rows:
        source = Source(url=row["url"], title=row["productName"], retrieved_at=utcnow())
        for listing in row.get("listings", []):
            quantity = listing.get("quantity")
            offers.append(Offer(
                id=f"tcgplayer:{listing['listingId']}", name=row["productName"], supplier="TCGplayer",
                set_name=row.get("setName"), number=str(row["number"]) if row.get("number") else None,
                condition=listing.get("condition"), language=listing.get("language"), printing=listing.get("printing"),
                image_url=row.get("imageUrl"), price=decimal(listing["price"]), currency="USD", quantity=quantity,
                availability="unknown" if quantity is None else "in_stock" if quantity > 0 else "out_of_stock",
                price_kind="listing", shipping=decimal(listing.get("shippingPrice")), seller=listing.get("sellerName"), source=source))
        if not row.get("listings") and row.get("marketPrice"):
            offers.append(Offer(id=f"tcgplayer:reference:{row['productId']}", name=row["productName"],
                                supplier="TCGplayer", set_name=row.get("setName"), price=decimal(row["marketPrice"]),
                                currency="USD", price_kind="reference", source=source))
    return offers


def cardmarket_offers(rows: list[dict], binding: CardRequest | None = None) -> list[Offer]:
    offers = []
    for index, row in enumerate(rows):
        quantity = row.get("quantity")
        identity = binding.cardmarket_identity_source if binding and binding.cardmarket_identity_source and str(binding.cardmarket_url) == row["productUrl"] and row["cardName"].casefold() == binding.name.casefold() and row.get("setName", "").casefold() == binding.set_name.casefold() else None
        offers.append(Offer(
            id=f"cardmarket:{row['sellerName']}:{row['productUrl']}:{index}", name=row["cardName"], supplier="Cardmarket",
            set_name=row.get("setName"), number=binding.number if identity else None,
            condition=row.get("condition"), language=row.get("language"), identity_source=identity,
            # The Actor output does not supply a number, finish or shipping. Keep them unknown.
            price=decimal(row["price"]), currency=row["currency"], quantity=quantity,
            availability="unknown" if quantity is None else "in_stock" if quantity > 0 else "out_of_stock",
            price_kind="listing", seller=row.get("sellerName"),
            source=Source(url=row["productUrl"], title=row["cardName"], retrieved_at=utcnow())))
    return offers


def tcgplayer_listings_input(card: CardRequest, product_id: int | str | None = None) -> dict:
    conditions = {"NM":"Near Mint", "LP":"Lightly Played"}
    payload = {"searchKeywords":[f"{card.name} {card.set_name} {card.number}".strip()], "productLine":"pokemon",
               "condition":conditions.get(card.condition, card.condition), "language":card.language,
               "printing":card.printing, "sort":"price_asc", "maxItems":50, "maxPages":2,
               "listingsPerProduct":10, "includeSalesHistory":False, "monitorMode":False,
               "proxyConfiguration":{"useApifyProxy":False}, "maxListings":10}
    if product_id:
        payload["startUrls"] = [{"url": f"https://www.tcgplayer.com/product/{product_id}"}]
    return payload


def tcgplayer_listings_offers(rows: list[dict]) -> list[Offer]:
    return [Offer(id=f"tcgplayer:{row['listingId']}", name=row["productName"], supplier="TCGplayer",
                  set_name=row.get("setName"), number=row.get("cardNumber"), condition=row.get("condition"),
                  language=row.get("language"), printing=row.get("printing"), image_url=row.get("imageUrl"),
                  price=decimal(row["price"]), currency=row["currency"], quantity=row.get("quantity"),
                  availability="unknown" if row.get("quantity") is None else "in_stock" if row["quantity"] > 0 else "out_of_stock",
                  price_kind="listing", shipping=decimal(row.get("shippingPrice")), seller=row.get("sellerName"),
                  source=Source(url=row["url"], title=row["productName"])) for row in rows]


class Suppliers:
    def __init__(self, api_key: str = "", client=None):
        self.api_key = api_key
        self.client = client
        self._tcgdex_cache: dict[str, dict] = {}
        self.errors: list[dict] = []

    async def _fetch_tcgdex(self, card_id: str, lang: str = "en") -> dict | None:
        key = f"{lang}:{card_id}"
        if key in self._tcgdex_cache:
            return self._tcgdex_cache[key]
        url = f"https://api.tcgdex.net/v2/{lang}/cards/{card_id}"
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(url)
                if resp.status_code == 404:
                    return None
                resp.raise_for_status()
                data = resp.json()
                if not isinstance(data, dict):
                    raise SupplierError("TCGdex returned an invalid card response.", layer="tcgdex", outcome="invalid_response")
                self._tcgdex_cache[key] = data
                return data
        except httpx.HTTPStatusError as error:
            raise SupplierError("TCGdex request failed.", layer="tcgdex", outcome=http_outcome(error.response.status_code), http_status=error.response.status_code) from error
        except httpx.TimeoutException as error:
            raise SupplierError("TCGdex request timed out.", layer="tcgdex", outcome="timeout") from error
        except httpx.RequestError as error:
            raise SupplierError("TCGdex connection failed.", layer="tcgdex", outcome="network_error") from error
        except ValueError as error:
            raise SupplierError("TCGdex returned invalid JSON.", layer="tcgdex", outcome="invalid_response") from error

    async def _fetch_tcgdex_by_name(self, name: str, lang: str = "en") -> list[dict]:
        key = f"name:{lang}:{name.strip().casefold()}"
        if key in self._tcgdex_cache:
            return self._tcgdex_cache[key]
        url = f"https://api.tcgdex.net/v2/{lang}/cards?name={quote(name)}"
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(url)
                if resp.status_code == 404:
                    return []
                resp.raise_for_status()
                data = resp.json()
                if not isinstance(data, list):
                    raise ValueError("Invalid catalog search")
                self._tcgdex_cache[key] = data
                return data
        except httpx.HTTPStatusError as error:
            raise SupplierError("TCGdex search failed.", layer="tcgdex", outcome=http_outcome(error.response.status_code), http_status=error.response.status_code) from error
        except httpx.TimeoutException as error:
            raise SupplierError("TCGdex search timed out.", layer="tcgdex", outcome="timeout") from error
        except httpx.RequestError as error:
            raise SupplierError("TCGdex search connection failed.", layer="tcgdex", outcome="network_error") from error
        except ValueError as error:
            raise SupplierError("TCGdex returned an invalid search response.", layer="tcgdex", outcome="invalid_response") from error

    def _offers_from_tcgdex_pricing(
        self,
        card_id: str,
        pricing: dict,
        supplier: str,
        card: CardRequest,
        id_source: Source,
    ) -> list[Offer]:
        offers: list[Offer] = []
        # Price guides report aggregates, not seller stock or variant guarantees.
        # Keep them visible as references and out of confirmed purchase budgets.

        if supplier == "TCGplayer":
            tcg = pricing.get("tcgplayer")
            if isinstance(tcg, dict):
                currency = tcg.get("unit") or "USD"
                updated_str = tcg.get("updated")
                try:
                    retrieved_at = datetime.fromisoformat(updated_str.replace("Z", "+00:00")) if updated_str else utcnow()
                except Exception:
                    retrieved_at = utcnow()
                for finish_key, finish_data in tcg.items():
                    if not isinstance(finish_data, dict):
                        continue
                    product_id = finish_data.get("productId")
                    low_price = finish_data.get("lowPrice")
                    direct_low_price = finish_data.get("directLowPrice")
                    market_price = finish_data.get("marketPrice")
                    mid_price = finish_data.get("midPrice")

                    printing = {"normal": "Normal", "non-holofoil": "Normal", "holofoil": "Holofoil",
                                "reverse": "Reverse Holofoil", "reverse-holofoil": "Reverse Holofoil"}.get(finish_key.lower())
                    product_url = f"https://www.tcgplayer.com/product/{product_id}" if product_id else f"https://api.tcgdex.net/v2/en/cards/{card_id}"
                    source = Source(url=product_url, title=f"{card.name} ({card.set_name} #{card.number}) — TCGplayer via TCGdex", retrieved_at=retrieved_at)

                    chosen_prices = []
                    best_low = direct_low_price if (direct_low_price is not None and direct_low_price > 0) else low_price
                    if best_low is not None and best_low > 0:
                        chosen_prices.append((f"tcgplayer:{card_id}:{finish_key}:low", decimal(best_low), "TCGplayer Low Reference"))
                    if market_price is not None and market_price > 0:
                        if not best_low or abs(float(market_price) - float(best_low)) > 0.001:
                            chosen_prices.append((f"tcgplayer:{card_id}:{finish_key}:market", decimal(market_price), "TCGplayer Market Reference"))
                    elif not chosen_prices and mid_price is not None and mid_price > 0:
                        chosen_prices.append((f"tcgplayer:{card_id}:{finish_key}:mid", decimal(mid_price), "TCGplayer Mid Reference"))

                    for offer_id, price_val, seller_label in chosen_prices:
                        offers.append(Offer(
                            id=offer_id,
                            name=card.name,
                            supplier="TCGplayer",
                            set_name=card.set_name,
                            number=card.number,
                            condition=None,
                            language=None,
                            printing=printing,
                            price=price_val,
                            currency=currency,
                            quantity=None,
                            availability="unknown",
                            price_kind="reference",
                            shipping=None,
                            shipping_confirmed=False,
                            seller=None,
                            source=source,
                            identity_source=id_source,
                        ))

        elif supplier == "Cardmarket":
            cm = pricing.get("cardmarket")
            if isinstance(cm, dict):
                currency = cm.get("unit") or "EUR"
                id_product = cm.get("idProduct")
                updated_str = cm.get("updated")
                try:
                    retrieved_at = datetime.fromisoformat(updated_str.replace("Z", "+00:00")) if updated_str else utcnow()
                except Exception:
                    retrieved_at = utcnow()
                product_url = f"https://www.cardmarket.com/en/Pokemon/Products/Singles?idProduct={id_product}" if id_product else str(card.cardmarket_url or f"https://api.tcgdex.net/v2/en/cards/{card_id}")
                source = Source(url=product_url, title=f"{card.name} ({card.set_name} #{card.number}) — Cardmarket via TCGdex", retrieved_at=retrieved_at)

                normal_trend = cm.get("trend") or cm.get("avg")
                normal_low = cm.get("low") or normal_trend
                if normal_low is not None and normal_low > 0:
                    offers.append(Offer(
                        id=f"cardmarket:{card_id}:normal",
                        name=card.name,
                        supplier="Cardmarket",
                        set_name=card.set_name,
                        number=card.number,
                        condition=None,
                        language=None,
                        printing=None,
                        price=decimal(normal_low),
                        currency=currency,
                        quantity=None,
                        availability="unknown",
                        price_kind="reference",
                        shipping=None,
                        shipping_confirmed=False,
                        seller=None,
                        source=source,
                        identity_source=id_source,
                    ))

                if normal_trend is not None and normal_trend > 0 and offers:
                    offers.append(offers[-1].model_copy(update={"id": f"cardmarket:{card_id}:normal:market", "price": decimal(normal_trend)}))

                holo_trend = cm.get("trend-holo") or cm.get("avg-holo")
                holo_low = cm.get("low-holo") or holo_trend
                if holo_low is not None and holo_low > 0:
                    offers.append(Offer(
                        id=f"cardmarket:{card_id}:holo",
                        name=card.name,
                        supplier="Cardmarket",
                        set_name=card.set_name,
                        number=card.number,
                        condition=None,
                        language=None,
                        printing="Holofoil",
                        price=decimal(holo_low),
                        currency=currency,
                        quantity=None,
                        availability="unknown",
                        price_kind="reference",
                        shipping=None,
                        shipping_confirmed=False,
                        seller=None,
                        source=source,
                        identity_source=id_source,
                    ))

                if holo_trend is not None and holo_trend > 0 and offers:
                    offers.append(offers[-1].model_copy(update={"id": f"cardmarket:{card_id}:holo:market", "price": decimal(holo_trend)}))

        return offers

    async def _quote_from_tcgdex(self, card: CardRequest, supplier: str) -> list[Offer]:
        if not card.card_id:
            return []
        lang = "ja" if (card.language or "").lower() in {"japanese", "ja"} else "en"
        data = await self._fetch_tcgdex(card.card_id, lang)
        pricing = (data or {}).get("pricing") if isinstance(data, dict) else None
        if not pricing and lang != "en":
            data = await self._fetch_tcgdex(card.card_id, "en")
            pricing = (data or {}).get("pricing") if isinstance(data, dict) else None

        id_source = Source(url=f"https://api.tcgdex.net/v2/en/cards/{card.card_id}", title=f"{card.name} #{card.number}")
        offers: list[Offer] = []
        if isinstance(pricing, dict):
            offers = self._offers_from_tcgdex_pricing(card.card_id, pricing, supplier, card, id_source)

        if not offers:
            candidates = await self._fetch_tcgdex_by_name(card.name, lang)
            candidate_ids = []
            for item in candidates:
                cand_id = item.get("id")
                if not cand_id or cand_id == card.card_id:
                    continue
                if normalized(item.get("name")) != normalized(card.name):
                    continue
                if card.basic_energy is True:
                    candidate_ids.append(cand_id)
                else:
                    if card.card_id:
                        card_set_id = tcgdex_set_id(card.card_id, card.number)
                        cand_set_id = tcgdex_set_id(cand_id, item.get("localId"))
                        cand_local = card_number(item.get("localId"))
                        req_num = card_number(card.number)
                        if cand_set_id == card_set_id and cand_local and req_num and cand_local == req_num:
                            candidate_ids.append(cand_id)

            for cand_id in candidate_ids[:6]:
                cand_data = await self._fetch_tcgdex(cand_id, lang)
                cand_pricing = (cand_data or {}).get("pricing") if isinstance(cand_data, dict) else None
                if not cand_pricing and lang != "en":
                    cand_data = await self._fetch_tcgdex(cand_id, "en")
                    cand_pricing = (cand_data or {}).get("pricing") if isinstance(cand_data, dict) else None
                if isinstance(cand_pricing, dict):
                    cand_id_source = Source(url=f"https://api.tcgdex.net/v2/en/cards/{cand_id}", title=f"{card.name} #{card.number}")
                    priced_card = card.model_copy(update={
                        "name": cand_data.get("name") or card.name,
                        "set_name": (cand_data.get("set") or {}).get("name") or tcgdex_set_id(cand_id, cand_data.get("localId")),
                        "number": str(cand_data.get("localId") or cand_id.rsplit("-", 1)[-1]),
                    })
                    cand_offers = self._offers_from_tcgdex_pricing(cand_id, cand_pricing, supplier, priced_card, cand_id_source)
                    if cand_offers:
                        if cand_id != card.card_id:
                            for off in cand_offers:
                                if off.source:
                                    off.source = Source(
                                        url=off.source.url,
                                        title=f"{card.name} (priced from printing {cand_id}) — {supplier} via TCGdex",
                                        retrieved_at=off.source.retrieved_at,
                                    )
                        offers.extend(cand_offers)
                        break

        return offers

    async def baseline(self, supplier: str, card: CardRequest) -> SupplierQuery:
        """Price guides only: never infer inventory or a purchasable listing."""
        try:
            offers = await self._quote_from_tcgdex(card, supplier)
            return SupplierQuery(offers, "success" if offers else "empty", "tcgdex",
                                 "Retrieved baseline prices; stock is unverified." if offers else "No baseline price returned; this does not mean out of stock.")
        except SupplierError as error:
            return SupplierQuery(outcome=error.outcome, layer=error.layer, message=str(error), http_status=error.http_status)
        except (ValueError, TypeError, KeyError, InvalidOperation):
            return SupplierQuery(outcome="invalid_response", message="Baseline source returned incomplete price data.")

    async def listings(self, supplier: str, card: CardRequest) -> SupplierQuery:
        """Separate live listing check. Empty/blocked/disabled are not stock evidence."""
        enabled = self.client or os.getenv("APIFY_LIVE_SCRAPE", "false").lower() in {"1", "true", "yes"}
        if not enabled:
            return SupplierQuery(outcome="disabled", layer="apify", message="Live listing retrieval is disabled by configuration; availability is unverified.")
        if not self.api_key:
            return SupplierQuery(outcome="unauthorized", layer="apify", message="Apify runtime credential is unavailable; availability is unverified.")
        try:
            payload = tcgplayer_listings_input(card) if supplier == "TCGplayer" else cardmarket_input(card)
            actor = TCGPLAYER_LISTINGS_ACTOR if supplier == "TCGplayer" else CARDMARKET_ACTOR
            args = dict(json=payload, headers={"Authorization": f"Bearer {self.api_key}"}, params={"timeout":90, "memory":256})
            if self.client:
                response = await self.client.post(f"https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items", **args)
            else:
                async with httpx.AsyncClient(timeout=100) as client:
                    response = await client.post(f"https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items", **args)
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, list):
                raise ValueError("Invalid dataset shape")
            offers = tcgplayer_listings_offers(data) if supplier == "TCGplayer" else cardmarket_offers(data, card)
            return SupplierQuery(offers, "success" if offers else "empty", "apify",
                                 "Retrieved seller listings; compare exact variants and quantities." if offers else "The listing search returned no rows; stock is unverified.")
        except httpx.HTTPStatusError as error:
            code = error.response.status_code
            return SupplierQuery(outcome=http_outcome(code), layer="apify", http_status=code,
                                 message=f"Apify retrieval failed (HTTP {code}); availability is unverified.")
        except httpx.TimeoutException:
            return SupplierQuery(outcome="timeout", layer="apify", message="Apify retrieval timed out; availability is unverified.")
        except httpx.RequestError:
            return SupplierQuery(outcome="network_error", layer="apify", message="Apify connection failed; availability is unverified.")
        except SupplierError as error:
            return SupplierQuery(outcome="input_missing", layer="apify", message=str(error))
        except (ValidationError, ValueError, KeyError, TypeError, InvalidOperation):
            return SupplierQuery(outcome="invalid_response", layer="apify", message="Apify returned incomplete listing data; availability is unverified.")

    async def quote(self, supplier: str, card: CardRequest) -> list[Offer]:
        """Compatibility adapter for older callers. The graph uses the two phases."""
        live = await self.listings(supplier, card)
        if live.offers:
            return live.offers
        baseline = await self.baseline(supplier, card)
        if baseline.offers:
            return baseline.offers
        if live.outcome != "disabled":
            raise SupplierError(live.message, outcome=live.outcome, layer=live.layer, http_status=live.http_status)
        if not self.api_key:
            raise SupplierError("Apify runtime credential is unavailable.")
        raise SupplierError(f"No verified {supplier} offers found for {card.name}." if baseline.outcome == "empty" else baseline.message,
                            outcome=baseline.outcome, layer=baseline.layer, http_status=baseline.http_status)
