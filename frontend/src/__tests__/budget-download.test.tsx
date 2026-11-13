import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { BudgetResults } from '../Results';
import { downloadBudgetExcel } from '../budgetExcel';
import type { Result } from '../contracts';

vi.mock('../budgetExcel', () => ({ downloadBudgetExcel: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const result: Result = {
  plan: { format: 'standard', cards: [], sources: [], explanation: '' },
  legality: { status: 'verified', issues: [], sources: [] },
  offers: [],
  budgets: [],
  missing: [],
  supplier_errors: [],
  recommendation: 'Saved budget.',
};

it('downloads the complete saved budget independently of the price-view toggle', async () => {
  vi.mocked(downloadBudgetExcel).mockResolvedValue();
  const user = userEvent.setup();
  render(<BudgetResults result={result} />);
  await user.click(screen.getByRole('button', { name: 'Download Excel' }));
  await waitFor(() =>
    expect(downloadBudgetExcel).toHaveBeenCalledExactlyOnceWith(result),
  );
  expect(
    await screen.findByText('Excel budget download started.'),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Download Excel' })).toBeEnabled();
});

it('shows an export error and permits a retry without restarting an execution', async () => {
  vi.mocked(downloadBudgetExcel)
    .mockRejectedValueOnce(new Error('Export unavailable'))
    .mockResolvedValueOnce();
  const user = userEvent.setup();
  render(<BudgetResults result={result} />);
  await user.click(screen.getByRole('button', { name: 'Download Excel' }));
  expect(
    await screen.findByText(
      'The Excel export could not be created. Try downloading again.',
    ),
  ).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Download Excel' }));
  expect(
    await screen.findByText('Excel budget download started.'),
  ).toBeInTheDocument();
  expect(downloadBudgetExcel).toHaveBeenCalledTimes(2);
});
