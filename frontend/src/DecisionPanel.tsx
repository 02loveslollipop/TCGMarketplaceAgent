import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Checkbox,Container,FormField,Header,SpaceBetween,Textarea} from '@cloudscape-design/components';
import type {Decision,Question} from './contracts';

export function DecisionPanel({question,onDecision,busy}:{question:Question;onDecision:(decision:Decision)=>void;busy:boolean}) {
  const [text,setText]=useState(''),[approved,setApproved]=useState(false);
  const missing=question.kind==='missing_cards';
  const heading=useRef<HTMLSpanElement>(null);
  useEffect(()=>{heading.current?.focus();},[question]);
  return <Container header={<Header variant="h2"><span className="chat-decision-heading" ref={heading} tabIndex={-1}>{missing?'How should we handle the missing cards?':'One detail before continuing'}</span></Header>}>
    <SpaceBetween size="m">
      <Alert type="info">{question.question}</Alert>
      {question.missing&&<><div className="chat-decision-details">{question.missing.map((card,index)=><div key={`${card.card_id}-${index}`}>
        <div>{card.quantity} × {card.name}</div>
        {[card.set_name,card.number&&`#${card.number}`,card.condition,card.language,card.printing].filter(Boolean).join(' · ')&&
          <div>{[card.set_name,card.number&&`#${card.number}`,card.condition,card.language,card.printing].filter(Boolean).join(' · ')}</div>}
      </div>)}</div></>}
      {question.guidance&&<div style={{whiteSpace:'pre-wrap'}}>{question.guidance}</div>}
      <FormField label={missing?'Substitutes to research':'Your answer'}><Textarea data-testid="decision-answer-input" disabled={busy} rows={2} value={text} onChange={({detail})=>setText(detail.value)}/></FormField>
      {missing&&<Checkbox data-testid="missing-consent-checkbox" checked={approved} disabled={busy} onChange={({detail})=>setApproved(detail.checked)}>I explicitly approve the action below for the missing cards listed above.</Checkbox>}
      <SpaceBetween size="s" direction="horizontal">
        {missing?<>
          {question.actions.includes('substitute')&&<Button data-testid="substitute-submit-button" variant="primary" disabled={busy||!approved||!text.trim()} onClick={()=>onDecision({action:'substitute',text,approved:true})}>Research substitutes</Button>}
          {question.actions.includes('keep_missing')&&<Button data-testid="keep-missing-button" disabled={busy||!approved} onClick={()=>onDecision({action:'keep_missing',approved:true})}>Keep listed cards missing</Button>}
        </>:<Button data-testid="clarification-submit-button" variant="primary" disabled={busy||!text.trim()} onClick={()=>onDecision({action:'clarify',text})}>Continue</Button>}
        {question.actions.includes('cancel')&&<Button data-testid="decision-cancel-button" variant="link" disabled={busy} onClick={()=>onDecision({action:'cancel'})}>Cancel execution</Button>}
      </SpaceBetween>
    </SpaceBetween>
  </Container>;
}
