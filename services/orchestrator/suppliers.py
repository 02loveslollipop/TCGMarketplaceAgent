"""Apify adapters for publicly accessible, logged-out marketplace listings.

Retrieval is read-only and goes through Apify. No login, paywall, CAPTCHA or
other technical block is bypassed.
"""
from datetime import datetime
from decimal import Decimal, InvalidOperation
from urllib.parse import urlparse
import httpx
from pydantic import ValidationError

from shared.contracts import CardRequest, Offer, Source, utcnow

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


def tcgplayer_listings_input(card: CardRequest) -> dict:
    conditions = {"NM":"Near Mint", "LP":"Lightly Played"}
    return {"searchKeywords":[f"{card.name} {card.set_name} {card.number}"], "productLine":"pokemon",
            "condition":conditions.get(card.condition, card.condition), "language":card.language,
            "printing":card.printing, "sort":"price_asc", "maxItems":50, "maxPages":2,
            "listingsPerProduct":10, "includeSalesHistory":False, "monitorMode":False,
            "proxyConfiguration":{"useApifyProxy":False}}


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

    async def quote(self, supplier: str, card: CardRequest) -> list[Offer]:
        if not self.api_key:
            raise SupplierError("Apify runtime credential is unavailable.")
        payload = tcgplayer_listings_input(card) if supplier == "TCGplayer" else cardmarket_input(card)
        actor = TCGPLAYER_LISTINGS_ACTOR if supplier == "TCGplayer" else CARDMARKET_ACTOR
        try:
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
            return tcgplayer_listings_offers(data) if supplier == "TCGplayer" else cardmarket_offers(data, card)
        except httpx.HTTPStatusError as error:
            raise SupplierError(f"Apify retrieval failed (HTTP {error.response.status_code}); no verified quotation was returned.") from None
        except (httpx.RequestError, ValidationError, KeyError, TypeError, InvalidOperation):
            raise SupplierError("Apify retrieval failed or returned incomplete data; no verified quotation was returned.") from None
