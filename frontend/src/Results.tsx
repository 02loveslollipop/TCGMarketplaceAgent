import {useState} from 'react';
import {Alert,Box,Button,Cards,ColumnLayout,Container,ExpandableSection,Header,KeyValuePairs,Link,SegmentedControl,SpaceBetween,StatusIndicator,Table,Tabs,TextFilter} from '@cloudscape-design/components';
import type {BudgetLine,Card,Legality,Missing,Result,Source} from './contracts';
import {safeHref} from './client';
import {Markdown} from './Markdown';
import {Price,ExchangeRateDetails} from './Currency';

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
  const [view,setView]=useState('cards'),[filter,setFilter]=useState('');
  const filtered=cards.filter(card=>[card.name,card.set_name,card.number,card.condition,card.language,card.printing].join(' ').toLowerCase().includes(filter.toLowerCase()));
  const collection=legality.applicable===false;
  const header=<Header variant="h3" counter={`(${cards.reduce((sum,card)=>sum+card.quantity,0)} cards)`} description={`${cards.length} requested printings. Quantities and variant preferences are preserved.`} actions={<SegmentedControl label={collection?'Collection view':'Deck view'} selectedId={view} onChange={({detail})=>setView(detail.selectedId)} options={[{id:'cards',text:'Cards'},{id:'table',text:'Table'}]}/>}>{collection?'Collection cards':'Deck list'}</Header>;
  const search=<TextFilter filteringText={filter} filteringAriaLabel="Find cards in deck" filteringPlaceholder="Find cards, sets or variants" countText={`${filtered.length} printings`} onChange={({detail})=>{setFilter(detail.filteringText);}}/>;
  const empty=<Box textAlign="center" padding="l"><SpaceBetween size="s"><Box fontWeight="bold">{filter?'No matching cards':'No cards in this result'}</Box>{filter&&<Button onClick={()=>{setFilter('');}}>Clear card filter</Button>}</SpaceBetween></Box>;
  return <SpaceBetween size="m">
    <StatusIndicator type={collection?'info':legality.status==='verified'?'success':'warning'}>{collection?'Collectible printings · tournament legality not required':`Format legality: ${legality.status}`}</StatusIndicator>
    {legality.issues.map((issue,index)=><Alert key={index} type="warning">{issue}</Alert>)}
    {view==='cards'?<Cards data-testid="card-results" header={header} filter={search} empty={empty} cardDefinition={{
      header:item=><Header variant="h3">{item.name}</Header>,
      sections:[{id:'image',content:item=>item.image_url?<img className="card-art" src={safeHref(item.image_url)} alt={`${item.name} card`} width="150" loading="lazy"/>:<Box>No image available</Box>},
        {id:'code',header:'Printing',content:item=>`${item.set_name} · ${item.number}`},
        {id:'quantity',header:'Quantity',content:item=>item.quantity},
        {id:'preferences',header:'Preferences',content:item=>`${item.condition} · ${item.language} · ${item.printing}`}]
    }} items={filtered} cardsPerRow={[{cards:1},{minWidth:600,cards:2},{minWidth:1000,cards:3}]} ariaLabels={{selectionGroupLabel:'Cards',itemSelectionLabel:(_,item)=>item.name}}/>:<Table data-testid="deck-table" header={header} filter={search} empty={empty} items={filtered} columnDefinitions={[
      {id:'name',header:'Card',cell:item=>item.name},{id:'code',header:'Code',cell:item=>`${item.set_name} ${item.number}`},
      {id:'quantity',header:'Quantity',cell:item=>item.quantity},{id:'variant',header:'Preferences',cell:item=>`${item.condition} · ${item.language} · ${item.printing}`}
    ]}/>}
    <Sources sources={[...sources,...legality.sources]}/>
  </SpaceBetween>;
}

export function BudgetResults({result}:{result:Result}) {
  const [priceView,setPriceView]=useState('converted');
  const conversion=result.currency_conversion;
  const collection=result.collection_summary;
  const original=priceView==='original';
  const purchasingBudgets=result.budgets.filter(budget=>!result.reference_estimates?.length||budget.complete||budget.lines.some(line=>line.covered>0));
  const estimates=result.reference_estimates||[];
  const money=(amount:string,currency:string,converted?:string|null)=><Price amount={amount} currency={currency} converted={converted} conversion={conversion} original={original}/>;
  return <SpaceBetween size="l">
    <Container header={<Header variant="h3" actions={conversion?.status==='available'?<SegmentedControl label="Price view" selectedId={priceView} onChange={({detail})=>setPriceView(detail.selectedId)} options={[{id:'converted',text:`${conversion.target_currency} estimates`},{id:'original',text:'Original currencies'}]}/>:undefined}>Buying budget</Header>}>
      <SpaceBetween size="m">
        <div className="chat-message-text"><Markdown text={result.recommendation||'Review the buying costs and coverage below.'}/></div>
        <Box color="text-body-secondary">{result.plan.format} · {result.plan.cards.reduce((sum,card)=>sum+card.quantity,0)} requested cards · {result.offers.length} retrieved prices</Box>
        <ExchangeRateDetails conversion={conversion}/>
      </SpaceBetween>
    </Container>
    {collection&&<Container header={<Header variant="h3" description="A selection from the researched candidate pool. This product budget excludes unknown delivery, taxes and fees.">Collection budget</Header>}><SpaceBetween size="m">
      <KeyValuePairs columns={3} items={[{label:'Product budget',value:`${collection.budget_amount} ${collection.currency}`},{label:'Selected collection estimate',value:collection.product_subtotal===null?'Unavailable':`${collection.product_subtotal} ${collection.currency}`},{label:'Remaining product budget',value:collection.remaining_budget===null?'Unknown':`${collection.remaining_budget} ${collection.currency}`},{label:'Selected printings',value:`${collection.selected_printings} of ${collection.researched_candidates} researched candidates`},{label:'Catalog art preference matches',value:collection.preferred_selected},{label:'Confirmed purchase total',value:'Unavailable'}]}/>
      {collection.limitations.map((text,index)=><Box key={index} color="text-body-secondary">{text}</Box>)}
      <ExchangeRateDetails conversion={collection.exchange}/>
      <Table items={collection.lines} empty={<Box>No affordable collection could be established from verified, convertible price references.</Box>} columnDefinitions={[{id:'card',header:'Selected printing',isRowHeader:true,cell:line=><SpaceBetween size="xxs"><Box>{line.name}</Box><Box color="text-body-secondary">{line.set_name} · #{line.number}</Box></SpaceBetween>},{id:'supplier',header:'Price-guide source',cell:line=>line.supplier},{id:'cost',header:'Estimated product cost',cell:line=><Price amount={line.original_line_total} currency={line.original_currency} converted={line.converted_line_total} conversion={{status:'available',target_currency:collection.currency}}/>},{id:'source',header:'Evidence',cell:line=><Link external href={safeHref(line.source.url)}>{line.source.title}</Link>}]}/>
      <ExpandableSection headerText={`Other researched candidates (${collection.excluded_candidates.length})`}><Table items={collection.excluded_candidates} columnDefinitions={[{id:'card',header:'Printing',isRowHeader:true,cell:line=>line.name},{id:'reason',header:'Selection limitation',cell:line=>line.reason}]}/></ExpandableSection>
    </SpaceBetween></Container>}
    {estimates.length>0&&<Container header={<Header variant="h3" description="Indicative card costs from price guides. Stock, condition, and language are unverified. Shipping, taxes, and fees are excluded.">{collection?'Supplier estimates for selected collection':'Estimated deck cost'}</Header>}>
      <ColumnLayout columns={2} variant="text-grid">{estimates.map(estimate=><SpaceBetween key={`${estimate.supplier}-${estimate.currency}`} size="m">
        <Header variant="h3">{estimate.supplier}</Header>
        <KeyValuePairs items={[
          {label:estimate.price_coverage_complete?'Estimated card subtotal':'Partial estimated card subtotal',value:money(estimate.product_subtotal,estimate.currency,estimate.converted?.product_subtotal)},
          {label:'Price coverage',value:`${estimate.priced_cards} of ${estimate.requested_cards} cards`},
          {label:'Purchase total',value:'Not confirmed'},
        ]}/>
        <ExpandableSection headerText="Card price estimates"><Table variant="embedded" items={estimate.lines} columnDefinitions={[
          {id:'card',header:'Card',cell:line=>`${line.quantity} × ${line.name}`},
          {id:'unit',header:'Unit price estimate',cell:line=>money(line.unit_price,estimate.currency,line.converted_unit_price)},
          {id:'line',header:'Estimated line cost',cell:line=>money(line.line_total,estimate.currency,line.converted_line_total)},
          {id:'source',header:'Source',cell:line=><Link external href={safeHref(line.source.url)}>{line.source.title}</Link>},
        ]}/></ExpandableSection>
      </SpaceBetween>)}</ColumnLayout>
    </Container>}
    <StatusIndicator type={collection?'info':result.legality.status==='verified'?'success':'warning'}>{collection?'Collectible printings · tournament legality not required':`Format legality: ${result.legality.status}`}</StatusIndicator>
    {result.legality.issues.map((issue,index)=><Alert key={index} type="warning">{issue}</Alert>)}
    {result.supplier_errors.map((error,index)=><Alert key={index} type="warning" header={error.supplier}>{error.message}</Alert>)}
    {!result.availability_unverified&&!result.stock_shortages&&result.missing.length>0&&<Alert type="warning" header="Missing quotations"><SpaceBetween size="xs">{result.missing.map((card,index)=><div key={`${card.card_id}-${index}`}>{card.quantity} × {card.name} · {variantDetails(card)}</div>)}</SpaceBetween></Alert>}
    {Boolean(result.stock_shortages?.length)&&<Alert type="warning" header="Verified listing shortfalls">The retrieved, matching listings do not cover {result.stock_shortages!.reduce((sum,card)=>sum+card.quantity,0)} requested cards. This does not establish that the whole market is out of stock.</Alert>}
    {Boolean(result.availability_unverified?.length)&&<Alert type="info" header="Availability unverified"><ExpandableSection headerText={`${result.availability_unverified!.length} printings need a stock check`}><SpaceBetween size="xs">{result.availability_unverified!.map((card,index)=><div key={`${card.card_id}-${index}`}>{card.quantity} × {card.name} · {variantDetails(card)}</div>)}</SpaceBetween></ExpandableSection>Baseline prices and product links remain available. An empty or blocked lookup is not proof of no stock.</Alert>}
    {Boolean(result.retrieval_diagnostics?.length)&&<ExpandableSection headerText="Supplier retrieval diagnostics"><Table items={result.retrieval_diagnostics!} columnDefinitions={[
      {id:'card',header:'Card ID',cell:row=>row.card_id},
      {id:'supplier',header:'Supplier / source',cell:row=>`${row.supplier} · ${row.layer}`},
      {id:'phase',header:'Stage',cell:row=>row.phase},
      {id:'outcome',header:'Outcome',cell:row=>row.outcome.replaceAll('_',' ')},
      {id:'status',header:'HTTP status',cell:row=>row.http_status??'—'},
      {id:'details',header:'Details',cell:row=>row.message},
      {id:'date',header:'Checked',cell:row=>new Date(row.retrieved_at).toLocaleString()},
    ]}/></ExpandableSection>}
    <Tabs ariaLabel="Budget result details" tabs={[
      {id:'budgets',label:`Budgets (${purchasingBudgets.length})`,content:<SpaceBetween size="m">
        <Box color="text-body-secondary">Purchase coverage uses verified seller listings. Converted amounts are estimates; a confirmed supplier total requires complete coverage and confirmed shipping.</Box>
        {!purchasingBudgets.length&&<Box padding="l" textAlign="center">No purchasing budgets could be calculated from verified seller listings. Price-guide estimates are shown separately when available.</Box>}
        {purchasingBudgets.map(budget=><ExpandableSection key={`${budget.supplier}-${budget.currency}`} data-testid="budget-section" variant="container" defaultExpanded headerText={`${budget.supplier} · ${conversion?.status==='available'&&!original&&budget.currency!==conversion.target_currency?`${conversion.target_currency} estimates (${budget.currency} supplier prices)`:budget.currency} · ${budget.complete?'Full coverage':'Incomplete coverage'}`}>
          <SpaceBetween size="m">
            <ColumnLayout columns={3} variant="text-grid">
              <KeyValuePairs items={[{label:'Product subtotal',value:money(budget.product_subtotal,budget.currency,budget.converted?.product_subtotal)}]}/>
              <KeyValuePairs items={[{label:'Known shipping',value:<SpaceBetween size="xxs"><Box>{budget.known_shipping===null?'Unknown':money(budget.known_shipping,budget.currency,budget.converted?.known_shipping)}</Box><StatusIndicator type={budget.shipping_confirmed?'success':'warning'}>{budget.shipping_confirmed?'Confirmed':'Unconfirmed'}</StatusIndicator></SpaceBetween>}]}/>
              <KeyValuePairs items={[{label:conversion?.status==='available'&&!original&&budget.currency!==conversion.target_currency?'Estimated equivalent of supplier total':'Confirmed final total',value:budget.confirmed_total===null?'Unavailable':money(budget.confirmed_total,budget.currency,budget.converted?.confirmed_total)}]}/>
            </ColumnLayout>
            <Table data-testid="budget-lines-table" items={budget.lines} columnDefinitions={[
              {id:'name',header:'Requested card / variant',cell:line=><div>{line.requested} × {line.name}<Box color="text-body-secondary">{variantDetails(line)}</Box></div>},
              {id:'covered',header:'Quoted',cell:line=>line.covered},
              {id:'buy',header:'Purchase links',cell:line=><SpaceBetween size="xs">{line.allocations.map(allocation=><SpaceBetween key={allocation.offer_id} size="xxs"><Link data-testid="purchase-link" external href={safeHref(allocation.url)}>{allocation.quantity} × {allocation.supplier}</Link>{money(allocation.unit_price,budget.currency,allocation.converted_unit_price)}</SpaceBetween>)}</SpaceBetween>},
            ]}/>
          </SpaceBetween>
        </ExpandableSection>)}
      </SpaceBetween>},
      {id:'deck',label:collection?'Collection':'Deck',content:<SpaceBetween size="m"><div className="chat-message-text"><Markdown text={result.plan.explanation}/></div><CardResults cards={result.plan.cards} legality={result.legality} sources={result.plan.sources}/></SpaceBetween>},
      {id:'offers',label:`Offers (${result.offers.length})`,content:<Table data-testid="offers-table" header={<Header variant="h3" counter={`(${result.offers.length})`}>Retrieved prices</Header>} items={result.offers} empty={<Box textAlign="center" padding="l">No quotations or price references were retrieved.</Box>} columnDefinitions={[
        {id:'name',header:'Card',cell:offer=>offer.name},{id:'supplier',header:'Supplier',cell:offer=>offer.supplier},
        {id:'price',header:'Unit price',cell:offer=><SpaceBetween size="xxs">{money(offer.price,offer.currency,offer.converted_price)}<Box color="text-body-secondary">{offer.price_kind==='reference'?'Price-guide reference':'Seller listing'}</Box></SpaceBetween>},
        {id:'stock',header:'Available quantity',cell:offer=>offer.quantity??'Unknown'},{id:'availability',header:'Availability',cell:offer=>offer.availability},
        {id:'variant',header:'Variant',cell:offer=>`${offer.condition??'Unknown condition'} · ${offer.language??'Unknown language'} · ${offer.printing??'Unknown finish'}`},
        {id:'source',header:'Source',cell:offer=><Link data-testid="offer-source-link" external href={safeHref(offer.source.url)}>{offer.supplier} · {new Date(offer.source.retrieved_at).toLocaleString()}</Link>},
      ]}/>},
      {id:'sources',label:'Sources',content:<Sources sources={[...result.plan.sources,...result.legality.sources,...result.offers.map(offer=>offer.source)]}/>},
    ]}/>
  </SpaceBetween>;
}
