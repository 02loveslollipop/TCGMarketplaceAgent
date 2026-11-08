from decimal import Decimal
from shared.contracts import CardRequest, Offer, Source
from services.orchestrator.budget import budgets, equivalent


def card(quantity=4):
    return CardRequest(card_id="test-1", name="Test ex", quantity=quantity, set_name="Test", number="1", condition="NM", language="English", printing="Holofoil")


def offer(**changes):
    values = dict(id="1", name="Test ex", supplier="TCGplayer", set_name="Test", number="1", condition="Near Mint", language="English", printing="Holofoil", price=Decimal("0.10"), currency="USD", quantity=4, availability="in_stock", price_kind="listing", source=Source(url="https://example.com/card", title="Card"))
    return Offer(**(values | changes))


def combined(result, currency="USD"):
    return next(b for b in result["budgets"] if b["supplier"]=="combined" and b["currency"]==currency)


def test_decimal_totals_unknown_shipping_and_supplier_selection():
    result = budgets([card()], [offer(), offer(id="2", supplier="Cardmarket", price=Decimal("0.20"))])
    budget = combined(result)
    assert budget["complete"] and budget["product_subtotal"] == "0.40"
    assert budget["confirmed_total"] is None and budget["known_shipping"] is None
    confirmed = combined(budgets([card()], [offer(shipping=Decimal("0"), shipping_confirmed=True)]))
    assert confirmed["confirmed_total"] == "0.40"


def test_stock_unknown_variants_and_reference_are_noncomparable():
    for change in ({"quantity":None}, {"availability":"out_of_stock"}, {"number":None}, {"language":"Japanese"}, {"printing":"Normal"}, {"condition":None}, {"price_kind":"reference"}):
        assert not equivalent(card(), offer(**change))
    result = combined(budgets([card()], [offer(quantity=1)]))
    assert not result["complete"] and result["missing"][0]["quantity"] == 3


def test_currencies_stay_separate_and_inventory_not_reused():
    result = budgets([card(2), card(2)], [offer(quantity=3), offer(id="eur", currency="EUR", quantity=1)])
    assert combined(result)["lines"][0]["requested"] == 4
    assert combined(result)["lines"][0]["covered"] == 3
    assert combined(result,"EUR")["lines"][0]["covered"] == 1
    assert not combined(result)["complete"] and not combined(result,"EUR")["complete"]
    assert combined(budgets([card()], [offer(quantity=2),offer(quantity=2)]))["missing"][0]["quantity"] == 2


def test_normalized_duplicate_card_numbers_share_requested_quantity_and_stock():
    requested = [card(2), card(2).model_copy(update={"number":"001/165"})]
    result = combined(budgets(requested, [offer(number="001/165",quantity=3)]))
    assert len(result["lines"]) == 1
    assert result["lines"][0]["requested"] == 4
    assert result["lines"][0]["covered"] == 3
    assert not result["complete"]


def test_flexible_request_does_not_consume_only_stock_for_nm_request():
    flexible = card(1).model_copy(update={"card_id":"flexible", "condition":"any"})
    restricted = card(1).model_copy(update={"card_id":"restricted"})
    listings = [offer(id="nm", quantity=1, price=Decimal("1")),
                offer(id="lp", quantity=1, condition="LP", price=Decimal("2"))]
    for requested in ([flexible, restricted], [restricted, flexible]):
        budget = combined(budgets(requested, listings))
        assert budget["complete"] and budget["product_subtotal"] == "3"
        assigned = {line["card_id"]: line["allocations"][0]["offer_id"] for line in budget["lines"]}
        assert assigned == {"flexible":"lp", "restricted":"nm"}


def test_maximum_coverage_precedes_cost_and_then_cost_is_minimized():
    flexible = card(2).model_copy(update={"card_id":"flexible", "condition":"any"})
    restricted = card(1).model_copy(update={"card_id":"restricted"})
    listings = [offer(id="nm", quantity=1, price=Decimal("1")),
                offer(id="lp-cheap", quantity=1, condition="LP", price=Decimal("2")),
                offer(id="lp-expensive", quantity=1, condition="LP", price=Decimal("5")),
                offer(id="lp-unused", quantity=1, condition="LP", price=Decimal("9"))]
    budget = combined(budgets([flexible, restricted], listings))
    assert budget["complete"] and budget["product_subtotal"] == "8"
    assert {a["offer_id"] for line in budget["lines"] for a in line["allocations"]} == {"nm", "lp-cheap", "lp-expensive"}
    partial = combined(budgets([flexible, restricted], listings[:2]))
    assert sum(line["covered"] for line in partial["lines"]) == 2
    assert partial["product_subtotal"] == "3"


def test_same_card_id_different_restrictions_remain_distinct_in_missing_results():
    near_mint = card(1)
    played = card(1).model_copy(update={"condition":"LP"})
    result = budgets([near_mint, played], [offer(quantity=1), offer(id="euro", currency="EUR", quantity=1)])
    assert result["missing"] == [{"card_id":"test-1", "name":"Test ex", "set_name":"Test", "number":"1", "condition":"LP", "language":"English", "printing":"Holofoil", "quantity":1}]
    for currency in ("USD", "EUR"):
        budget = combined(result, currency)
        assert not budget["complete"]
        assert [line["covered"] for line in budget["lines"]] == [1, 0]
        assert budget["missing"] == result["missing"]


def test_condition_aliases_and_number_formats_merge_without_reusing_stock():
    same_variant = card(1).model_copy(update={"card_id":"other-id", "condition":"Near Mint", "number":"001/165"})
    result = budgets([card(1), same_variant], [offer(quantity=1)])
    budget = combined(result)
    assert len(budget["lines"]) == 1
    assert budget["lines"][0]["requested"] == 2 and budget["lines"][0]["covered"] == 1
    assert result["missing"][0]["quantity"] == 1


def test_coverage_is_not_combined_across_currency_budgets():
    nm = card(1)
    lp = card(1).model_copy(update={"condition":"LP"})
    result = budgets([nm, lp], [offer(id="usd", quantity=1), offer(id="eur", currency="EUR", condition="LP", quantity=1)])
    assert not combined(result, "USD")["complete"] and not combined(result, "EUR")["complete"]
    assert len(result["missing"]) == 1 and result["missing"][0]["quantity"] == 1
