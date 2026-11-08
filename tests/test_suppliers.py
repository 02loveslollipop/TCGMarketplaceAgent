import httpx
import pytest
from shared.contracts import CardRequest
from services.orchestrator.suppliers import Suppliers, SupplierError, cardmarket_input, cardmarket_offers, tcgplayer_input, tcgplayer_offers
from services.orchestrator.suppliers import tcgplayer_listings_input, tcgplayer_listings_offers
from services.orchestrator.budget import budgets
from shared.contracts import Source


def card():
    return CardRequest(card_id="test-1", name="Test ex", quantity=2, set_name="Test set", number="1", condition="NM", language="English", printing="Holofoil", cardmarket_url="https://www.cardmarket.com/en/Pokemon/Products/Singles/Test/Test-ex")


def test_actor_inputs_and_listing_provenance():
    assert tcgplayer_input(card())["queries"] == ["Test ex Test set 1"]
    assert cardmarket_input(card())["enableFairValue"] is False
    rows = [{"productName":"Test ex", "productId":123, "url":"https://www.tcgplayer.com/product/123", "setName":"Test set", "number":None,
             "marketPrice":20, "listings":[{"listingId":1, "price":2.5, "quantity":3, "shippingPrice":None, "language":"English", "condition":"Near Mint", "printing":"Holofoil"}]}]
    offer = tcgplayer_offers(rows)[0]
    assert str(offer.price) == "2.5" and offer.quantity == 3
    assert offer.number is None and offer.shipping is None and offer.source.retrieved_at
    assert offer.price_kind == "listing"
    rows[0]["listings"] = []
    assert tcgplayer_offers(rows)[0].price_kind == "reference"


def test_cardmarket_does_not_invent_fields_or_use_unsourced_conversion():
    row = {"cardName":"Test ex", "sellerName":"Seller", "productUrl":str(card().cardmarket_url), "setName":"Test set", "price":2, "priceUsd":2.2, "eurUsdRate":1.1, "currency":"EUR", "quantity":2, "condition":None, "language":"English"}
    offer = cardmarket_offers([row])[0]
    assert offer.currency == "EUR" and offer.price == 2
    assert offer.number is None and offer.printing is None and offer.condition is None


async def test_supplier_requires_credentials_and_input_fails_honestly():
    with pytest.raises(SupplierError, match="credential"):
        await Suppliers().quote("TCGplayer", card())
    unknown = card().model_copy(update={"cardmarket_url":None})
    with pytest.raises(SupplierError, match="researched"):
        cardmarket_input(unknown)


async def test_apify_errors_do_not_leak_api_key():
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request:httpx.Response(429, request=request))) as client:
        with pytest.raises(SupplierError, match="HTTP 429") as error:
            await Suppliers("private-key", client).quote("Cardmarket", card())
        assert "private-key" not in str(error.value)


def test_actual_flat_actor_payloads_flow_to_budgets_with_evidenced_identity():
    requested = card().model_copy(update={"printing":"any", "cardmarket_identity_source":Source(url=str(card().cardmarket_url), title="Test ex Test set 1", excerpt="Exact printing number 1")})
    raw = {"cardName":"Test ex", "sellerName":"Seller", "productUrl":str(requested.cardmarket_url), "setName":"Test set", "price":2, "currency":"EUR", "quantity":2, "condition":"NM", "language":"English"}
    normalized = cardmarket_offers([raw], requested)
    combined = next(row for row in budgets([requested],normalized)["budgets"] if row["supplier"]=="combined")
    assert combined["complete"] and normalized[0].identity_source
    exact_finish = requested.model_copy(update={"printing":"Holofoil"})
    assert not next(row for row in budgets([exact_finish],normalized)["budgets"] if row["supplier"]=="combined")["complete"]
    tcg = {"listingId":1,"price":1.2,"currency":"USD","quantity":2,"cardNumber":"1","condition":"Near Mint","language":"English","printing":"Holofoil","productName":"Test ex","setName":"Test set","url":"https://www.tcgplayer.com/product/123"}
    assert next(row for row in budgets([card()],tcgplayer_listings_offers([tcg]))["budgets"] if row["supplier"]=="combined")["complete"]
    assert tcgplayer_listings_input(card())["proxyConfiguration"] == {"useApifyProxy":False}


@pytest.mark.parametrize("requested_number,actor_number,comparable", [
    ("1", "001/165", True),
    ("001", "1/165", True),
    ("SV001", "sv001/SV122", True),
    ("TG1", "TG01/TG30", True),
    ("1", "002/165", False),
    ("1", "SV001/SV122", False),
    ("TG1", "GG01/GG70", False),
    ("1", "001a/165", False),
    ("1", "001/unknown", False),
    ("1", "001/165/extra", False),
    ("1", None, False),
])
def test_actor_card_numbers_match_local_id_without_losing_identity(requested_number, actor_number, comparable):
    requested = card().model_copy(update={"number":requested_number})
    raw = {"listingId":1,"price":1.2,"currency":"USD","quantity":2,
           "cardNumber":actor_number,"condition":"Near Mint","language":"English",
           "printing":"Holofoil","productName":"Test ex","setName":"Test set",
           "url":"https://www.tcgplayer.com/product/123"}
    offers = tcgplayer_listings_offers([raw])
    result = next(row for row in budgets([requested],offers)["budgets"] if row["supplier"] == "combined")
    assert result["complete"] is comparable
    assert offers[0].number == actor_number  # Preserve the source representation.
