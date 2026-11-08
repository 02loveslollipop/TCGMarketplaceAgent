"""Deterministic matching, stock allocation and currency-separated budgets."""
from decimal import Decimal
import re
from shared.contracts import CardRequest, Offer


def normalized(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").strip().casefold())


def card_number(value: str | None) -> str:
    """Normalize local-number formatting while retaining promo/subset letters.

    Catalog localId omits the printed set-size denominator. Only recognized
    numeric/alphanumeric number forms are shortened; malformed values stay
    distinct instead of being interpreted as a valid card number.
    """
    raw = normalized(value)
    parts = raw.split("/")
    pattern = r"([a-z]*)([0-9]+)([a-z]*)"
    if len(parts) > 2 or (len(parts) == 2 and not re.fullmatch(pattern, parts[1].strip())):
        return raw
    match = re.fullmatch(pattern, parts[0].strip())
    if not match:
        return raw
    prefix, number, suffix = match.groups()
    return f"{prefix}{int(number)}{suffix}"


CONDITIONS = {"near mint":"nm", "nm":"nm", "mint":"mint", "excellent":"ex", "ex":"ex",
              "lightly played":"lp", "lp":"lp", "good":"gd", "gd":"gd"}


def request_identity(card: CardRequest) -> tuple[str, ...]:
    """Use the same normalized variant restrictions for merging and coverage."""
    condition = normalized(card.condition)
    return (normalized(card.name), normalized(card.set_name), card_number(card.number),
            CONDITIONS.get(condition, condition), normalized(card.language), normalized(card.printing))


def request_details(card: CardRequest) -> dict:
    return {field: getattr(card, field) for field in
            ("card_id", "name", "set_name", "number", "condition", "language", "printing")}


def equivalent(card: CardRequest, offer: Offer) -> bool:
    if offer.price_kind != "listing" or offer.availability != "in_stock" or not offer.quantity:
        return False
    for field in ("name", "set_name", "number", "language", "printing", "condition"):
        normalize = card_number if field == "number" else normalized
        requested, found = normalize(getattr(card, field)), normalize(getattr(offer, field))
        if not found and field == "printing" and requested == "any":
            continue
        if not found:
            return False
        if field == "condition":
            requested, found = CONDITIONS.get(requested, requested), CONDITIONS.get(found, found)
        if requested != "any" and requested != found:
            return False
    return True


def merge_requests(cards: list[CardRequest]) -> list[CardRequest]:
    result = {}
    for card in cards:
        key = request_identity(card)
        if key in result:
            total = result[key].quantity + card.quantity
            if total > 60:
                raise ValueError("Requested quantity exceeds the PoC limit.")
            result[key] = result[key].model_copy(update={"quantity":total})
        else:
            result[key] = card
    return list(result.values())


def optimal_allocation(cards: list[CardRequest], offers: list[Offer]) -> list[list[int]]:
    """Maximize covered units, then minimize their product cost.

    A residual min-cost flow can reassign previously selected stock when a
    later request has fewer compatible offers. Costs remain exact Decimals.
    """
    source = 0
    offer_offset = 1
    card_offset = offer_offset + len(offers)
    sink = card_offset + len(cards)
    graph: list[list[list]] = [[] for _ in range(sink + 1)]

    def add_edge(start: int, end: int, capacity: int, cost: Decimal) -> list:
        forward = [end, len(graph[end]), capacity, cost]
        reverse = [start, len(graph[start]), 0, -cost]
        graph[start].append(forward)
        graph[end].append(reverse)
        return forward

    edges = {}
    for i, offer in enumerate(offers):
        add_edge(source, offer_offset + i, offer.quantity, Decimal(0))
        for j, card in enumerate(cards):
            if equivalent(card, offer):
                edges[i, j] = add_edge(offer_offset + i, card_offset + j,
                                       min(offer.quantity, card.quantity), offer.price)
    for j, card in enumerate(cards):
        add_edge(card_offset + j, sink, card.quantity, Decimal(0))

    while True:
        distance: list[Decimal | None] = [None] * len(graph)
        previous: list[tuple[int, int] | None] = [None] * len(graph)
        distance[source] = Decimal(0)
        # Reverse edges can have negative costs, so Dijkstra is not sufficient.
        for _ in range(len(graph) - 1):
            changed = False
            for start, outgoing in enumerate(graph):
                if distance[start] is None:
                    continue
                for edge_index, (end, _, capacity, cost) in enumerate(outgoing):
                    candidate = distance[start] + cost
                    if capacity and (distance[end] is None or candidate < distance[end]):
                        distance[end] = candidate
                        previous[end] = (start, edge_index)
                        changed = True
            if not changed:
                break
        if previous[sink] is None:
            break
        flow = None
        node = sink
        while node != source:
            start, edge_index = previous[node]
            edge = graph[start][edge_index]
            flow = edge[2] if flow is None else min(flow, edge[2])
            node = start
        node = sink
        while node != source:
            start, edge_index = previous[node]
            edge = graph[start][edge_index]
            edge[2] -= flow
            graph[node][edge[1]][2] += flow
            node = start

    allocation = [[0] * len(offers) for _ in cards]
    for (i, j), edge in edges.items():
        allocation[j][i] = graph[edge[0]][edge[1]][2]
    return allocation


def allocate(cards: list[CardRequest], offers: list[Offer], currency: str, supplier: str | None) -> dict:
    cards = merge_requests(cards)
    candidates = sorted((offer for offer in offers if offer.currency == currency
                         and (supplier is None or offer.supplier == supplier)
                         and any(equivalent(card, offer) for card in cards)),
                        key=lambda offer: (offer.price, offer.id))
    allocation = optimal_allocation(cards, candidates)
    lines, missing, selected = [], [], {}
    subtotal = Decimal("0")
    for card, amounts in zip(cards, allocation):
        remaining = card.quantity - sum(amounts)
        allocations = []
        for offer, quantity in zip(candidates, amounts):
            if quantity <= 0:
                continue
            cost = offer.price * quantity
            allocations.append({"offer_id":offer.id, "supplier":offer.supplier, "quantity":quantity,
                                "unit_price":str(offer.price), "line_total":str(cost), "url":str(offer.source.url)})
            subtotal += cost
            selected[offer.id] = offer
        lines.append({**request_details(card), "requested":card.quantity,
                      "covered":card.quantity - remaining, "allocations":allocations})
        if remaining:
            missing.append({**request_details(card), "quantity":remaining})
    shipping = sum((offer.shipping for offer in selected.values() if offer.shipping is not None), Decimal("0"))
    shipping_known = bool(selected) and all(offer.shipping is not None and offer.shipping_confirmed for offer in selected.values())
    complete = bool(cards) and not missing
    return {"supplier":supplier or "combined", "currency":currency, "lines":lines,
            "complete":complete, "missing":missing, "product_subtotal":str(subtotal),
            "known_shipping":str(shipping) if selected and any(offer.shipping is not None for offer in selected.values()) else None,
            "shipping_confirmed":shipping_known,
            "confirmed_total":str(subtotal + shipping) if complete and shipping_known else None}


def budgets(cards: list[CardRequest], offers: list[Offer]) -> dict:
    # De-duplicate identical listing IDs before allocating inventory.
    unique = {offer.id:offer for offer in offers}
    offers = list(unique.values())
    currencies = sorted({offer.currency for offer in offers})
    result = []
    for currency in currencies:
        for supplier in ("TCGplayer", "Cardmarket", None):
            result.append(allocate(cards, offers, currency, supplier))
    requests = merge_requests(cards)
    covered = {request_identity(card):0 for card in requests}
    combined = [budget for budget in result if budget["supplier"] == "combined"]
    if combined:
        # Coverage from different currencies cannot be spliced together as if
        # it were one complete budget. Preserve a single feasible alternative.
        best = max(combined, key=lambda budget: sum(line["covered"] for line in budget["lines"]))
        for card, line in zip(requests, best["lines"]):
            covered[request_identity(card)] = line["covered"]
    missing = [{**request_details(card), "quantity":card.quantity-covered[request_identity(card)]}
               for card in requests if card.quantity > covered[request_identity(card)]]
    return {"budgets":result, "missing":missing, "recommendation":"Lowest comparable product prices within each currency; shipping and incomplete coverage remain explicit. No cross-currency total is asserted."}
