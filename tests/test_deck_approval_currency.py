"""Deck approval, preference snapshots, and indicative FX integration."""
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from services.orchestrator.agent import DeckAgent
from services.orchestrator.app import create_app
from services.orchestrator.budget import budgets, reference_estimates
from services.orchestrator.exchange import ExchangeRates, ExchangeUnavailable
from shared.contracts import AgentPlan, CardRequest, Decision, Offer, Source, utcnow
from tests.test_agent import FakePlanner, collect, execution


class DeckPlanner(FakePlanner):
    async def resolve(self, request, history, knowledge, **kwargs):
        plan = await super().resolve('exact', history, knowledge)
        plan.is_deck = True
        plan.cards[0].quantity = 60
        if 'Requested deck changes' in request:
            plan.cards[0].name = 'Revised Test'
        return plan


class CountingSuppliers:
    def __init__(self, reference=False):
        self.calls = []
        self.reference = reference

    async def quote(self, supplier, card):
        self.calls.append((supplier, card.name))
        return [Offer(id=f'{supplier}:{card.card_id}', supplier=supplier, name=card.name,
                      set_name=card.set_name, number=card.number, language=card.language,
                      condition=card.condition, printing=card.printing, quantity=None if self.reference else 60,
                      availability='unknown' if self.reference else 'in_stock', price='1.25',
                      currency='USD' if supplier == 'TCGplayer' else 'EUR',
                      price_kind='reference' if self.reference else 'listing',
                      source=Source(url='https://example.com/fixture', title='Synthetic price'))]


async def test_deck_waits_for_approval_and_survives_a_new_agent_instance(repo):
    row = execution(repo)
    suppliers = CountingSuppliers()
    events = await collect(DeckAgent(repo, DeckPlanner(), suppliers), row,
                           initial={'request': 'Build a deck', 'history': []})
    assert any(event['type'] == 'cards' for event in events)
    question = next(event['data'] for event in events if event['type'] == 'question')
    assert question['kind'] == 'deck_approval' and question['card_count'] == 60
    assert suppliers.calls == []
    assert not any(event['type'] == 'result' for event in events)
    assert repo.claim_execution(row.id, 'owner')
    events = await collect(DeckAgent(repo, DeckPlanner(), suppliers), row,
                           decision=Decision(action='approve_deck', approved=True))
    result = next(event['data'] for event in events if event['type'] == 'result')
    assert len(suppliers.calls) == 2
    assert result['deck_approval']['approved']
    assert any(budget['complete'] and budget['product_subtotal'] == '75.00' for budget in result['budgets'])
    assert events[-1]['data']['status'] == 'complete'


async def test_deck_revision_requires_a_new_approval_and_does_not_price_old_deck(repo):
    row = execution(repo)
    suppliers = CountingSuppliers()
    agent = DeckAgent(repo, DeckPlanner(), suppliers)
    await collect(agent, row, initial={'request': 'Build a deck', 'history': []})
    assert repo.claim_execution(row.id, 'owner')
    events = await collect(agent, row, decision=Decision(action='revise_deck', text='Use a different attacker'))
    assert suppliers.calls == []
    assert next(event['data'] for event in events if event['type'] == 'cards')['cards'][0]['name'] == 'Revised Test'
    assert any(event['type'] == 'question' and event['data']['kind'] == 'deck_approval' for event in events)
    assert repo.claim_execution(row.id, 'owner')
    events = await collect(agent, row, decision=Decision(action='approve_deck', approved=True))
    assert all(name == 'Revised Test' for _, name in suppliers.calls)
    assert next(event['data'] for event in events if event['type'] == 'result')['deck_approval']['cards'][0]['name'] == 'Revised Test'


async def test_cancelling_deck_review_never_calls_suppliers(repo):
    row = execution(repo)
    suppliers = CountingSuppliers()
    agent = DeckAgent(repo, DeckPlanner(), suppliers)
    await collect(agent, row, initial={'request': 'Build a deck', 'history': []})
    assert repo.claim_execution(row.id, 'owner')
    events = await collect(agent, row, decision=Decision(action='cancel'))
    assert suppliers.calls == [] and events[-1]['data']['status'] == 'cancelled'


def test_api_rejects_unapproved_or_wrong_phase_decisions_and_other_owners(repo):
    repo.save_model('fixture', label='Fixture', provider='openai', api_id='fixture', enabled=True)
    suppliers = CountingSuppliers()
    async def current(token=None):
        return SimpleNamespace(id='owner', username='owner', role='user')
    async def verified(*args):
        return True
    app = create_app(repo, current, lambda policy: DeckAgent(repo, DeckPlanner(), suppliers), verified)
    client = TestClient(app)
    response = client.post('/executions', json={'text': 'Build a deck', 'model_id': 'fixture'})
    event = json.loads(response.text.split('data: ')[1].split('\n')[0])
    path = f"/executions/{event['id']}/resume"
    assert client.post(path, json={'action': 'approve_deck'}).status_code == 422
    assert client.post(path, json={'action': 'revise_deck', 'text': ''}).status_code == 422
    assert client.post(path, json={'action': 'revise_deck', 'selected_option': 'not a revision'}).status_code == 422
    assert client.post(path, json={'action': 'keep_missing', 'approved': True}).status_code == 422
    assert suppliers.calls == []
    async def other(token=None):
        return SimpleNamespace(id='other', username='other', role='user')
    app.dependency_overrides[current] = other
    assert client.post(path, json={'action': 'approve_deck', 'approved': True}).status_code == 404
    app.dependency_overrides.clear()
    approved = client.post(path, json={'action': 'approve_deck', 'approved': True})
    assert 'event: result' in approved.text
    assert client.post(path, json={'action': 'approve_deck', 'approved': True}).status_code == 409


def rate_response(**changes):
    now = utcnow()
    return {'result': 'success', 'base_code': 'USD',
            'time_last_update_unix': int(now.timestamp()),
            'time_next_update_unix': int((now + timedelta(days=1)).timestamp()),
            'rates': {'USD': 1, 'EUR': 0.8, 'JPY': 150, 'COP': 4000}, **changes}


def buying_result():
    return {'offers': [{'price': '1.25', 'currency': 'USD'}],
            'budgets': [{'currency': 'USD', 'product_subtotal': '75.00', 'known_shipping': None,
                         'confirmed_total': None, 'lines': [{'allocations': [{'unit_price': '1.25', 'line_total': '75.00'}]}]}],
            'reference_estimates': [{'currency': 'EUR', 'product_subtotal': '60.00', 'lines': [{'unit_price': '1.00', 'line_total': '60.00'}]}]}


async def test_fx_uses_dated_cross_rates_caches_and_preserves_originals_and_unknown_shipping():
    calls = []
    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(200, json=rate_response())
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        exchange = ExchangeRates(client)
        original = buying_result()
        converted = await exchange.convert(original, 'JPY')
        again = await exchange.convert(original, 'COP')
        assert 'JPY' in await exchange.currencies()
    assert len(calls) == 1 and calls[0] == 'https://open.er-api.com/v6/latest/USD'
    assert converted['offers'][0]['converted_price'] == '187.5'
    assert converted['budgets'][0]['converted']['product_subtotal'] == '11250'
    assert converted['reference_estimates'][0]['converted']['product_subtotal'] == '11250'
    assert again['reference_estimates'][0]['converted']['product_subtotal'] == '300000.00'
    assert converted['currency_conversion']['rates']['EUR'] == '187.5'
    assert converted['currency_conversion']['source']['url'] == 'https://www.exchangerate-api.com'
    assert converted['budgets'][0]['converted']['known_shipping'] is None
    assert converted['budgets'][0]['converted']['confirmed_total'] is None
    assert 'converted' not in original['budgets'][0]
    assert original['offers'][0]['price'] == '1.25'


@pytest.mark.parametrize('payload', [
    rate_response(result='error'), rate_response(rates={'USD': 1, 'JPY': -1}),
    rate_response(time_last_update_unix=int((utcnow()-timedelta(days=4)).timestamp())),
    rate_response(rates={'USD': 1, 'EUR': 0.8}),
])
async def test_bad_or_unavailable_currency_keeps_original_costs(payload):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request:httpx.Response(200,json=payload))) as client:
        converted = await ExchangeRates(client).convert(buying_result(), 'JPY')
    assert converted['currency_conversion']['status'] == 'unavailable'
    assert converted['offers'] == buying_result()['offers']
    assert converted['budgets'] == buying_result()['budgets']


async def test_fx_outage_and_disabled_conversion_do_not_block_original_budget():
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(503)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        exchange = ExchangeRates(client)
        original = buying_result()
        assert await exchange.convert(original, None) is original and calls == []
        failed = await exchange.convert(original, 'JPY')
    assert failed['currency_conversion']['status'] == 'unavailable'
    assert failed['budgets'] == original['budgets']


async def test_reference_only_deck_finishes_with_an_estimate_without_fake_purchase_coverage(repo):
    row = execution(repo)
    agent = DeckAgent(repo, DeckPlanner(), CountingSuppliers(reference=True))
    await collect(agent, row, initial={'request': 'Build deck', 'history': []})
    assert repo.claim_execution(row.id, 'owner')
    events = await collect(agent, row, decision=Decision(action='approve_deck', approved=True))
    assert any(event['type'] == 'question' and event['data']['kind'] == 'missing_cards' for event in events)
    assert repo.claim_execution(row.id, 'owner')
    events = await collect(agent, row, decision=Decision(action='keep_missing', approved=True))
    result = next(event['data'] for event in events if event['type'] == 'result')
    assert result['reference_estimates'][0]['product_subtotal'] == '75.00'
    assert result['reference_estimates'][0]['price_coverage_complete']
    assert all(not budget['complete'] and budget['confirmed_total'] is None for budget in result['budgets'])
    assert result['missing'][0]['quantity'] == 60


def test_reference_estimates_do_not_borrow_other_printings():
    card = CardRequest(card_id='set-a-1', name='Test', quantity=2, set_name='Set A', number='1')
    guide = Offer(id='reference', name='Test', supplier='TCGplayer', set_name='Set B', number='1',
                  currency='USD', price='2.00', price_kind='reference', source=Source(url='https://example.com',title='Guide'))
    assert reference_estimates([card], [guide]) == []


def test_buying_preferences_are_owner_scoped_and_round_trip_through_api(repo):
    async def current(token=None):
        return SimpleNamespace(id='owner', username='owner', role='user')
    client = TestClient(create_app(repo, current, lambda policy: None))
    response = client.put('/preferences', json={'ruleset':'auto','format':'expanded','location':' Tokyo, Japan ','target_currency':'JPY'})
    assert response.status_code == 200 and response.json()['location'] == 'Tokyo, Japan'
    assert client.get('/preferences').json()['target_currency'] == 'JPY'
    assert repo.user_preferences('other')['target_currency'] is None
    assert client.put('/preferences', json={'target_currency':'JPY\n'}).status_code == 422
    assert client.put('/preferences', json={'location':'x'*161}).status_code == 422


async def test_sixty_card_plan_still_requires_approval_if_model_omits_deck_flag(repo):
    class MissingFlagPlanner(DeckPlanner):
        async def resolve(self, *args, **kwargs):
            plan = await super().resolve(*args, **kwargs)
            plan.is_deck = False
            return plan
    row = execution(repo)
    suppliers = CountingSuppliers()
    events = await collect(DeckAgent(repo, MissingFlagPlanner(), suppliers), row,
                           initial={'request':'Build deck','history':[]})
    assert any(event['type']=='question' and event['data']['kind']=='deck_approval' for event in events)
    assert suppliers.calls == []


async def test_running_deck_keeps_its_preference_snapshot_after_settings_change(repo):
    class EchoConversion:
        async def convert(self, result, target):
            result['conversion_target_for_test'] = target
            return result
    preferences=repo.save_user_preferences('owner','auto','expanded',location='Tokyo, Japan',target_currency='JPY')
    row=execution(repo)
    agent=DeckAgent(repo,DeckPlanner(),CountingSuppliers(),exchange=EchoConversion())
    await collect(agent,row,initial={'request':'Build deck','history':[],'preferences':preferences})
    repo.save_user_preferences('owner','japan','standard',location='Medellín, Colombia',target_currency='COP')
    assert repo.claim_execution(row.id,'owner')
    events=await collect(agent,row,decision=Decision(action='approve_deck',approved=True))
    result=next(event['data'] for event in events if event['type']=='result')
    assert result['preferences']['location']=='Tokyo, Japan'
    assert result['conversion_target_for_test']=='JPY'
