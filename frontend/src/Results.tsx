import {Alert,Box,Cards,ExpandableSection,Header,Link,SpaceBetween,StatusIndicator,Table} from '@cloudscape-design/components';
import type {BudgetLine,Card,Legality,Missing,Result,Source} from './contracts';
import {safeHref} from './client';

function variantDetails(card:BudgetLine|Missing):string {
  return [card.set_name,card.number&&`#${card.number}`,card.condition,card.language,card.printing].filter(Boolean).join(' · ') || 'Variant details unavailable';
}

export function Sources({sources}:{sources:Source[]}) {
  return <ExpandableSection data-testid="sources-section" headerText="Sources and retrieval dates"><SpaceBetween size="xs">
    {sources.map((source,index)=><Link key={`${source.url}-${index}`} data-testid="source-link" href={safeHref(source.url)} external>{source.title} · {new Date(source.retrieved_at).toLocaleString()}</Link>)}
  </SpaceBetween></ExpandableSection>;
}

export function CardResults({cards,legality,sources=[]}:{cards:Card[];legality:Legality;sources?:Source[]}) {
  return <SpaceBetween size="m">
    <StatusIndicator type={legality.status==='verified'?'success':'warning'}>Format legality: {legality.status}</StatusIndicator>
    {legality.issues.map((issue,index)=><Alert key={index} type="warning">{issue}</Alert>)}
    <Cards data-testid="card-results" cardDefinition={{
      header:item=><Header variant="h3">{item.name}</Header>,
      sections:[{id:'image',content:item=>item.image_url?<img src={safeHref(item.image_url)} alt={`${item.name} card`} width="150" loading="lazy"/>:<Box>No image available</Box>},
        {id:'code',header:'Printing',content:item=>`${item.set_name} · ${item.number}`},
        {id:'quantity',header:'Quantity',content:item=>item.quantity},
        {id:'preferences',header:'Preferences',content:item=>`${item.condition} · ${item.language} · ${item.printing}`}]
    }} items={cards} cardsPerRow={[{cards:1},{minWidth:600,cards:2},{minWidth:1000,cards:3}]} ariaLabels={{selectionGroupLabel:'Cards',itemSelectionLabel:(_,item)=>item.name}}/>
    <Table data-testid="deck-table" header={<Header>Card quantities</Header>} items={cards} columnDefinitions={[
      {id:'name',header:'Card',cell:item=>item.name},{id:'code',header:'Code',cell:item=>`${item.set_name} ${item.number}`},
      {id:'quantity',header:'Quantity',cell:item=>item.quantity}
    ]}/>
    <Sources sources={[...sources,...legality.sources]}/>
  </SpaceBetween>;
}

export function BudgetResults({result}:{result:Result}) {
  return <SpaceBetween size="m">
    <Box>{result.plan.explanation}</Box>
    <CardResults cards={result.plan.cards} legality={result.legality} sources={result.plan.sources}/>
    {result.supplier_errors.map((error,index)=><Alert key={index} type="warning" header={error.supplier}>{error.message}</Alert>)}
    <Table data-testid="offers-table" header={<Header>Retrieved offers</Header>} items={result.offers} empty={<Box>No comparable quotations were retrieved.</Box>} columnDefinitions={[
      {id:'name',header:'Card',cell:offer=>offer.name},{id:'supplier',header:'Supplier',cell:offer=>offer.supplier},
      {id:'price',header:'Unit price',cell:offer=>`${offer.price} ${offer.currency} (${offer.price_kind})`},
      {id:'stock',header:'Available quantity',cell:offer=>offer.quantity??'Unknown'},
      {id:'variant',header:'Variant',cell:offer=>`${offer.condition??'Unknown condition'} · ${offer.language??'Unknown language'} · ${offer.printing??'Unknown finish'}`},
      {id:'source',header:'Source',cell:offer=><Link data-testid="offer-source-link" external href={safeHref(offer.source.url)}>{offer.supplier} · {new Date(offer.source.retrieved_at).toLocaleString()}</Link>}
    ]}/>
    {result.budgets.map(budget=><ExpandableSection key={`${budget.supplier}-${budget.currency}`} data-testid="budget-section" defaultExpanded headerText={`${budget.supplier} · ${budget.currency} · ${budget.complete?'Full coverage':'Incomplete coverage'}`}>
      <SpaceBetween size="s">
        <Box>Product subtotal: {budget.product_subtotal} {budget.currency}</Box>
        <Box>Known shipping: {budget.known_shipping===null?'Unknown':`${budget.known_shipping} ${budget.currency}`}; {budget.shipping_confirmed?'confirmed':'unconfirmed'}</Box>
        <Box>Confirmed final total: {budget.confirmed_total===null?'Unavailable':`${budget.confirmed_total} ${budget.currency}`}</Box>
        <Table items={budget.lines} columnDefinitions={[
          {id:'name',header:'Card',cell:line=>line.name},{id:'variant',header:'Requested variant',cell:line=>variantDetails(line)},{id:'requested',header:'Requested',cell:line=>line.requested},
          {id:'covered',header:'Quoted',cell:line=>line.covered},{id:'buy',header:'Purchase links',cell:line=><SpaceBetween size="xs">{line.allocations.map(allocation=><Link data-testid="purchase-link" key={allocation.offer_id} external href={safeHref(allocation.url)}>{allocation.quantity} × {allocation.unit_price} · {allocation.supplier}</Link>)}</SpaceBetween>}
        ]}/>
      </SpaceBetween>
    </ExpandableSection>)}
    {result.missing.length>0&&<Alert type="warning" header="Missing quotations"><SpaceBetween size="xs">{result.missing.map((card,index)=><div key={`${card.card_id}-${index}`}>{card.quantity} × {card.name} · {variantDetails(card)}</div>)}</SpaceBetween></Alert>}
    <Box>{result.recommendation}</Box>
  </SpaceBetween>;
}
