import {ActionCard,Box,Icon,Link,SpaceBetween,StatusIndicator} from '@cloudscape-design/components';
import type {Card,Legality,Result,Source} from './contracts';
import {safeHref} from './client';
import {BudgetResults,CardResults} from './Results';
import {Price} from './Currency';

export type ChatArtifact={id:string;kind:'budget';result:Result}|{id:string;kind:'deck';cards:Card[];legality:Legality;sources:Source[];purpose?:string};
export function artifactTitle(artifact:ChatArtifact){const collection=artifact.kind==='budget'?Boolean(artifact.result.collection_summary):artifact.purpose==='collection'||artifact.legality.applicable===false;return collection?(artifact.kind==='budget'?'Collection and budget':'Collection candidates'):artifact.kind==='budget'?'Deck and budget':'Deck preview';}
export function ArtifactContent({artifact}:{artifact:ChatArtifact}){
  return artifact.kind==='budget'?<BudgetResults key={artifact.id} result={artifact.result}/>:<CardResults key={artifact.id} cards={artifact.cards} legality={artifact.legality} sources={artifact.sources}/>;
}
export function ArtifactPreview({artifact,onOpen}:{artifact:ChatArtifact;onOpen:(artifact:ChatArtifact)=>void}){
  const cards=artifact.kind==='budget'?artifact.result.plan.cards:artifact.cards;
  const legality=artifact.kind==='budget'?artifact.result.legality:artifact.legality;
  const total=cards.reduce((sum,card)=>sum+card.quantity,0);
  const result=artifact.kind==='budget'?artifact.result:null;
  const purchasing=result?.budgets.filter(budget=>budget.complete||budget.lines.some(line=>line.covered>0))||[];
  const quoted=purchasing.find(budget=>budget.complete&&budget.supplier==='combined')||purchasing.find(budget=>budget.complete);
  const estimate=result?.reference_estimates?.find(estimate=>estimate.price_coverage_complete)||result?.reference_estimates?.[0];
  const shortfalls=result?.stock_shortages?.reduce((sum,card)=>sum+card.quantity,0)||0;
  const unverified=result?.availability_unverified?.reduce((sum,card)=>sum+card.quantity,0)||0;
  const inventoryNotice=[shortfalls?`${shortfalls} card${shortfalls===1?'':'s'} with confirmed listing shortfalls.`:'',unverified?`${unverified} card${unverified===1?'':'s'} with unverified seller availability.`:''].filter(Boolean).join(' ');
  const missingNotice=inventoryNotice||(result?.missing.length&&!estimate?`${result.missing.reduce((sum,card)=>sum+card.quantity,0)} cards without quotations.`:'');
  const collection=legality.applicable===false;
  return <div className="chat-artifact-preview" data-testid="chat-artifact-preview"><ActionCard onClick={()=>onOpen(artifact)} ariaLabel={collection?'Review collection':result?'Review deck and budget':'Review deck list'}>
    <SpaceBetween size="s">
      <Box variant="h3"><Icon name="file"/> {artifactTitle(artifact)}</Box>
      <Box color="text-body-secondary">{total} cards · {cards.length} printings{result?` · ${result.offers.length} offers`:""}</Box>
      <div className="chat-artifact-art" aria-hidden="true">{cards.slice(0,5).map((card,index)=>card.image_url&&<img key={`${card.card_id}-${index}`} src={safeHref(card.image_url)} alt="" width="44" height="62" loading="lazy"/>)}</div>
      <div className="chat-artifact-metadata"><StatusIndicator type={collection?'info':legality.status==='verified'?'success':'warning'}>{collection?'Collection · play legality not required':`Format legality: ${legality.status}`}</StatusIndicator>{result&&<><span>{result.plan.format}</span><span>{purchasing.length} purchasing budgets{result.reference_estimates?.length?` · ${result.reference_estimates.length} price-guide estimates`:''}</span></>}</div>
      {result?.collection_summary?.product_subtotal&&<Box fontWeight="bold">Collection estimate: {result.collection_summary.product_subtotal} {result.collection_summary.currency}</Box>}
      {result&&!collection&&(quoted||estimate)&&<SpaceBetween size="xxs"><Box color="text-body-secondary">{quoted?'Quoted card subtotal':estimate?.price_coverage_complete?'Estimated deck cost':'Partial deck estimate'} · {(quoted||estimate)!.supplier}</Box><Price amount={(quoted||estimate)!.product_subtotal} currency={(quoted||estimate)!.currency} converted={(quoted||estimate)!.converted?.product_subtotal} conversion={result.currency_conversion}/></SpaceBetween>}
      {result&&<Box color="text-body-secondary" fontSize="body-s">{missingNotice&&`${missingNotice} `}{!quoted&&estimate?'Price-guide estimate. Stock and delivery remain unverified.':result.budgets.some(budget=>!budget.shipping_confirmed)?'Shipping remains unconfirmed.':'Open to review coverage and confirmed costs.'}</Box>}
      <Box fontWeight="bold">{collection?'Review collection':result?'Review deck and budget':'Review deck list'} <Icon name="arrow-right"/></Box>
    </SpaceBetween>
  </ActionCard>{result?.currency_conversion?.status==='available'&&result.currency_conversion.source&&<Box margin={{top:'xxs'}} fontSize="body-s" color="text-body-secondary">Indicative conversion · <Link external href={safeHref(result.currency_conversion.source.url)}>{result.currency_conversion.source.title}</Link></Box>}</div>;
}
