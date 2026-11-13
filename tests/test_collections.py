from decimal import Decimal
from types import SimpleNamespace
import pytest
from shared.contracts import AgentPlan,CardRequest,CollectionGoal,Offer,Source,Legality
from services.orchestrator.collection import select_collection
from services.orchestrator.planner import Planner
from services.orchestrator.agent import DeckAgent
from services.orchestrator.exchange import ExchangeRates,ExchangeUnavailable
from services.orchestrator.suppliers import SupplierQuery
from tests.test_agent import collect,execution


def card(id='xy-1',name='Gardevoir ex'):
    return CardRequest(card_id=id,name=name,set_name='Synthetic',number=id.rsplit('-',1)[-1],quantity=1)


def offer(c,price,supplier='TCGplayer',currency='USD'):
    return Offer(id=supplier+':'+c.card_id+':market',supplier=supplier,name=c.name,set_name=c.set_name,number=c.number,
                 price=price,currency=currency,price_kind='reference',source=Source(url='https://example.com/'+c.card_id,title='Synthetic guide'))


def plan(cards,budget='5000',max_printings=None):
    return AgentPlan(purpose='collection',format='collection',cards=cards,collection=CollectionGoal(subject='Gardevoir',budget_amount=budget,currency='JPY',prefer_full_art=True,max_printings=max_printings))


def test_collection_ignores_play_rotation_and_verifies_every_identity():
    c=card();metadata={'id':c.card_id,'name':c.name,'localId':'1','set':{'id':'xy','name':'Synthetic'},'regulationMark':None,'legal':{'standard':False,'expanded':True},'category':'Pokemon'}
    p=Planner(None,SimpleNamespace(cards={c.card_id:metadata},sources={},repository=None))
    result=p.validate(plan([c]),{'ruleset':'international','format':'standard'})
    assert result.purpose=='collection' and not result.is_deck and result.format=='collection' and result.ruleset is None
    assert len(result.cards)==1
    wrong=plan([card(name='Invented card')])
    assert p.validate(wrong).question


def test_collection_prefers_catalog_art_variants_and_enforces_cross_currency_cap():
    a,b,c=card('a-1'),card('b-2'),card('c-3')
    metadata={a.card_id:{'rarity':'Ultra Rare'},b.card_id:{'rarity':'Rare'},c.card_id:{'rarity':'Secret Rare'}}
    selected,summary=select_collection(plan([a,b,c]),[offer(a,'20'),offer(a,'18','Cardmarket','EUR'),offer(b,'1'),offer(c,'100')],metadata,{'rates':{'USD':Decimal(1),'EUR':Decimal(1),'JPY':Decimal(150)},'as_of':'2026-11-13','retrieved_at':'2026-11-13'})
    assert [x.card_id for x in selected.cards]==[a.card_id,b.card_id]
    assert summary['product_subtotal']=='2850' and summary['remaining_budget']=='2150'
    assert summary['preferred_selected']==1 and summary['confirmed_total'] is None
    assert summary['lines'][0]['supplier']=='Cardmarket'
    assert summary['exchange']['rates']['USD']=='150'
    assert summary['excluded_candidates'][0]['card_id']==c.card_id


def test_unknown_rates_and_prices_never_become_free_cards_or_budget_claims():
    c=card();selected,summary=select_collection(plan([c]),[offer(c,'1')],{},None)
    assert selected.cards==[] and summary['product_subtotal'] is None and summary['status']=='prices_or_exchange_unavailable'
    selected,summary=select_collection(plan([c]),[offer(c,'7000',currency='JPY')],{},None)
    assert selected.cards==[] and summary['status']=='no_affordable_candidates'


def test_collection_rounds_each_line_up_before_admitting_the_next_printing():
    a,b=card('a-1'),card('b-2')
    selected,summary=select_collection(plan([a,b],budget='1'),[offer(a,'.004'),offer(b,'.004')],{},
        {'rates':{'USD':Decimal(1),'JPY':Decimal(150)},'as_of':'2026-11-13'})
    assert len(selected.cards)==1
    assert summary['product_subtotal']=='1' and summary['remaining_budget']=='0'
    assert sum(Decimal(row['converted_line_total']) for row in summary['lines'])==Decimal(summary['product_subtotal'])


class Rates(ExchangeRates):
    async def snapshot(self):return {'rates':{'USD':Decimal(1),'EUR':Decimal('.8'),'JPY':Decimal(150)},'as_of':'2026-11-13T00:00:00Z','retrieved_at':'2026-11-13T00:00:00Z'}


async def test_collection_graph_prices_candidates_then_selects_without_deck_approval(repo):
    cards=[card('a-1'),card('b-2'),card('c-3')]
    class CollectionPlanner:
        research=SimpleNamespace(cards={c.card_id:{'rarity':'Ultra Rare'} for c in cards},sources={})
        async def route(self,*args):return 'collection'
        async def resolve(self,*args,**kwargs):return plan(cards,budget='500',max_printings=2)
        async def legality(self,*args):raise AssertionError('Collections must not use tournament legality as a gate')
    class Suppliers:
        calls=[]
        async def baseline(self,supplier,c):
            self.calls.append(('baseline',c.card_id));return SupplierQuery([offer(c,'1',supplier,'USD' if supplier=='TCGplayer' else 'EUR')],outcome='success')
        async def listings(self,supplier,c):
            self.calls.append(('availability',c.card_id));return SupplierQuery(outcome='disabled')
    suppliers=Suppliers();events=await collect(DeckAgent(repo,CollectionPlanner(),suppliers,exchange=Rates()),execution(repo),initial={'request':'Gardevoir collection with 500 JPY','history':[]})
    assert not any(e['type']=='question' for e in events)
    result=next(e['data'] for e in events if e['type']=='result')
    assert len(result['plan']['cards'])==2 and result['legality']['applicable'] is False
    assert result['collection_summary']['product_subtotal']=='300'
    assert len([c for phase,c in suppliers.calls if phase=='baseline'])==6
    assert len([c for phase,c in suppliers.calls if phase=='availability'])==4
    assert result['currency_conversion']['target_currency']=='JPY'


def test_research_context_omits_repeated_price_html_and_source_payloads():
    from services.orchestrator.context import research_content
    raw={'cards':[{'id':'a','name':'Gardevoir','rarity':'Ultra Rare','pricing':{'large':'x'*50000},'attacks':[{'effect':'Useful rule text'}]}], 'source':{'url':'https://example.com','excerpt':'x'*20000},'text':'<script>UNTRUSTED</script><p>Public evidence</p>'}
    result=research_content(raw)
    assert len(str(result))<500
    assert result['cards'][0]['attacks'][0]['effect']=='Useful rule text'
    assert 'Public evidence' in result['text'] and 'UNTRUSTED' not in result['text']


async def test_mcp_challenges_never_trigger_impersonation_or_become_empty(monkeypatch):
    from services.ddg_mcp.main import PublicSearcher
    searcher=PublicSearcher(backend='httpx')
    async def blocked(data):return 202,'<html>captcha challenge</html>'
    async def forbidden(*args):raise AssertionError('A blocked source must not use curl/impersonation')
    class Context:
        async def info(self,*args):pass
        async def error(self,*args):pass
    monkeypatch.setattr(searcher,'_request_httpx',blocked)
    monkeypatch.setattr(searcher,'_request_curl',forbidden)
    with pytest.raises(RuntimeError,match='CAPTCHA'):
        await searcher.search('Gardevoir',Context())
    from services.orchestrator.research import source_error
    error=source_error('Search HTTP 202 CAPTCHA/challenge','mcp')
    assert error.outcome=='blocked' and error.http_status==202


async def test_planning_defers_marketplace_pages_to_supplier_stage():
    from langchain_core.messages import AIMessage
    c=card()
    metadata={'id':c.card_id,'name':c.name,'localId':'1','set':{'id':'xy','name':'Synthetic'},'category':'Pokemon','legal':{'standard':False,'expanded':True}}
    async def forbidden(args):raise AssertionError('Planning must not fetch a marketplace page')
    class Model:
        calls=0
        def bind_tools(self,tools):return self
        async def ainvoke(self,messages):
            self.calls+=1
            if self.calls==1:return AIMessage(content='',tool_calls=[{'id':'call-1','name':'fetch_public_page','args':{'url':'https://www.cardmarket.com/en/Pokemon/Products/Search'}}])
            assert 'dedicated supplier stage' in messages[-1].content
            return AIMessage(content='Verified catalog identity is enough.')
        def with_structured_output(self,*args,**kwargs):
            async def resolved(messages):return plan([c])
            return SimpleNamespace(ainvoke=resolved)
    research=SimpleNamespace(cards={c.card_id:metadata},sources={},repository=None,tools=lambda:[SimpleNamespace(name='fetch_public_page',ainvoke=forbidden)])
    result=await Planner(Model(),research).resolve('Gardevoir collection',[],{},task='collection')
    assert result.purpose=='collection' and len(result.cards)==1
