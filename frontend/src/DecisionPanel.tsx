import {useState} from 'react';
import {Alert,Button,Checkbox,Container,FormField,Header,SpaceBetween,Textarea} from '@cloudscape-design/components';
import type {Decision,Question} from './contracts';

export function DecisionPanel({question,onDecision,busy}:{question:Question;onDecision:(decision:Decision)=>void;busy:boolean}) {
  const [text,setText]=useState(''),[approved,setApproved]=useState(false);
  const missing=question.kind==='missing_cards';
  return <Container header={<Header variant="h3">{missing?'Missing cards · Your decision':'Clarification'}</Header>}>
    <SpaceBetween size="m">
      <Alert type="info">{question.question}</Alert>
      {question.missing&&<>{question.missing.map((card,index)=><div key={`${card.card_id}-${index}`}>
        <div>{card.quantity} × {card.name}</div>
        {[card.set_name,card.number&&`#${card.number}`,card.condition,card.language,card.printing].filter(Boolean).join(' · ')&&
          <div>{[card.set_name,card.number&&`#${card.number}`,card.condition,card.language,card.printing].filter(Boolean).join(' · ')}</div>}
      </div>)}</>}
      {question.guidance&&<div style={{whiteSpace:'pre-wrap'}}>{question.guidance}</div>}
      <FormField label={missing?'Substitutes to research':'Your answer'}><Textarea data-testid="decision-answer-input" value={text} onChange={({detail})=>setText(detail.value)}/></FormField>
      {missing&&<Checkbox data-testid="missing-consent-checkbox" checked={approved} onChange={({detail})=>setApproved(detail.checked)}>I explicitly approve the action below for the missing cards listed above.</Checkbox>}
      <SpaceBetween size="s" direction="horizontal">
        {missing?<>
          <Button data-testid="substitute-submit-button" disabled={busy||!approved||!text.trim()} onClick={()=>onDecision({action:'substitute',text,approved:true})}>Research substitutes</Button>
          <Button data-testid="keep-missing-button" disabled={busy||!approved} onClick={()=>onDecision({action:'keep_missing',approved:true})}>Keep listed cards missing</Button>
        </>:<Button data-testid="clarification-submit-button" variant="primary" disabled={busy||!text.trim()} onClick={()=>onDecision({action:'clarify',text})}>Continue</Button>}
        <Button data-testid="decision-cancel-button" disabled={busy} onClick={()=>onDecision({action:'cancel'})}>Cancel execution</Button>
      </SpaceBetween>
    </SpaceBetween>
  </Container>;
}
