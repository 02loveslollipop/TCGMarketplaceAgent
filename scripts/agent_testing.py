"""Bounded live-agent test client. Never serialize HTTP headers or credentials."""
import asyncio
from collections import Counter
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
import json
import re
from pathlib import Path
import time
from urllib.parse import urlparse

import httpx

AUTH_URL='https://api.auth.tcg-marketplace.02labs.me'
CHAT_URL='https://api.chat.tcg-marketplace.02labs.me'

class AgentTestFailure(AssertionError):
    pass


def require(condition,message):
    if not condition:raise AgentTestFailure(message)


def scrub(value):
    if isinstance(value,dict):
        return {str(k):('[REDACTED]' if str(k).lower() in {'authorization','password','token','api_token','access_token','refresh_token','credential','secret'} else scrub(v)) for k,v in value.items()}
    if isinstance(value,list):return [scrub(v) for v in value]
    if isinstance(value,str):
        return re.sub(r'(?i)(?:tcg_api_[\w.-]+|bearer\s+[\w.-]+)', '[REDACTED]',value)
    return value


def card_counts(cards):
    counts=Counter()
    for card in cards:counts[(card['card_id'],card.get('condition'),card.get('language'),card.get('printing'))]+=card['quantity']
    return counts


def check_deck(cards,archetype):
    require(sum(c['quantity'] for c in cards)==60,'A deck must contain exactly 60 cards.')
    require(any(archetype.casefold() in c['name'].casefold() for c in cards),'The deck does not contain its requested attacker.')
    counts=Counter()
    basic=set()
    for card in cards:
        counts[card['name']]+=card['quantity']
        if card.get('basic_energy'):basic.add(card['name'])
    require(all(q<=4 or name in basic for name,q in counts.items()),'Deck violates the four-copy rule.')


def check_budget(result):
    cards=result.get('plan',{}).get('cards',[])
    require(bool(cards),'No verified cards were returned.')
    require(all(c.get('card_id') and c.get('name') and c['quantity']>0 for c in cards),'Invalid card identities or quantities.')
    offers=result.get('offers',[])
    require(bool(offers),'No supplier prices were returned.')
    require({o['supplier'] for o in offers}=={'TCGplayer','Cardmarket'},'Prices were not retrieved from both suppliers.')
    require(all(Decimal(o['price'])>0 and o.get('source',{}).get('url','').startswith('https://') and o['source'].get('retrieved_at') for o in offers),'A price lacks positive value, HTTPS evidence or retrieval date.')
    estimates=result.get('reference_estimates',[])
    budgets=result.get('budgets',[])
    require(bool(estimates or any(b['complete'] for b in budgets)),'No buying budget or price-guide estimate was returned.')
    requested=sum(c['quantity'] for c in cards)
    for row in estimates:
        require(row['requested_cards']==requested and 0<row['priced_cards']<=requested,'Price coverage is inconsistent.')
        require(Decimal(row['product_subtotal'])==sum((Decimal(line['line_total']) for line in row['lines']),Decimal(0)),'Price-guide arithmetic is inconsistent.')
        require(row.get('confirmed_total') is None,'Market references must not claim a confirmed purchase total.')
    for row in budgets:
        if not row['complete'] or not row['shipping_confirmed']:
            require(row.get('confirmed_total') is None,'An incomplete or shipping-unverified budget claims a final total.')
    conversion=result.get('currency_conversion',{})
    if conversion.get('status')=='available':
        require(conversion.get('as_of') and conversion.get('source',{}).get('url'),'Exchange rates lack date/source.')
        # This suite uses JPY so the aggregate conversion must round to whole yen.
        if conversion['target_currency']=='JPY':
            for row in estimates+budgets:
                expected=(Decimal(row['product_subtotal'])*Decimal(conversion['rates'][row['currency']])).quantize(Decimal(1),rounding=ROUND_HALF_UP)
                require(Decimal(row['converted']['product_subtotal'])==expected,'JPY conversion arithmetic is inconsistent.')


@dataclass(frozen=True)
class Scenario:
    name: str
    prompt: str
    kind: str='cards'
    expected: tuple=()
    archetype: str=''
    budget: int=0


SMOKE=[
 Scenario('exact-basket','Quote exactly 2 Mega Lucario ex, Mega Evolution #077 (me01-077), and 2 Ultra Ball, Mega Evolution #131 (me01-131). International Standard, English, Near Mint, any foil. These are specified singles, not a new deck. Compare TCGplayer and Cardmarket; show a sourced baseline budget if seller stock is unverified.',expected=(('me01-077',2),('me01-131',2))),
 Scenario('printing-question','I want one Gardevoir card, but have not chosen a set or printing. Ask me which printing to use before quoting anything, with selectable options. This is a specified single-card purchase, not a playable deck or a collection-building task.','question'),
]
EXTENDED=SMOKE+[
 Scenario('gardevoir-deck','Build a sourced 60-card Mega Gardevoir ex International Standard deck. English, Near Mint, any foil. Verify each printing and legality, ask for deck approval, then compare TCGplayer and Cardmarket and prepare the buying budget. Availability failures must not be treated as no stock.','deck',archetype='Mega Gardevoir ex'),
 Scenario('charizard-deck','Build a sourced 60-card Charizard ex International Standard deck. English, Near Mint, any foil. Verify each printing and legality, ask for deck approval, then compare TCGplayer and Cardmarket and prepare the buying budget.','deck',archetype='Charizard ex'),
 Scenario('gardevoir-collection','I want to make a Gardevoir collection and have a product budget of at most 150000 JPY, excluding unknown delivery/tax. Help me create a budget of cards I could buy. English, Near Mint, one copy of each Gardevoir printing, up to 12 different printings. I prefer full-art or illustration cards, but they do not have to be secret rare. Older cards are welcome; this is not a tournament deck. Research actual candidates, compare TCGplayer and Cardmarket, and select an affordable diverse collection without inventing stock or prices.','collection',budget=150000),
]


class LiveAgentClient:
    def __init__(self,token,*,model='gpt-6-luna',client=None,artifact_dir=None,run_label='local',max_tokens=600000,deadline=600,chat_url=CHAT_URL,auth_url=AUTH_URL):
        require(token.startswith('tcg_api_'),'A managed CI API token is required.')
        for url,expected in [(chat_url,CHAT_URL),(auth_url,AUTH_URL)]:
            parsed=urlparse(url)
            require(url==expected or (parsed.scheme=='http' and parsed.hostname in {'127.0.0.1','localhost'} and parsed.port==8080 and not parsed.username and not parsed.password),'Test credentials may only be sent to the production APIs or explicit local port 8080.')
        self.chat_url=chat_url.rstrip('/');self.auth_url=auth_url.rstrip('/')
        self._headers={'Authorization':'Bearer '+token}
        self.http=client or httpx.AsyncClient(timeout=httpx.Timeout(120,connect=30))
        self._owns_client=client is None
        self.model=model;self.directory=Path(artifact_dir) if artifact_dir else None
        self.run_label=re.sub(r'[^\w.-]','-',run_label)[:60]
        self.max_tokens=max_tokens;self.deadline=deadline;self.start_usage=0;self.reports=[]
        self.original_preferences=None

    async def request(self,method,path,body=None,*,auth=False):
        try:r=await self.http.request(method,(self.auth_url if auth else self.chat_url)+path,json=body,headers=self._headers)
        except httpx.HTTPError:raise AgentTestFailure('API connection failed; no request was retried.') from None
        require(r.status_code<400,f'{method} {path}: HTTP {r.status_code}')
        return r.json()

    async def prepare(self):
        session=await self.request('GET','/session',auth=True)
        require(session.get('principal_type')=='api','Live tests require an independent API principal.')
        models=await self.request('GET','/models')
        require(self.model in {m['id'] for m in models},'The test model is not allowed; no fallback was selected.')
        usage=await self.request('GET','/usage');self.start_usage=usage['total_tokens']
        require(not usage['in_progress'] and not usage['unverified_usage'],'The CI principal has an active/unverified model call.')
        require(usage['remaining_tokens']>=min(self.max_tokens,50000),'Insufficient CI quota; no model calls started.')
        p=await self.request('GET','/preferences')
        self.original_preferences={k:p[k] for k in ['ruleset','format','location','target_currency']}
        await self.request('PUT','/preferences',{'ruleset':'auto','format':'auto','location':'Tokyo, Japan (shopping guide)','target_currency':'JPY'})

    async def restore(self):
        try:
            if self.original_preferences is not None:await self.request('PUT','/preferences',self.original_preferences)
        finally:
            if self._owns_client:await self.http.aclose()

    def save(self,name,data):
        if self.directory:
            self.directory.mkdir(parents=True,exist_ok=True)
            path=self.directory/(name+'.json');path.write_text(json.dumps(scrub(data),indent=2));path.chmod(0o600)

    async def turn(self,path,payload,events):
        current=None;data=[]
        try:
            async with self.http.stream('POST',self.chat_url+path,json=payload,headers=self._headers) as response:
                require(response.status_code==200,f'Agent stream HTTP {response.status_code}; no start/resume retry was attempted.')
                async for line in response.aiter_lines():
                    if not line:
                        if current and data:
                            body=json.loads('\n'.join(data));events.append({'type':current,'data':body})
                            if current=='execution' and getattr(self,'current_case',None):
                                self.save(self.current_case+'-progress',{'execution_id':body['id'],'conversation_id':body['conversation_id'],'status':'streaming'})
                        current=None;data=[]
                    elif line.startswith('event:'):current=line[6:].strip()
                    elif line.startswith('data:'):data.append(line[5:].lstrip())
        except httpx.HTTPError:raise AgentTestFailure('Agent stream disconnected; execution was not restarted.') from None
        require(events and events[-1]['type']=='done','The SSE turn did not complete with a terminal event.')
        errors=[e for e in events if e['type']=='error']
        require(not errors,'The agent reported an execution error.')

    async def run(self,case):
        usage=await self.request('GET','/usage')
        require(usage['total_tokens']-self.start_usage<self.max_tokens,'Suite token budget reached; no new execution started.')
        require(not usage['in_progress'] and not usage['unverified_usage'],'A previous provider call has not settled.')
        events=[];execution=None;report={'case':case.name,'model':self.model,'status':'running'};started=time.monotonic()
        self.current_case=case.name
        try:
            async with asyncio.timeout(self.deadline):
                await self.turn('/executions',{'text':case.prompt,'model_id':self.model},events)
                execution=next(e['data'] for e in events if e['type']=='execution')
                report.update(execution)
                await self.request('PUT','/conversations/'+execution['conversation_id'],{'title':f'CI {self.run_label}: {case.name}'})
                approved=None
                for _ in range(3):
                    questions=[e['data'] for e in events if e['type']=='question']
                    results=[e['data'] for e in events if e['type']=='result']
                    if case.kind=='question':
                        require(not results and bool(questions),'Expected a clarification before pricing.')
                        q=questions[-1];require(q['kind']=='clarification' and len(q.get('options',[]))>=2,'Expected a clarification with selectable options.')
                        require(not any(e['type']=='tool' and e['data'].get('name') in {'baseline_prices','check_supplier_stock'} for e in events),'An unresolved printing was priced before clarification.')
                        await self.turn('/executions/'+execution['id']+'/resume',{'action':'cancel'},events)
                        report['status']='passed';return report
                    if results:break
                    require(bool(questions),'Execution finished without a result or supported question.')
                    q=questions[-1]
                    if q['kind']=='deck_approval' and case.kind=='deck':
                        approved=next(e['data']['cards'] for e in reversed(events) if e['type']=='cards')
                        check_deck(approved,case.archetype)
                        require(not any(e['type']=='tool' and e['data'].get('name') in {'baseline_prices','check_supplier_stock'} for e in events),'Deck pricing ran before approval.')
                        decision={'action':'approve_deck','approved':True}
                    elif q['kind']=='missing_cards':
                        require(bool(q.get('missing')),'Missing-stock question has no verified shortages.')
                        decision={'action':'keep_missing','approved':True}
                    else:raise AgentTestFailure('Unexpected clarification/review: '+q.get('question','')[:180])
                    await self.turn('/executions/'+execution['id']+'/resume',decision,events)
                results=[e['data'] for e in events if e['type']=='result'];require(bool(results),'No final buying result after bounded decisions.')
                result=results[-1];check_budget(result)
                if case.expected:
                    actual=Counter()
                    for card in result['plan']['cards']:actual[card['card_id']]+=card['quantity']
                    require(actual==Counter(dict(case.expected)),'The exact requested basket changed.')
                if case.kind=='deck':
                    check_deck(result['plan']['cards'],case.archetype)
                    require(approved is not None and result.get('deck_approval',{}).get('approved'),'Deck approval was omitted.')
                    require(card_counts(approved)==card_counts(result['plan']['cards']),'The deck changed after approval.')
                    require(result['legality']['status']=='verified','Deck legality remains unverified.')
                if case.kind=='collection':
                    summary=result.get('collection_summary',{})
                    require(result['plan'].get('purpose')=='collection','The collection was routed as a playable deck.')
                    require(not any(q['kind']=='deck_approval' for q in questions),'A collection incorrectly required deck approval.')
                    require(summary.get('status')=='selected' and summary.get('currency')=='JPY','No JPY collection selection was returned.')
                    require(Decimal(summary['product_subtotal'])<=case.budget,'Collection exceeds the product budget.')
                    require(len(result['plan']['cards'])>=3 and all(c['quantity']==1 and 'gardevoir' in c['name'].casefold() for c in result['plan']['cards']),'Collection lacks distinct requested Gardevoir printings.')
                    require(summary.get('preferred_selected',0)>0,'Full-art preference was not reflected in the collection.')
                if not result.get('stock_shortages'):
                    require(not any(q['kind']=='missing_cards' for q in questions),'Unverified availability caused a false missing-card question.')
                self.save(case.name+'-result',result)
                report.update(status='passed',cards=sum(c['quantity'] for c in result['plan']['cards']),printings=len(result['plan']['cards']),reference_prices=len(result['offers']),estimates=[{k:v for k,v in x.items() if k not in {'lines'}} for x in result.get('reference_estimates',[])])
                return report
        except TimeoutError:report['status']='failed';raise AgentTestFailure('Scenario deadline reached; the execution was not restarted.') from None
        except Exception:report['status']='failed';raise
        finally:
            if execution is None:
                execution=next((e['data'] for e in events if e['type']=='execution'),None)
                if execution:report.update(execution)
            report['elapsed_seconds']=round(time.monotonic()-started,1)
            report['tool_outcomes']=dict(Counter((e['data'].get('diagnostic') or {}).get('outcome','unspecified') for e in events if e['type']=='tool' and e['data'].get('status')!='loading'))
            # Keep only completed reasoning summaries and public tool metadata.
            self.save(case.name+'-report',report)
            self.save(case.name+'-events',[e for e in events if e['type']!='thinking' or e['data'].get('status')=='complete'])
            self.reports.append(report)
