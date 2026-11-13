"""Deterministic collection selection from verified candidate price references."""
from decimal import Decimal, ROUND_CEILING
from shared.contracts import AgentPlan,Offer
from services.orchestrator.budget import reference_estimates,normalized
from services.orchestrator.exchange import ZERO_DECIMAL,THREE_DECIMAL

PREFERRED_RARITIES={'ultra rare','rare ultra','illustration rare','special illustration rare','special art rare','full art','rare secret','secret rare','hyper rare'}


def select_collection(plan:AgentPlan,offers:list[Offer],metadata:dict,snapshot:dict|None):
    goal=plan.collection
    if goal is None:raise ValueError('A collection requires an explicit budget and currency.')
    rates=snapshot['rates'] if snapshot else {}
    quantum=Decimal(1) if goal.currency in ZERO_DECIMAL else Decimal('.001') if goal.currency in THREE_DECIMAL else Decimal('.01')
    budget=goal.budget_amount;remaining=budget;selected=[];lines=[];excluded=[];candidates={}
    # Price guides retain supplier/original currency evidence and quantities.
    for estimate in reference_estimates(plan.cards,offers):
        currency=estimate['currency']
        factor=Decimal(1) if currency==goal.currency else (Decimal(str(rates[goal.currency]))/Decimal(str(rates[currency])) if goal.currency in rates and currency in rates else None)
        if factor is None:continue
        for line in estimate['lines']:
            value=(Decimal(line['line_total'])*factor).quantize(quantum,rounding=ROUND_CEILING)
            row={**line,'supplier':estimate['supplier'],'original_currency':currency,
                 'original_unit_price':line['unit_price'],'original_line_total':line['line_total'],
                 'converted_unit_price':str(Decimal(line['unit_price'])*factor),'converted_line_total':str(value),'currency':goal.currency}
            previous=candidates.get(line['card_id'])
            if previous is None or value<Decimal(previous['converted_line_total']):candidates[line['card_id']]=row
    def preferred(card):
        rarity=normalized(metadata.get(card.card_id,{}).get('rarity',''))
        return rarity in PREFERRED_RARITIES or 'illustration' in rarity or 'full art' in rarity
    ordered=sorted(plan.cards,key=lambda c:(0 if goal.prefer_full_art and preferred(c) else 1,
                   Decimal(candidates[c.card_id]['converted_line_total']) if c.card_id in candidates else Decimal('Infinity'),c.card_id))
    for card in ordered:
        line=candidates.get(card.card_id)
        if not line:
            excluded.append({'card_id':card.card_id,'name':card.name,'reason':'No convertible verified price reference.'});continue
        cost=Decimal(line['converted_line_total'])
        if goal.max_printings is not None and len(selected)>=goal.max_printings:
            excluded.append({'card_id':card.card_id,'name':card.name,'reason':'Requested printing-count limit.'});continue
        if cost>remaining:
            excluded.append({'card_id':card.card_id,'name':card.name,'reason':'Would exceed the remaining product budget.'});continue
        selected.append(card);lines.append({**line,'preferred_rarity':preferred(card),'rarity':metadata.get(card.card_id,{}).get('rarity')});remaining-=cost
    subtotal=budget-remaining
    # Do not round a JPY subtotal down and accidentally claim extra headroom.
    displayed=subtotal.quantize(quantum,rounding=ROUND_CEILING)
    if displayed>budget:displayed=subtotal
    status='selected' if selected else 'no_affordable_candidates' if candidates else 'prices_or_exchange_unavailable'
    summary={'status':status,'subject':goal.subject,'budget_amount':str(budget),'currency':goal.currency,
             'product_subtotal':str(displayed) if selected else None,'remaining_budget':str(budget-displayed) if selected else None,
             'selected_printings':len(selected),'selected_cards':sum(c.quantity for c in selected),
             'researched_candidates':len(plan.cards),'priced_candidates':len(candidates),
             'preferred_selected':sum(preferred(c) for c in selected),'lines':lines,'excluded_candidates':excluded,
             'confirmed_total':None,'shipping_confirmed':False,
             'limitations':['Indicative product-subtotal estimate. Seller stock, condition, language, delivery, tax and fees are unverified.',
                            'Preference ranking uses catalog rarity; inspect the linked card images before purchase.',
                            'Converted collection line costs are rounded up to minor currency units to preserve budget headroom.',
                            'Selection covers the researched candidate pool; it is not an exhaustive or globally optimal collection.']}
    if snapshot:
        summary['exchange']={k:snapshot[k] for k in ['as_of','retrieved_at'] if k in snapshot}
        summary['exchange']['rates']={code:str(Decimal(str(rates[goal.currency]))/Decimal(str(value))) for code,value in rates.items() if goal.currency in rates and code in {r['original_currency'] for r in lines}}
        summary['exchange'].update(status='available',target_currency=goal.currency)
        summary['exchange']['source']={'url':'https://www.exchangerate-api.com','title':'Rates By Exchange Rate API'}
    return plan.model_copy(update={'cards':selected}),summary
