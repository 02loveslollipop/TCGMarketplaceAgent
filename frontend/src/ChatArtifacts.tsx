import {ActionCard,Box,Icon,SpaceBetween,StatusIndicator} from '@cloudscape-design/components';
import type {Card,Legality,Result,Source} from './contracts';
import {safeHref} from './client';
import {BudgetResults,CardResults} from './Results';

export type ChatArtifact={id:string;kind:'budget';result:Result}|{id:string;kind:'deck';cards:Card[];legality:Legality;sources:Source[]};
export function artifactTitle(artifact:ChatArtifact){return artifact.kind==='budget'?'Deck and budget':'Deck preview';}
export function ArtifactContent({artifact}:{artifact:ChatArtifact}){
  return artifact.kind==='budget'?<BudgetResults key={artifact.id} result={artifact.result}/>:<CardResults key={artifact.id} cards={artifact.cards} legality={artifact.legality} sources={artifact.sources}/>;
}
export function ArtifactPreview({artifact,onOpen}:{artifact:ChatArtifact;onOpen:(artifact:ChatArtifact)=>void}){
  const cards=artifact.kind==='budget'?artifact.result.plan.cards:artifact.cards;
  const legality=artifact.kind==='budget'?artifact.result.legality:artifact.legality;
  const total=cards.reduce((sum,card)=>sum+card.quantity,0);
  const result=artifact.kind==='budget'?artifact.result:null;
  return <div className="chat-artifact-preview" data-testid="chat-artifact-preview"><ActionCard onClick={()=>onOpen(artifact)} ariaLabel={result?'Review deck and budget':'Review deck list'}>
    <SpaceBetween size="s">
      <Box variant="h3"><Icon name="file"/> {artifactTitle(artifact)}</Box>
      <Box color="text-body-secondary">{total} cards · {cards.length} printings{result?` · ${result.offers.length} offers`:""}</Box>
      <div className="chat-artifact-art" aria-hidden="true">{cards.slice(0,5).map((card,index)=>card.image_url&&<img key={`${card.card_id}-${index}`} src={safeHref(card.image_url)} alt="" width="44" height="62" loading="lazy"/>)}</div>
      <div className="chat-artifact-metadata"><StatusIndicator type={legality.status==='verified'?'success':'warning'}>Format legality: {legality.status}</StatusIndicator>{result&&<><span>{result.plan.format}</span><span>{result.budgets.length} budget options</span></>}</div>
      {result&&<Box color="text-body-secondary" fontSize="body-s">{result.missing.length?`${result.missing.reduce((sum,card)=>sum+card.quantity,0)} cards without quotations. `:''}{result.budgets.some(budget=>!budget.shipping_confirmed)?'Shipping remains unconfirmed.':'Open to review coverage and confirmed costs.'}</Box>}
      <Box fontWeight="bold">{result?'Review deck and budget':'Review deck list'} <Icon name="arrow-right"/></Box>
    </SpaceBetween>
  </ActionCard></div>;
}
