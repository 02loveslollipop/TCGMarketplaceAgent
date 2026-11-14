import { useState } from 'react';
import { useCollection } from '@cloudscape-design/collection-hooks';
import {
  Box,
  Button,
  Container,
  Header,
  KeyValuePairs,
  Link,
  SpaceBetween,
  Table,
  Tabs,
  TextFilter,
} from '@cloudscape-design/components';
import type { Card, CurrencyConversion, ReferenceEstimate } from './contracts';
import { safeHref } from './client';
import { Price } from './Currency';

type EstimateLine = ReferenceEstimate['lines'][number];

// Display only: preserve the saved precision for calculations and Excel export.
function displayConversion(amount?: string): string | undefined {
  if (amount === undefined || !Number.isFinite(Number(amount))) return amount;
  return Number(amount).toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function printing(line: EstimateLine, cards: Card[]) {
  const matches = cards.filter(
    (card) =>
      card.card_id === line.card_id &&
      (['condition', 'language', 'printing'] as const).every(
        (field) => !line[field] || line[field] === card[field],
      ),
  );
  const card = matches.length === 1 ? matches[0] : undefined;
  return (
    [
      line.set_name || card?.set_name,
      (line.number || card?.number) && `#${line.number || card?.number}`,
    ]
      .filter(Boolean)
      .join(' · ') || line.card_id
  );
}

function SupplierCards({
  estimate,
  cards,
  conversion,
  original,
}: {
  estimate: ReferenceEstimate;
  cards: Card[];
  conversion?: CurrencyConversion;
  original: boolean;
}) {
  const { items, collectionProps, filterProps, actions, filteredItemsCount } =
    useCollection(estimate.lines, {
      filtering: {
        filteringFunction: (line, query) =>
          [line.name, line.card_id, printing(line, cards)]
            .join(' ')
            .toLowerCase()
            .includes(query.toLowerCase()),
        empty: (
          <Box padding="m" textAlign="center">
            No card price estimates were recorded for this supplier.
          </Box>
        ),
        noMatch: (
          <Box padding="m" textAlign="center">
            <SpaceBetween size="s">
              <Box>No matching cards.</Box>
              <Button
                formAction="none"
                onClick={() => actions.setFiltering('')}
              >
                Clear card filter
              </Button>
            </SpaceBetween>
          </Box>
        ),
      },
      sorting: {},
    });
  return (
    <Table
      {...collectionProps}
      data-testid="supplier-card-prices"
      variant="borderless"
      wrapLines
      items={items}
      ariaLabels={{ tableLabel: `${estimate.supplier} card price estimates` }}
      header={
        <Header
          variant="h3"
          counter={`(${estimate.lines.length} printings)`}
          description={`${estimate.priced_cards} of ${estimate.requested_cards} requested cards have a price reference. Availability is unverified.`}
        >
          {estimate.supplier} card prices
        </Header>
      }
      filter={
        <TextFilter
          {...filterProps}
          filteringAriaLabel={`Find cards in ${estimate.supplier} prices`}
          filteringPlaceholder="Find cards by name or code"
          countText={`${filteredItemsCount} matching printings`}
        />
      }
      columnDefinitions={[
        {
          id: 'card',
          header: 'Card and source',
          isRowHeader: true,
          width: '52%',
          sortingField: 'name',
          ariaLabel: ({ sorted, descending }) =>
            `Card${sorted ? (descending ? ', sorted descending' : ', sorted ascending') : ', not sorted'}`,
          cell: (line) => (
            <SpaceBetween size="xs">
              <Box fontWeight="bold">
                {line.quantity} × {line.name}
              </Box>
              <Box color="text-body-secondary">{printing(line, cards)}</Box>
              <Link
                external
                href={safeHref(line.source.url)}
                ariaLabel={`View ${estimate.supplier} price source for ${line.name}, ${printing(line, cards)}`}
              >
                View price source
              </Link>
            </SpaceBetween>
          ),
        },
        {
          id: 'prices',
          header: 'Price estimates',
          cell: (line) => (
            <KeyValuePairs
              columns={1}
              items={[
                {
                  label: 'Line cost',
                  value: (
                    <Price
                      amount={line.line_total}
                      currency={estimate.currency}
                      converted={displayConversion(line.converted_line_total)}
                      conversion={conversion}
                      original={original}
                    />
                  ),
                },
                {
                  label: 'Per card',
                  value: (
                    <Box fontSize="body-s">
                      <Price
                        amount={line.unit_price}
                        currency={estimate.currency}
                        converted={displayConversion(line.converted_unit_price)}
                        conversion={conversion}
                        original={original}
                      />
                    </Box>
                  ),
                },
              ]}
            />
          ),
        },
      ]}
    />
  );
}

export function SupplierPriceEstimates({
  estimates,
  cards,
  conversion,
  original,
  collection,
}: {
  estimates: ReferenceEstimate[];
  cards: Card[];
  conversion?: CurrencyConversion;
  original: boolean;
  collection: boolean;
}) {
  const [selection, setSelection] = useState('');
  const id = (estimate: ReferenceEstimate) =>
    encodeURIComponent(JSON.stringify([estimate.supplier, estimate.currency]));
  const selected = estimates.some((estimate) => id(estimate) === selection)
    ? selection
    : estimates[0]
      ? id(estimates[0])
      : '';
  return (
    <Container
      header={
        <Header
          variant="h3"
          description="Indicative card costs from price guides. Stock, condition, and language are unverified. Shipping, taxes, and fees are excluded."
        >
          {collection
            ? 'Supplier estimates for selected collection'
            : 'Estimated deck cost'}
        </Header>
      }
    >
      <SpaceBetween size="m">
        <Table
          variant="borderless"
          wrapLines
          items={estimates}
          ariaLabels={{ tableLabel: 'Supplier price-guide summary' }}
          columnDefinitions={[
            {
              id: 'supplier',
              header: 'Supplier and coverage',
              isRowHeader: true,
              width: '52%',
              cell: (estimate) => (
                <SpaceBetween size="xxs">
                  <Button
                    formAction="none"
                    variant="inline-link"
                    ariaLabel={`Show ${estimate.supplier} card prices in ${estimate.currency}`}
                    onClick={() => setSelection(id(estimate))}
                  >
                    {estimate.supplier}
                  </Button>
                  <Box color="text-body-secondary">
                    {estimate.priced_cards} of {estimate.requested_cards} cards
                  </Box>
                  {!estimate.price_coverage_complete && (
                    <Box color="text-status-warning">
                      Partial price coverage
                    </Box>
                  )}
                </SpaceBetween>
              ),
            },
            {
              id: 'subtotal',
              header: 'Estimated card subtotal',
              cell: (estimate) => (
                <Price
                  amount={estimate.product_subtotal}
                  currency={estimate.currency}
                  converted={estimate.converted?.product_subtotal}
                  conversion={conversion}
                  original={original}
                />
              ),
            },
          ]}
        />
        <Box color="text-body-secondary">
          Purchase totals are not confirmed. Select a supplier to review all of
          its card prices. Per-card conversions are rounded to four decimal
          places for display; Excel retains the saved precision.
        </Box>
        <Tabs
          ariaLabel="Supplier card prices"
          activeTabId={selected}
          onChange={({ detail }) => setSelection(detail.activeTabId)}
          tabs={estimates.map((estimate) => ({
            id: id(estimate),
            label:
              estimates.filter((item) => item.supplier === estimate.supplier)
                .length > 1
                ? `${estimate.supplier} (${estimate.currency})`
                : estimate.supplier,
            content: (
              <SupplierCards
                key={id(estimate)}
                estimate={estimate}
                cards={cards}
                conversion={conversion}
                original={original}
              />
            ),
          }))}
        />
      </SpaceBetween>
    </Container>
  );
}
