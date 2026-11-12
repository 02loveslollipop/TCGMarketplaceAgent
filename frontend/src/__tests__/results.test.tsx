import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, it} from 'vitest';
import {BudgetResults} from '../Results';
import type {Result} from '../contracts';

it('renders markdown in recommendation and plan explanation', async () => {
  const user = userEvent.setup();
  const testResult: Result = {
    plan: {
      format: 'standard',
      cards: [],
      sources: [],
      explanation: '### Strategy Overview\n\nThis is a **competitive** deck strategy.',
    },
    legality: {status: 'verified', issues: [], sources: []},
    offers: [],
    budgets: [],
    missing: [],
    supplier_errors: [],
    recommendation: '**Optimal Budget**: Buy from *TCGplayer* for best prices.',
  };

  render(<BudgetResults result={testResult} />);

  // Recommendation renders Markdown strong and emphasis tags
  const recBold = screen.getByText('Optimal Budget');
  expect(recBold.tagName).toBe('STRONG');
  const recItalic = screen.getByText('TCGplayer');
  expect(recItalic.tagName).toBe('EM');

  // Switch to Deck tab
  const deckTab = screen.getByRole('tab', {name: 'Deck'});
  await user.click(deckTab);

  // Deck explanation renders Markdown heading and strong tag
  const heading = screen.getByRole('heading', {level: 3, name: 'Strategy Overview'});
  expect(heading).toBeInTheDocument();
  const expBold = screen.getByText('competitive');
  expect(expBold.tagName).toBe('STRONG');
});

it('shows every printing without pagination in both deck views and preserves filtering', async()=>{
  const {CardResults}=await import('../Results');
  const user=userEvent.setup();
  const cards=Array.from({length:30},(_,index)=>({card_id:`fixture-${index}`,name:`Synthetic card ${index}`,quantity:2,set_name:'Fixture',number:String(index),condition:'NM',language:'English',printing:'any'}));
  render(<CardResults cards={cards} legality={{status:'verified',issues:[],sources:[]}}/>);
  expect(screen.getByRole('heading',{name:'Deck list (60 cards)'})).toBeInTheDocument();
  expect(screen.getByRole('heading',{name:'Synthetic card 29'})).toBeInTheDocument();
  expect(screen.queryByLabelText('Next page of cards')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Table'}));
  expect(screen.getByRole('cell',{name:'Synthetic card 29'})).toBeInTheDocument();
  expect(screen.getAllByRole('row')).toHaveLength(31);
  await user.type(screen.getByRole('searchbox',{name:'Find cards in deck'}),'card 29');
  expect(screen.getAllByRole('row')).toHaveLength(2);
  expect(screen.queryByRole('cell',{name:'Synthetic card 0'})).not.toBeInTheDocument();
});

it('distinguishes blocked retrieval from stock shortages in the budget and diagnostics',async()=>{
  const user=userEvent.setup();
  render(<BudgetResults result={{
    plan:{format:'standard',cards:[],sources:[],explanation:''},legality:{status:'unverified',issues:[],sources:[]},offers:[],budgets:[],missing:[{card_id:'fixture-1',name:'Synthetic card',quantity:2}],supplier_errors:[],recommendation:'Baseline estimate only.',
    stock_shortages:[],availability_unverified:[{card_id:'fixture-1',name:'Synthetic card',quantity:2}],
    retrieval_diagnostics:[{supplier:'TCGplayer',card_id:'fixture-1',phase:'availability',layer:'apify',outcome:'blocked',http_status:403,message:'Access blocked; availability is unverified.',retrieved_at:'2026-11-13T00:00:00Z'}],
  }}/>);
  expect(screen.getByText('Availability unverified')).toBeInTheDocument();
  expect(screen.queryByText('Verified listing shortfalls')).not.toBeInTheDocument();
  expect(screen.queryByText('Missing quotations')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Supplier retrieval diagnostics'}));
  expect(screen.getByRole('cell',{name:'blocked'})).toBeInTheDocument();
  expect(screen.getByRole('cell',{name:'403'})).toBeInTheDocument();
  expect(screen.getByRole('cell',{name:'TCGplayer · apify'})).toBeInTheDocument();
});
