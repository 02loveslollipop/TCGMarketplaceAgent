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
