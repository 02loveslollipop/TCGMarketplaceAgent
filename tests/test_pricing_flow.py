"""Baseline pricing is independent of access failures and confirmed stock evidence."""
import httpx
import pytest
from services.orchestrator.agent import DeckAgent
from services.orchestrator.budget import availability_evidence, reference_estimates
from services.orchestrator.research import Research, ResearchError, source_error
from services.orchestrator.suppliers import Suppliers, SupplierQuery
from shared.contracts import Offer, Source, Decision
from tests.test_agent import FakePlanner, collect, execution
from tests.test_suppliers import card


def listing(quantity=None, availability='unknown', **changes):
    request = card()
    values = dict(id='synthetic-listing', name=request.name, supplier='TCGplayer',
                  set_name=request.set_name, number=request.number, condition=request.condition,
                  language=request.language, printing=request.printing, quantity=quantity,
                  availability=availability, price='2.50', currency='USD', price_kind='listing',
                  source=Source(url='https://example.com/product', title='Synthetic listing'))
    return Offer(**{**values, **changes})


@pytest.mark.parametrize('offers,shortages,unverified', [
    ([], 0, 1), ([listing()], 0, 1),
    ([listing(price_kind='reference')], 0, 1),
    ([listing(0, 'out_of_stock')], 1, 0),
    ([listing(1, 'in_stock')], 1, 0),
    ([listing(2, 'in_stock')], 0, 0),
    ([listing(0, 'out_of_stock', number='other')], 0, 1),
    ([listing(0, 'out_of_stock'), listing(id='unknown')], 0, 1),
    ([listing(1, 'in_stock'), listing(1, 'in_stock')], 1, 0), # Duplicate stock cannot be counted twice.
])
def test_stock_requires_matching_listing_evidence(offers, shortages, unverified):
    result = availability_evidence([card()], offers)
    assert len(result['stock_shortages']) == shortages
    assert len(result['availability_unverified']) == unverified


@pytest.mark.parametrize('status,outcome', [(401,'unauthorized'),(402,'billing_required'),(403,'blocked'),(429,'rate_limited'),(500,'http_error')])
async def test_apify_http_failure_has_safe_diagnostic_and_never_becomes_no_stock(status, outcome):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r:httpx.Response(status,json={'secret':'do-not-log'},request=r))) as client:
        result = await Suppliers('private-api-key',client).listings('TCGplayer',card())
    assert result.outcome == outcome and result.http_status == status
    assert result.layer == 'apify' and result.offers == []
    diagnostic = str(result.diagnostic('TCGplayer',card(),'availability'))
    assert 'private-api-key' not in diagnostic and 'do-not-log' not in diagnostic


@pytest.mark.parametrize('data,outcome', [([], 'empty'), ({'error':'private-internal-detail'}, 'invalid_response'),([{'incomplete':True}],'invalid_response')])
async def test_empty_or_invalid_actor_dataset_does_not_prove_out_of_stock(data,outcome):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r:httpx.Response(200,json=data))) as client:
        result=await Suppliers('key',client).listings('TCGplayer',card())
    assert result.outcome == outcome and not result.offers
    assert 'private-internal-detail' not in result.message


async def test_disabled_and_timeout_are_separate_outcomes(monkeypatch):
    monkeypatch.setenv('APIFY_LIVE_SCRAPE','false')
    assert (await Suppliers('key').listings('TCGplayer',card())).outcome == 'disabled'
    def timeout(request):
        raise httpx.ReadTimeout('private-url-token',request=request)
    async with httpx.AsyncClient(transport=httpx.MockTransport(timeout)) as client:
        result=await Suppliers('key',client).listings('TCGplayer',card())
    assert result.outcome=='timeout' and 'private-url-token' not in result.message


@pytest.mark.parametrize('text,layer,outcome', [('HTTP 403','mcp','blocked'),('HTTP 429','mcp','rate_limited'),('Verify you are human','webpage','blocked'),('Request timed out with secret-token','webpage','timeout')])
def test_mcp_and_webpage_failure_categories_do_not_echo_content(text,layer,outcome):
    error=source_error(text,layer)
    assert error.layer==layer and error.outcome==outcome
    assert 'secret-token' not in str(error)


async def test_webpage_challenge_is_never_accepted_as_product_content(monkeypatch):
    research=Research()
    async def challenge(*args):return 'Just a moment... verify you are human'
    monkeypatch.setattr(research,'_call_ddg_mcp_tool',challenge)
    monkeypatch.setattr('services.orchestrator.research.public_https',lambda url:None)
    with pytest.raises(ResearchError) as error:
        await research.fetch('https://example.com/product')
    assert error.value.layer=='webpage' and error.value.outcome=='blocked'
    assert research.sources=={}


async def test_graph_returns_baseline_despite_blocked_stock_and_persists_diagnostics(repo):
    calls=[]
    class PhasedSuppliers:
        async def baseline(self,supplier,requested):
            calls.append(('baseline',supplier))
            return SupplierQuery([listing(name=requested.name,set_name=requested.set_name,number=requested.number,printing=requested.printing,price_kind='reference')], 'success', 'tcgdex', 'Price guide only.')
        async def listings(self,supplier,requested):
            calls.append(('availability',supplier))
            return SupplierQuery(outcome='blocked',layer='apify',http_status=403,message='Access blocked; stock unverified.')
    row=execution(repo)
    events=await collect(DeckAgent(repo,FakePlanner(),PhasedSuppliers()),row,initial={'request':'exact','history':[]})
    result=next(e['data'] for e in events if e['type']=='result')
    assert [phase for phase,_ in calls]==['baseline','baseline','availability','availability']
    assert result['reference_estimates'] and not result['stock_shortages']
    assert result['availability_unverified']
    assert len(result['retrieval_diagnostics'])==4
    assert not any(e['type']=='question' for e in events)
    persisted=repo.events(row.id,'owner')
    assert any(e.kind=='tool' and e.payload.get('diagnostic',{}).get('http_status')==403 for e in persisted)


def test_cardmarket_baseline_prefers_trend_to_extreme_listing_low():
    request=card().model_copy(update={'printing':'any'})
    offers=Suppliers()._offers_from_tcgdex_pricing(request.card_id,{'cardmarket':{'low':0.02,'trend':0.9}},'Cardmarket',request,Source(url='https://example.com/catalog',title='Catalog'))
    estimate=reference_estimates([request],offers)[0]
    assert estimate['product_subtotal']=='1.8'
    assert all(offer.quantity is None and offer.availability=='unknown' for offer in offers)
    assert all(offer.printing is None for offer in offers)


def test_shared_listing_stock_is_allocated_once_across_overlapping_preferences():
    requested=card().model_copy(update={'quantity':2})
    flexible=requested.model_copy(update={'condition':'any'})
    result=availability_evidence([requested,flexible],[listing(2,'in_stock')])
    assert sum(row['quantity'] for row in result['stock_shortages'])==2


async def test_router_selects_deck_construction_and_followup_stays_in_same_execution(repo):
    calls=[]
    from tests.test_deck_approval_currency import DeckPlanner, CountingSuppliers
    class RoutedDeckPlanner(DeckPlanner):
        async def route(self,request,history,images):
            calls.append('route')
            return 'deck'
        async def resolve(self,request,history,knowledge,**kwargs):
            calls.append(kwargs['task'])
            return await super().resolve(request,history,knowledge,**kwargs)
    row=execution(repo)
    agent=DeckAgent(repo,RoutedDeckPlanner(),CountingSuppliers())
    events=await collect(agent,row,initial={'request':'Build a deck','history':[]})
    assert calls==['route','deck']
    assert any(e['type']=='question' and e['data']['kind']=='deck_approval' for e in events)
    assert repo.claim_execution(row.id,'owner')
    events=await collect(DeckAgent(repo,RoutedDeckPlanner(),CountingSuppliers()),row,decision=Decision(action='revise_deck',text='Use another attacker'))
    assert calls==['route','deck','route','deck']
    assert repo.execution(row.id,'owner').status=='waiting'
    assert any(e['type']=='question' and e['data']['kind']=='deck_approval' for e in events)


@pytest.mark.parametrize('action', ['keep_missing', 'cancel'])
async def test_pre_upgrade_reference_only_interruption_can_resume_without_fake_missing_consent(repo, action):
    from langgraph.graph import StateGraph,START,END
    from langgraph.types import interrupt
    from services.orchestrator.agent import State
    from services.orchestrator.checkpoints import DatabaseSaver
    from services.orchestrator.budget import budgets
    from shared.contracts import AgentPlan,Legality
    from tests.test_agent import FakeSuppliers
    row=execution(repo)
    requested=card().model_copy(update={'printing':'any'})
    guide=listing(price_kind='reference')
    plan=AgentPlan(cards=[requested],format='standard')
    question={'kind':'missing_cards','question':'Old interruption','missing':[requested.model_dump(mode='json')],'actions':['keep_missing','cancel']}
    old=StateGraph(State)
    def old_decide(state):
        interrupt(state['question'])
        return {}
    old.add_node('decide',old_decide);old.add_edge(START,'decide');old.add_edge('decide',END)
    graph=old.compile(checkpointer=DatabaseSaver(repo))
    await graph.ainvoke({'plan':plan.model_dump(mode='json'),'legality':Legality(status='unverified').model_dump(mode='json'),
                        'offers':[guide.model_dump(mode='json')],'budget':budgets([requested],[guide]),'question':question,'supplier_errors':[]},
                       {'configurable':{'thread_id':row.id}})
    repo.checkpoint(row.id,'owner',question,'waiting')
    assert repo.claim_execution(row.id,'owner')
    events=await collect(DeckAgent(repo,FakePlanner(),FakeSuppliers()),row,decision=Decision(action=action,approved=action=='keep_missing'))
    if action=='cancel':
        assert not any(e['type']=='result' for e in events)
        assert events[-1]['data']['status']=='cancelled'
        return
    result=next(e['data'] for e in events if e['type']=='result')
    assert result['reference_estimates'] and not result['stock_shortages']
    assert result['consent']=={} and result['availability_unverified']
