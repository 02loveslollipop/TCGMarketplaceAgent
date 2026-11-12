import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Container,
  FormField,
  Header,
  Box,
  KeyValuePairs,
  ExpandableSection,
  RadioGroup,
  SpaceBetween,
  Textarea,
} from '@cloudscape-design/components';
import type { Decision, Question } from './contracts';
import { Markdown } from './Markdown';
import { settingsInputAttributes } from './inputSemantics';

export function DecisionPanel({
  question,
  onDecision,
  busy,
}: {
  question: Question;
  onDecision: (decision: Decision) => void;
  busy: boolean;
}) {
  const [text, setText] = useState('');
  const [selectedOption, setSelectedOption] = useState<string>('');
  const [approved, setApproved] = useState(false);
  const [editingDeck, setEditingDeck] = useState(false);
  const missing = question.kind === 'missing_cards';
  const deckApproval = question.kind === 'deck_approval';
  const heading = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    heading.current?.focus();
    if (question.options && question.options.length > 0) {
      setSelectedOption(question.options[0]);
    } else {
      setSelectedOption('');
    }
    setText('');
    setApproved(false);
    setEditingDeck(false);
  }, [question]);

  const hasOptions = Array.isArray(question.options) && question.options.length > 0;
  const isOther = selectedOption === '__other__';
  const canSubmitClarification =
    !busy &&
    (hasOptions
      ? isOther
        ? Boolean(text.trim())
        : Boolean(selectedOption)
      : Boolean(text.trim()));

  const handleClarifySubmit = () => {
    const finalOption = hasOptions && !isOther ? selectedOption : undefined;
    const finalText = text.trim() || (finalOption ? finalOption : '');
    onDecision({
      action: 'clarify',
      text: finalText,
      selected_option: finalOption,
    });
  };

  const radioItems = hasOptions
    ? [
        ...question.options!.map((opt) => ({
          value: opt,
          label: opt,
        })),
        {
          value: '__other__',
          label: 'Other (specify custom answer)',
        },
      ]
    : [];

  if(deckApproval)return <Container className="chat-decision-card" header={<Header variant="h2"><span className="chat-decision-heading" ref={heading} tabIndex={-1}>{editingDeck?'Request deck changes':'Approve this deck'}</span></Header>}>
    <div className="chat-decision-scroll" role="region" aria-label="Deck approval" tabIndex={0}><SpaceBetween size="s">
      <Box>{question.card_count??60} cards · {question.unique_cards??'—'} printings · {question.format}</Box>
      {editingDeck?<>
        <FormField label="Changes to this deck" description="The revised deck will need your approval before pricing.">
          <Textarea value={text} disabled={busy} rows={2} onChange={({detail})=>setText(detail.value)} nativeTextareaAttributes={settingsInputAttributes}/>
        </FormField>
        <SpaceBetween direction="horizontal" size="xs">
          <Button variant="primary" disabled={busy||!text.trim()} onClick={()=>onDecision({action:'revise_deck',text:text.trim()})}>Submit deck changes</Button>
          <Button variant="link" disabled={busy} onClick={()=>setEditingDeck(false)}>Back to approval</Button>
        </SpaceBetween>
      </>:<>
        <Box>Continue to supplier prices and your buying budget.</Box>
        <SpaceBetween direction="horizontal" size="xs">
          <Button variant="primary" disabled={busy} onClick={()=>onDecision({action:'approve_deck',approved:true})}>Approve and price this deck</Button>
          <Button disabled={busy} onClick={()=>setEditingDeck(true)}>Request changes</Button>
          <Button variant="link" disabled={busy} onClick={()=>onDecision({action:'cancel'})}>Cancel</Button>
        </SpaceBetween>
        <ExpandableSection headerText="Buying preferences"><KeyValuePairs columns={2} items={[
          {label:'Ruleset',value:question.ruleset||'Auto'},
          {label:'Location guide',value:question.location||'Not specified'},
          {label:'Target currency',value:question.target_currency||'Original supplier currencies'},
        ]}/></ExpandableSection>
      </>}
    </SpaceBetween></div>
  </Container>;

  return (
    <Container
      className="chat-decision-card"
      header={
        <Header variant="h2">
          <span className="chat-decision-heading" ref={heading} tabIndex={-1}>
            {deckApproval ? 'Approve this deck for pricing' : missing ? 'How should we handle the missing cards?' : 'One detail before continuing'}
          </span>
        </Header>
      }
    >
      <div className="chat-decision-scroll" role="region" aria-label={missing?'Missing card decisions':'Clarification details'} tabIndex={0}><SpaceBetween size="m">
        <Alert type="info">
          <Markdown content={question.question} />
        </Alert>

        {question.missing && (
          <div className="chat-decision-details">
            {question.missing.map((card, index) => (
              <div key={`${card.card_id}-${index}`}>
                <div>
                  {card.quantity} × {card.name}
                </div>
                {[
                  card.set_name,
                  card.number && `#${card.number}`,
                  card.condition,
                  card.language,
                  card.printing,
                ]
                  .filter(Boolean)
                  .join(' · ') && (
                  <div>
                    {[
                      card.set_name,
                      card.number && `#${card.number}`,
                      card.condition,
                      card.language,
                      card.printing,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {question.guidance && <Markdown content={question.guidance} />}

        {!deckApproval && !missing && hasOptions && (
          <FormField label="Suggested options" description="Select a recommended option or enter custom guidance below:">
            <RadioGroup
              value={selectedOption}
              onChange={({ detail }) => setSelectedOption(detail.value)}
              items={radioItems}
            />
          </FormField>
        )}

        {!deckApproval && (!hasOptions || isOther || missing) && (
          <FormField
            label={missing ? 'Substitutes to research' : hasOptions ? 'Specify custom answer' : 'Your answer'}
          >
            <Textarea
              data-testid="decision-answer-input"
              disabled={busy}
              rows={2}
              value={text}
              placeholder={hasOptions && isOther ? 'Describe your preferred cards, format, or ruleset...' : undefined}
              onChange={({ detail }) => setText(detail.value)}
              nativeTextareaAttributes={settingsInputAttributes as any}
            />
          </FormField>
        )}

        {missing && (
          <Checkbox
            data-testid="missing-consent-checkbox"
            checked={approved}
            disabled={busy}
            onChange={({ detail }) => setApproved(detail.checked)}
          >
            I explicitly approve the action below for the missing cards listed above.
          </Checkbox>
        )}

        {!deckApproval&&<SpaceBetween size="s" direction="horizontal">
          {missing ? (
            <>
              {question.actions.includes('substitute') && (
                <Button
                  data-testid="substitute-submit-button"
                  variant="primary"
                  disabled={busy || !approved || !text.trim()}
                  onClick={() => onDecision({ action: 'substitute', text, approved: true })}
                >
                  Research substitutes
                </Button>
              )}
              {question.actions.includes('keep_missing') && (
                <Button
                  data-testid="keep-missing-button"
                  disabled={busy || !approved}
                  onClick={() => onDecision({ action: 'keep_missing', approved: true })}
                >
                  Keep listed cards missing
                </Button>
              )}
            </>
          ) : (
            <Button
              data-testid="clarification-submit-button"
              variant="primary"
              disabled={!canSubmitClarification}
              onClick={handleClarifySubmit}
            >
              Continue
            </Button>
          )}
          {question.actions.includes('cancel') && (
            <Button
              data-testid="decision-cancel-button"
              variant="link"
              disabled={busy}
              onClick={() => onDecision({ action: 'cancel' })}
            >
              Cancel execution
            </Button>
          )}
        </SpaceBetween>}
      </SpaceBetween></div>
    </Container>
  );
}
