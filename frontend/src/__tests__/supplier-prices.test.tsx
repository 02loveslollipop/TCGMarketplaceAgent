import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { SupplierPriceEstimates } from '../SupplierPriceEstimates';
import type { ReferenceEstimate } from '../contracts';

const source = {
  url: 'https://www.tcgplayer.com/product/123',
  title: 'Recorded product',
  retrieved_at: '2026-11-13T00:00:00Z',
};
const lines = Array.from({ length: 30 }, (_, index) => ({
  card_id: `card-${index}`,
  name: `Card ${index}`,
  number: String(index).padStart(3, '0'),
  set_name: 'Recorded set',
  quantity: 2,
  unit_price: '0.04',
  line_total: '0.08',
  converted_unit_price: '7.07457703507837930870368382',
  converted_line_total: '14',
  source,
}));
const estimates: ReferenceEstimate[] = ['Cardmarket', 'TCGplayer'].map(
  (supplier, index) => ({
    supplier,
    currency: index ? 'USD' : 'EUR',
    product_subtotal: '2.40',
    priced_cards: index ? 58 : 60,
    requested_cards: 60,
    price_coverage_complete: !index,
    converted: {
      product_subtotal: '424',
      known_shipping: null,
      confirmed_total: null,
    },
    lines: index ? lines.slice(0, 29) : lines,
  }),
);
const props = {
  estimates,
  cards: [],
  conversion: { status: 'available' as const, target_currency: 'JPY' },
  original: false,
  collection: false,
};

it('keeps both supplier totals visible and shows every printing in one selected supplier table', () => {
  render(<SupplierPriceEstimates {...props} />);
  const summary = screen.getByRole('table', {
    name: 'Supplier price-guide summary',
  });
  expect(within(summary).getByText('60 of 60 cards')).toBeVisible();
  expect(within(summary).getByText('58 of 60 cards')).toBeVisible();
  expect(within(summary).getByText('Partial price coverage')).toBeVisible();
  expect(
    screen.getByRole('tab', { name: 'Cardmarket' }),
  ).toHaveAttribute('aria-selected', 'true');
  const table = screen.getByRole('table', {
    name: 'Cardmarket card price estimates',
  });
  expect(within(table).getAllByRole('row')).toHaveLength(31);
  expect(
    within(table).getByRole('rowheader', {
      name: /2 × Card 29 Recorded set · #029/,
    }),
  ).toBeVisible();
  expect(
    within(table).getAllByRole('link', {
      name: /View Cardmarket price source/,
    }),
  ).toHaveLength(30);
  expect(
    screen.queryByRole('table', { name: 'TCGplayer card price estimates' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/Next page/)).not.toBeInTheDocument();
});

it('makes supplier changes explicit from both the summary action and supplier tabs', async () => {
  const user = userEvent.setup();
  render(<SupplierPriceEstimates {...props} />);
  await user.click(
    screen.getByRole('button', { name: 'Show TCGplayer card prices in USD' }),
  );
  expect(
    screen.getByRole('tab', { name: 'TCGplayer' }),
  ).toHaveAttribute('aria-selected', 'true');
  expect(
    screen.getByRole('heading', {
      name: 'TCGplayer card prices (29 printings)',
    }),
  ).toBeVisible();
  expect(
    screen.queryByRole('table', { name: 'Cardmarket card price estimates' }),
  ).not.toBeInTheDocument();
  await user.click(
    screen.getByRole('tab', { name: 'Cardmarket' }),
  );
  expect(
    screen.getByRole('table', { name: 'Cardmarket card price estimates' }),
  ).toBeVisible();
});

it('filters by card code, clears an empty search, and retains the full supplier set', async () => {
  const user = userEvent.setup();
  render(<SupplierPriceEstimates {...props} />);
  const input = screen.getByRole('searchbox', {
    name: 'Find cards in Cardmarket prices',
  });
  await user.type(input, '#029');
  expect(
    within(
      screen.getByRole('table', { name: 'Cardmarket card price estimates' }),
    ).getAllByRole('row'),
  ).toHaveLength(2);
  await user.clear(input);
  await user.type(input, 'unrecorded');
  expect(screen.getByText('No matching cards.')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Clear card filter' }));
  expect(
    within(
      screen.getByRole('table', { name: 'Cardmarket card price estimates' }),
    ).getAllByRole('row'),
  ).toHaveLength(31);
});

it('labels per-card and line prices, bounds visible conversion precision and keeps saved values unchanged', () => {
  const view = render(<SupplierPriceEstimates {...props} />);
  let table = screen.getByRole('table', {
    name: 'Cardmarket card price estimates',
  });
  expect(within(table).getAllByText('Line cost')).toHaveLength(30);
  expect(within(table).getAllByText('Per card')).toHaveLength(30);
  expect(within(table).getAllByText('7.0746 JPY')).toHaveLength(30);
  expect(within(table).getAllByText('Original: 0.04 EUR')).toHaveLength(30);
  expect(lines[0].converted_unit_price).toBe('7.07457703507837930870368382');
  view.rerender(<SupplierPriceEstimates {...props} original />);
  table = screen.getByRole('table', {
    name: 'Cardmarket card price estimates',
  });
  expect(within(table).getAllByText('0.04 EUR')).toHaveLength(30);
  expect(
    within(table).getAllByText('Estimated equivalent: 7.0746 JPY'),
  ).toHaveLength(30);
});
