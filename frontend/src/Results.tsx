import {useState} from 'react';
import {Alert,Box,Button,Cards,ColumnLayout,Container,ExpandableSection,Header,KeyValuePairs,Link,Pagination,SegmentedControl,SpaceBetween,StatusIndicator,Table,Tabs,TextFilter} from '@cloudscape-design/components';
import type {BudgetLine,Card,Legality,Missing,Result,Source} from './contracts';
import {safeHref} from './client';
import {Markdown} from './Markdown';

function variantDetails(card:BudgetLine|Missing):string {
  return [card.set_name,card.number&&`#${card.number}`,card.condition,card.language,card.printing].filter(Boolean).join(' · ') || 'Variant details unavailable';
}

export function Sources({sources}:{sources:Source[]}) {
  const unique=sources.filter((source,index)=>sources.findIndex(item=>item.url===source.url&&item.retrieved_at===source.retrieved_at)===index);
  return <ExpandableSection data-testid="sources-section" headerText={`Sources and retrieval dates (${unique.length})`}><SpaceBetween size="xs">
    {unique.length?unique.map((source,index)=><Link key={`${source.url}-${index}`} data-testid="source-link" href={safeHref(source.url)} external>{source.title} · {new Date(source.retrieved_at).toLocaleString()}</Link>):<Box color="text-body-secondary">No sources were recorded for this result.</Box>}
  </SpaceBetween></ExpandableSection>;
}

export function CardResults({cards,legality,sources=[]}:{cards:Card[];legality:Legality;sources?:Source[]}) {
  const [view,setView]=useState('cards'),[filter,setFilter]=useState(''),[page,setPage]=useState(1);
  const filtered=cards.filter(card=>[card.name,card.set_name,card.number,card.condition,card.language,card.printing].join(' ').toLowerCase().includes(filter.toLowerCase()));
  const currentPage=Math.min(page,Math.max(1,Math.ceil(filtered.length/12)));
  const items=filtered.slice((currentPage-1)*12,currentPage*12);
  const header=<Header variant="h3" counter={`(${cards.reduce((sum,card)=>sum+card.quantity,0)} cards)`} description={`${cards.length} requested printings. Quantities and variant preferences are preserved.`} actions={<SegmentedControl label="Deck view" selectedId={view} onChange={({detail})=>setView(detail.selectedId)} options={[{id:'cards',text:'Cards'},{id:'table',text:'Table'}]}/>}>Deck list</Header>;
  const search=<TextFilter filteringText={filter} filteringAriaLabel="Find cards in deck" filteringPlaceholder="Find cards, sets or variants" countText={`${filtered.length} printings`} onChange={({detail})=>{setFilter(detail.filteringText);setPage(1);}}/>;
  const pagination=<Pagination currentPageIndex={currentPage} pagesCount={Math.max(1,Math.ceil(filtered.length/12))} onChange={({detail})=>setPage(detail.currentPageIndex)} ariaLabels={{nextPageLabel:'Next page of cards',previousPageLabel:'Previous page of cards',pageLabel:page=>`Card page ${page}`}}/>;
  const empty=<Box textAlign="center" padding="l"><SpaceBetween size="s"><Box fontWeight="bold">{filter?'No matching cards':'No cards in this result'}</Box>{filter&&<Button onClick={()=>{setFilter('');setPage(1);}}>Clear card filter</Button>}</SpaceBetween></Box>;
  return <SpaceBetween size="m">
    <StatusIndicator type={legality.status==='verified'?'success':'warning'}>Format legality: {legality.status}</StatusIndicator>
    {legality.issues.map((issue,index)=><Alert key={index} type="warning">{issue}</Alert>)}
    {view==='cards'?<Cards data-testid="card-results" header={header} filter={search} pagination={pagination} empty={empty} cardDefinition={{
      header:item=><Header variant="h3">{item.name}</Header>,
      sections:[{id:'image',content:item=>item.image_url?<img className="card-art" src={safeHref(item.image_url)} alt={`${item.name} card`} width="150" loading="lazy"/>:<Box>No image available</Box>},
        {id:'code',header:'Printing',content:item=>`${item.set_name} · ${item.number}`},
        {id:'quantity',header:'Quantity',content:item=>item.quantity},
        {id:'preferences',header:'Preferences',content:item=>`${item.condition} · ${item.language} · ${item.printing}`}]
    }} items={items} cardsPerRow={[{cards:1},{minWidth:600,cards:2},{minWidth:1000,cards:3}]} ariaLabels={{selectionGroupLabel:'Cards',itemSelectionLabel:(_,item)=>item.name}}/>:<Table data-testid="deck-table" header={header} filter={search} pagination={pagination} empty={empty} items={items} columnDefinitions={[
      {id:'name',header:'Card',cell:item=>item.name},{id:'code',header:'Code',cell:item=>`${item.set_name} ${item.number}`},
      {id:'quantity',header:'Quantity',cell:item=>item.quantity},{id:'variant',header:'Preferences',cell:item=>`${item.condition} · ${item.language} · ${item.printing}`}
    ]}/>}
    <Sources sources={[...sources,...legality.sources]}/>
  </SpaceBetween>;
}

export function BudgetResults({result}:{result:Result}) {
  return <SpaceBetween size="l">
    <Container header={<Header variant="h3">Recommendation</Header>}><SpaceBetween size="s"><div className="chat-message-text"><Markdown text={result.recommendation||'Review the quotations and coverage below.'}/></div><Box color="text-body-secondary">{result.plan.format} · {result.plan.cards.reduce((sum,card)=>sum+card.quantity,0)} requested cards · {result.offers.length} retrieved offers</Box></SpaceBetween></Container>
    <StatusIndicator type={result.legality.status==='verified'?'success':'warning'}>Format legality: {result.legality.status}</StatusIndicator>
    {result.legality.issues.map((issue,index)=><Alert key={index} type="warning">{issue}</Alert>)}
    {result.supplier_errors.map((error,index)=><Alert key={index} type="warning" header={error.supplier}>{error.message}</Alert>)}
    {result.missing.length>0&&<Alert type="warning" header="Missing quotations"><SpaceBetween size="xs">{result.missing.map((card,index)=><div key={`${card.card_id}-${index}`}>{card.quantity} × {card.name} · {variantDetails(card)}</div>)}</SpaceBetween></Alert>}
    <Tabs ariaLabel="Budget result details" tabs={[
      {id:'budgets',label:`Budgets (${result.budgets.length})`,content:<SpaceBetween size="m">
        <Box color="text-body-secondary">Compare within a currency. A final total is available only when all costs are confirmed.</Box>
        {!result.budgets.length&&<Box padding="l" textAlign="center">No purchasing budgets could be calculated from the retrieved offers.</Box>}
        {result.budgets.map(budget=><ExpandableSection key={`${budget.supplier}-${budget.currency}`} data-testid="budget-section" variant="container" defaultExpanded headerText={`${budget.supplier} · ${budget.currency} · ${budget.complete?'Full coverage':'Incomplete coverage'}`}>
          <SpaceBetween size="m">
            <ColumnLayout columns={3} variant="text-grid">
              <KeyValuePairs items={[{label:'Product subtotal',value:`${budget.product_subtotal} ${budget.currency}`}]} />
              <KeyValuePairs items={[{label:'Known shipping',value:<SpaceBetween size="xxs"><Box>{budget.known_shipping===null?'Unknown':`${budget.known_shipping} ${budget.currency}`}</Box><StatusIndicator type={budget.shipping_confirmed?'success':'warning'}>{budget.shipping_confirmed?'Confirmed':'Unconfirmed'}</StatusIndicator></SpaceBetween>}]} />
              <KeyValuePairs items={[{label:'Confirmed final total',value:budget.confirmed_total===null?'Unavailable':`${budget.confirmed_total} ${budget.currency}`}]} />
            </ColumnLayout>
            <Table variant="embedded" items={budget.lines} columnDefinitions={[
              {id:'name',header:'Card',cell:line=>line.name},{id:'variant',header:'Requested variant',cell:line=>variantDetails(line)},{id:'requested',header:'Requested',cell:line=>line.requested},
              {id:'covered',header:'Quoted',cell:line=>line.covered},{id:'buy',header:'Purchase links',cell:line=><SpaceBetween size="xs">{line.allocations.map(allocation=><Link data-testid="purchase-link" key={allocation.offer_id} external href={safeHref(allocation.url)}>{allocation.quantity} × {allocation.unit_price} · {allocation.supplier}</Link>)}</SpaceBetween>}
            ]}/>
          </SpaceBetween>
        </ExpandableSection>)}
      </SpaceBetween>},
      {id:'deck',label:'Deck',content:<SpaceBetween size="m"><div className="chat-message-text"><Markdown text={result.plan.explanation}/></div><CardResults cards={result.plan.cards} legality={result.legality} sources={result.plan.sources}/></SpaceBetween>},
      {id:'offers',label:`Offers (${result.offers.length})`,content:<Table data-testid="offers-table" header={<Header variant="h3" counter={`(${result.offers.length})`}>Retrieved offers</Header>} items={result.offers} empty={<Box textAlign="center" padding="l">No comparable quotations were retrieved.</Box>} columnDefinitions={[
        {id:'name',header:'Card',cell:offer=>offer.name},{id:'supplier',header:'Supplier',cell:offer=>offer.supplier},
        {id:'price',header:'Unit price',cell:offer=>`${offer.price} ${offer.currency} (${offer.price_kind})`},
        {id:'stock',header:'Available quantity',cell:offer=>offer.quantity??'Unknown'},{id:'availability',header:'Availability',cell:offer=>offer.availability},
        {id:'variant',header:'Variant',cell:offer=>`${offer.condition??'Unknown condition'} · ${offer.language??'Unknown language'} · ${offer.printing??'Unknown finish'}`},
        {id:'source',header:'Source',cell:offer=><Link data-testid="offer-source-link" external href={safeHref(offer.source.url)}>{offer.supplier} · {new Date(offer.source.retrieved_at).toLocaleString()}</Link>}
      ]}/>},
      {id:'sources',label:'Sources',content:<Sources sources={[...result.plan.sources,...result.legality.sources,...result.offers.map(offer=>offer.source)]}/>}
    ]}/>
  </SpaceBetween>;
}
