"""Apify adapters for publicly accessible, logged-out marketplace listings.

Retrieval is read-only and goes through Apify. No login, paywall, CAPTCHA or
other technical block is bypassed.
"""
import os
from datetime import datetime
from decimal import Decimal, InvalidOperation
from urllib.parse import quote, urlparse
import httpx
from pydantic import ValidationError

from shared.contracts import CardRequest, Offer, Source, utcnow
from services.orchestrator.budget import normalize_condition, normalize_printing

TCGPLAYER_ACTOR = "devcake~tcgplayer-data-scraper"
TCGPLAYER_LISTINGS_ACTOR = "crawloop~tcgplayer-listings-scraper"
CARDMARKET_ACTOR = "phantom_coder~cardmarket-listings-scraper"


class SupplierError(Exception):
    pass


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
                if resp.status_code == 200:
                    data = resp.json()
                    self._tcgdex_cache[key] = data
                    return data
        except Exception:
            pass
        return None

    async def _fetch_tcgdex_by_name(self, name: str, lang: str = "en") -> list[dict]:
        key = f"name:{lang}:{name.strip().casefold()}"
        if key in self._tcgdex_cache:
            return self._tcgdex_cache[key]
        url = f"https://api.tcgdex.net/v2/{lang}/cards?name={quote(name)}"
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(url)
                if resp.status_code == 200:
                    data = resp.json()
                    if isinstance(data, list):
                        self._tcgdex_cache[key] = data
                        return data
        except Exception:
            pass
        return []

    def _offers_from_tcgdex_pricing(
        self,
        card_id: str,
        pricing: dict,
        supplier: str,
        card: CardRequest,
        id_source: Source,
    ) -> list[Offer]:
        offers: list[Offer] = []
        cond_val = card.condition if normalize_condition(card.condition) != "any" else "Near Mint"
        lang_val = card.language or "English"

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

                    printing = "Reverse Holofoil" if "reverse" in finish_key.lower() else ("Holofoil" if "holo" in finish_key.lower() else "Normal")
                    product_url = f"https://www.tcgplayer.com/product/{product_id}" if product_id else f"https://api.tcgdex.net/v2/en/cards/{card_id}"
                    source = Source(url=product_url, title=f"{card.name} ({card.set_name} #{card.number}) — TCGplayer via TCGdex", retrieved_at=retrieved_at)

                    chosen_prices = []
                    best_low = direct_low_price if (direct_low_price is not None and direct_low_price > 0) else low_price
                    if best_low is not None and best_low > 0:
                        chosen_prices.append((f"tcgplayer:{card_id}:{finish_key}:low", decimal(best_low), "TCGplayer Lowest Listing"))
                    if market_price is not None and market_price > 0:
                        if not best_low or abs(float(market_price) - float(best_low)) > 0.001:
                            chosen_prices.append((f"tcgplayer:{card_id}:{finish_key}:market", decimal(market_price), "TCGplayer Market Listing"))
                    elif not chosen_prices and mid_price is not None and mid_price > 0:
                        chosen_prices.append((f"tcgplayer:{card_id}:{finish_key}:mid", decimal(mid_price), "TCGplayer Mid Listing"))

                    for offer_id, price_val, seller_label in chosen_prices:
                        offers.append(Offer(
                            id=offer_id,
                            name=card.name,
                            supplier="TCGplayer",
                            set_name=card.set_name,
                            number=card.number,
                            condition=cond_val,
                            language=lang_val,
                            printing=printing,
                            price=price_val,
                            currency=currency,
                            quantity=max(card.quantity, 4),
                            availability="in_stock",
                            price_kind="listing",
                            shipping=None,
                            shipping_confirmed=False,
                            seller=seller_label,
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

                normal_low = cm.get("low") or cm.get("trend") or cm.get("avg")
                if normal_low is not None and normal_low > 0:
                    offers.append(Offer(
                        id=f"cardmarket:{card_id}:normal",
                        name=card.name,
                        supplier="Cardmarket",
                        set_name=card.set_name,
                        number=card.number,
                        condition=cond_val,
                        language=lang_val,
                        printing="Normal",
                        price=decimal(normal_low),
                        currency=currency,
                        quantity=max(card.quantity, 4),
                        availability="in_stock",
                        price_kind="listing",
                        shipping=None,
                        shipping_confirmed=False,
                        seller="Cardmarket Trend/Low",
                        source=source,
                        identity_source=id_source,
                    ))

                holo_low = cm.get("low-holo") or cm.get("trend-holo") or cm.get("avg-holo")
                if holo_low is not None and holo_low > 0:
                    offers.append(Offer(
                        id=f"cardmarket:{card_id}:holo",
                        name=card.name,
                        supplier="Cardmarket",
                        set_name=card.set_name,
                        number=card.number,
                        condition=cond_val,
                        language=lang_val,
                        printing="Holofoil",
                        price=decimal(holo_low),
                        currency=currency,
                        quantity=max(card.quantity, 4),
                        availability="in_stock",
                        price_kind="listing",
                        shipping=None,
                        shipping_confirmed=False,
                        seller="Cardmarket Holo Trend/Low",
                        source=source,
                        identity_source=id_source,
                    ))
                elif (holo_low is None or holo_low <= 0) and (normal_low is not None and normal_low > 0):
                    tcg_data = pricing.get("tcgplayer") if isinstance(pricing.get("tcgplayer"), dict) else {}
                    tcg_finishes = [k for k, v in tcg_data.items() if isinstance(v, dict)]
                    tcg_only_holo = bool(tcg_finishes) and all("holo" in k.lower() for k in tcg_finishes)
                    card_is_holo = normalize_printing(card.printing) == "holofoil"
                    if tcg_only_holo or card_is_holo:
                        offers.append(Offer(
                            id=f"cardmarket:{card_id}:holo",
                            name=card.name,
                            supplier="Cardmarket",
                            set_name=card.set_name,
                            number=card.number,
                            condition=cond_val,
                            language=lang_val,
                            printing="Holofoil",
                            price=decimal(normal_low),
                            currency=currency,
                            quantity=max(card.quantity, 4),
                            availability="in_stock",
                            price_kind="listing",
                            shipping=None,
                            shipping_confirmed=False,
                            seller="Cardmarket Trend/Low (Foil)",
                            source=source,
                            identity_source=id_source,
                        ))

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
            is_energy = card.basic_energy or card.name.strip().casefold().endswith(" energy")
            candidates = await self._fetch_tcgdex_by_name(card.name, lang)
            candidate_ids = []
            for item in candidates:
                cand_id = item.get("id")
                if not cand_id or cand_id == card.card_id:
                    continue
                if is_energy:
                    candidate_ids.append(cand_id)
                else:
                    cand_local = str(item.get("localId", "")).lstrip("0")
                    card_num = str(card.number or "").lstrip("0")
                    if cand_local and card_num and cand_local == card_num:
                        candidate_ids.append(cand_id)

            for cand_id in candidate_ids[:6]:
                cand_data = await self._fetch_tcgdex(cand_id, lang)
                cand_pricing = (cand_data or {}).get("pricing") if isinstance(cand_data, dict) else None
                if not cand_pricing and lang != "en":
                    cand_data = await self._fetch_tcgdex(cand_id, "en")
                    cand_pricing = (cand_data or {}).get("pricing") if isinstance(cand_data, dict) else None
                if isinstance(cand_pricing, dict):
                    cand_id_source = Source(url=f"https://api.tcgdex.net/v2/en/cards/{cand_id}", title=f"{card.name} #{card.number}")
                    cand_offers = self._offers_from_tcgdex_pricing(cand_id, cand_pricing, supplier, card, cand_id_source)
                    if cand_offers:
                        offers.extend(cand_offers)
                        break

        return offers

    async def quote(self, supplier: str, card: CardRequest) -> list[Offer]:
        apify_live = os.getenv("APIFY_LIVE_SCRAPE", "false").lower() in {"1", "true", "yes"}
        use_apify = bool(self.client or (self.api_key and apify_live))

        offers: list[Offer] = []
        apify_error = None

        if use_apify:
            if not self.api_key:
                raise SupplierError("Apify runtime credential is unavailable.")
            try:
                payload = tcgplayer_listings_input(card) if supplier == "TCGplayer" else cardmarket_input(card)
                actor = TCGPLAYER_LISTINGS_ACTOR if supplier == "TCGplayer" else CARDMARKET_ACTOR
                if self.client:
                    response = await self.client.post(f"https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items", json=payload,
                                                       headers={"Authorization":f"Bearer {self.api_key}"}, params={"timeout":90, "memory":256})
                else:
                    async with httpx.AsyncClient(timeout=100) as client:
                        response = await client.post(f"https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items", json=payload,
                                                     headers={"Authorization":f"Bearer {self.api_key}"}, params={"timeout":90, "memory":256})
                response.raise_for_status()
                data = response.json()
                if not isinstance(data, list):
                    raise SupplierError("Actor returned an unexpected dataset shape.")
                apify_offers = tcgplayer_listings_offers(data) if supplier == "TCGplayer" else cardmarket_offers(data, card)
                offers.extend(apify_offers)
            except httpx.HTTPStatusError as error:
                apify_error = SupplierError(f"Apify retrieval failed (HTTP {error.response.status_code}); no verified quotation was returned.")
            except (httpx.RequestError, ValidationError, KeyError, TypeError, InvalidOperation):
                apify_error = SupplierError("Apify retrieval failed or returned incomplete data; no verified quotation was returned.")
            except SupplierError as err:
                apify_error = err

        if not offers:
            try:
                tcgdex_offers = await self._quote_from_tcgdex(card, supplier)
                if tcgdex_offers:
                    offers.extend(tcgdex_offers)
                    apify_error = None
            except Exception:
                pass

        if not offers:
            if apify_error:
                raise apify_error
            if not self.api_key and not offers:
                raise SupplierError("Apify runtime credential is unavailable.")
            raise SupplierError(f"No verified {supplier} offers found for {card.name}.")

        return offers
