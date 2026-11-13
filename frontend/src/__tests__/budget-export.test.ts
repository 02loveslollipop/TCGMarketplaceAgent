// @vitest-environment node
import ExcelJS from 'exceljs';
import { expect, it } from 'vitest';
import { createBudgetWorkbook } from '../budgetExcel';
import type { Result } from '../contracts';

const card = {
  card_id: 'me01-077',
  name: 'Mega Lucario ex',
  quantity: 2,
  set_name: 'Mega Evolution',
  number: '077',
  condition: 'Near Mint',
  language: 'English',
  printing: 'Holofoil',
};
const cm = {
  url: 'https://www.cardmarket.com/en/Pokemon/Products/Singles?idProduct=123',
  title: 'Cardmarket product',
  retrieved_at: '2026-11-13T00:00:00Z',
};
const tcg = {
  ...cm,
  url: 'https://www.tcgplayer.com/product/123',
  title: 'TCGplayer product',
};
const rateSource = {
  url: 'https://www.exchangerate-api.com',
  title: 'Rates By Exchange Rate API',
};
function fixture(): Result {
  return {
    plan: { format: 'standard', cards: [card], sources: [], explanation: '' },
    legality: { status: 'verified', issues: [], sources: [] },
    offers: [],
    budgets: [],
    missing: [],
    supplier_errors: [],
    recommendation: 'Compare both price guides.',
    reference_estimates: [
      {
        supplier: 'Cardmarket',
        currency: 'EUR',
        product_subtotal: '3.60',
        priced_cards: 2,
        requested_cards: 2,
        price_coverage_complete: true,
        converted: {
          product_subtotal: '639',
          known_shipping: null,
          confirmed_total: null,
        },
        lines: [
          {
            ...card,
            unit_price: '1.80',
            line_total: '3.60',
            converted_unit_price: '319.5',
            converted_line_total: '639',
            source: cm,
          },
        ],
      },
      {
        supplier: 'TCGplayer',
        currency: 'USD',
        product_subtotal: '2.60',
        priced_cards: 2,
        requested_cards: 2,
        price_coverage_complete: true,
        converted: {
          product_subtotal: '416',
          known_shipping: null,
          confirmed_total: null,
        },
        lines: [
          {
            ...card,
            unit_price: '1.30',
            line_total: '2.60',
            converted_unit_price: '208',
            converted_line_total: '416',
            source: tcg,
          },
        ],
      },
    ],
    currency_conversion: {
      status: 'available',
      target_currency: 'JPY',
      rates: { EUR: '177.5', USD: '160' },
      as_of: '2026-11-13T00:02:00Z',
      retrieved_at: '2026-11-13T00:04:00Z',
      source: rateSource,
    },
  };
}
function records(
  sheet: ExcelJS.Worksheet,
): Record<string, ExcelJS.CellValue>[] {
  const headers = sheet.getRow(4);
  const rows: Record<string, ExcelJS.CellValue>[] = [];
  for (let row = 5; row <= sheet.rowCount; row++) {
    const record: Record<string, ExcelJS.CellValue> = {};
    headers.eachCell((cell, column) => {
      record[String(cell.value)] = sheet.getCell(row, column).value;
    });
    rows.push(record);
  }
  return rows;
}

it('writes a real XLSX with card codes, both suppliers, exact saved conversions and clickable publication links', async () => {
  const workbook = createBudgetWorkbook(
    fixture(),
    new Date('2026-11-13T05:00:00Z'),
  );
  const bytes = await workbook.xlsx.writeBuffer();
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(bytes);
  expect(restored.worksheets.map((sheet) => sheet.name)).toEqual([
    'Cards',
    'Totals',
    'Rates and notes',
  ]);
  const rows = records(restored.getWorksheet('Cards')!);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    'Card name': card.name,
    'Set and card code': 'Mega Evolution · #077',
    'Catalog ID': 'me01-077',
    'Requested quantity': 2,
    Supplier: 'Cardmarket',
    'Original currency': 'EUR',
    'Original unit price': 1.8,
    'Original line cost': 3.6,
    'Converted currency': 'JPY',
    'Converted unit estimate': 319.5,
    'Converted line estimate': 639,
    'Rate: target per 1 original': 177.5,
    'Exchange-rate date': '2026-11-13T00:02:00Z',
    'Product or listing page': { hyperlink: cm.url },
    'Price retrieved at': cm.retrieved_at,
    Availability: 'Unverified',
  });
  expect(rows[1]).toMatchObject({
    Supplier: 'TCGplayer',
    'Original unit price': 1.3,
    'Converted line estimate': 416,
    'Product or listing page': { hyperlink: tcg.url },
  });
  const totals = records(restored.getWorksheet('Totals')!);
  expect(totals[0]).toMatchObject({
    'Known shipping': 'Unknown',
    'Confirmed supplier total': 'Not confirmed',
    'Converted product estimate': 639,
  });
  expect(records(restored.getWorksheet('Rates and notes')!)[0]).toMatchObject({
    'Rate source': { hyperlink: new URL(rateSource.url).href },
    'Rate retrieved at': '2026-11-13T00:04:00Z',
  });
  expect(restored.getWorksheet('Cards')!.views[0]).toMatchObject({
    state: 'frozen',
    ySplit: 4,
    xSplit: 2,
  });
});

it('keeps requested but unpriced cards, distinguishes blocked conversion, and never treats an evidence API as a product page', () => {
  const result = fixture();
  result.plan.cards.push({
    ...card,
    card_id: 'missing-001',
    number: '001',
    name: 'Unpriced printing',
    quantity: 1,
  });
  result.currency_conversion = {
    status: 'unavailable',
    target_currency: 'JPY',
    message: 'Rate provider unavailable.',
  };
  result.budgets = [
    {
      supplier: 'Cardmarket',
      currency: 'EUR',
      complete: false,
      product_subtotal: '0',
      known_shipping: null,
      shipping_confirmed: false,
      confirmed_total: null,
      lines: [{ ...card, requested: 2, covered: 0, allocations: [] }],
    },
  ];
  result.reference_estimates![0].lines[0].source = {
    ...cm,
    url: 'https://api.tcgdex.net/v2/en/cards/me01-077',
  };
  const workbook = createBudgetWorkbook(result);
  expect(records(workbook.getWorksheet('Totals')!)).toHaveLength(2);
  const rows = records(workbook.getWorksheet('Cards')!);
  expect(rows).toHaveLength(4);
  expect(rows[0]).toMatchObject({
    'Converted unit estimate': null,
    'Converted line estimate': null,
    'Rate: target per 1 original': null,
    'Product or listing page': 'Unavailable',
    'Recorded price evidence': {
      hyperlink: 'https://api.tcgdex.net/v2/en/cards/me01-077',
    },
  });
  expect(rows.filter((row) => row['Catalog ID'] === 'missing-001')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        Supplier: 'Cardmarket',
        'Price basis': 'Price unavailable',
        'Original unit price': null,
      }),
      expect.objectContaining({
        Supplier: 'TCGplayer',
        'Price basis': 'Price unavailable',
        'Original line cost': null,
      }),
    ]),
  );
  expect(
    records(workbook.getWorksheet('Rates and notes')!).some(
      (row) => row.Details === 'Rate provider unavailable.',
    ),
  ).toBe(true);
});

it('keeps variant quantities separate and writes potentially formula-like card names as literal text', async () => {
  const result = fixture();
  result.plan.cards = [
    { ...card, name: '=HYPERLINK("https://bad.invalid")' },
    { ...card, quantity: 1, language: 'Japanese' },
  ];
  for (const estimate of result.reference_estimates!)
    estimate.lines[0].name = result.plan.cards[0].name;
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(
    await createBudgetWorkbook(result).xlsx.writeBuffer(),
  );
  const rows = records(restored.getWorksheet('Cards')!);
  expect(rows).toHaveLength(4);
  expect(rows[0]['Card name']).toBe('=HYPERLINK("https://bad.invalid")');
  expect(restored.getWorksheet('Cards')!.getCell('A5').type).toBe(
    ExcelJS.ValueType.String,
  );
  expect(
    rows.filter((row) =>
      String(row['Requested condition, language, finish']).includes('Japanese'),
    ),
  ).toEqual([
    expect.objectContaining({
      'Requested quantity': 1,
      'Price basis': 'Price unavailable',
    }),
    expect.objectContaining({
      'Requested quantity': 1,
      'Price basis': 'Price unavailable',
    }),
  ]);
});

it('exports allocated listings separately from guides, preserves source dates and explicit free shipping', () => {
  const result = fixture();
  result.offers = [
    {
      id: 'offer-1',
      supplier: 'TCGplayer',
      name: card.name,
      price: '1.2',
      currency: 'USD',
      quantity: 2,
      availability: 'in_stock',
      price_kind: 'listing',
      source: tcg,
    },
  ];
  const budget = {
    supplier: 'TCGplayer',
    currency: 'USD',
    complete: true,
    product_subtotal: '2.4',
    known_shipping: '0',
    shipping_confirmed: true,
    confirmed_total: '2.4',
    converted: {
      product_subtotal: '384',
      known_shipping: '0',
      confirmed_total: '384',
    },
    lines: [
      {
        ...card,
        requested: 2,
        covered: 2,
        allocations: [
          {
            offer_id: 'offer-1',
            supplier: 'TCGplayer',
            quantity: 2,
            unit_price: '1.2',
            line_total: '2.4',
            converted_unit_price: '192',
            converted_line_total: '384',
            url: tcg.url,
          },
        ],
      },
    ],
  };
  result.budgets = [budget, { ...budget, supplier: 'combined' }];
  const workbook = createBudgetWorkbook(result);
  const rows = records(workbook.getWorksheet('Cards')!);
  expect(rows.filter((row) => row['Price basis'] === 'Seller listing')).toEqual(
    [
      expect.objectContaining({
        'Original unit price': 1.2,
        'Converted line estimate': 384,
        Availability: 'in_stock',
        'Product or listing page': { hyperlink: tcg.url, text: tcg.url },
      }),
    ],
  );
  expect(records(workbook.getWorksheet('Totals')!)[2]).toMatchObject({
    'Known shipping': 0,
    'Shipping confirmed': 'Yes',
    'Confirmed supplier total': 2.4,
    'Converted supplier total estimate': 384,
  });
});

it('preserves collection-specific rounding, quota cap and FX even without the optional display conversion', () => {
  const result = fixture();
  result.currency_conversion = undefined;
  result.collection_summary = {
    status: 'selected',
    subject: 'Lucario',
    currency: 'JPY',
    budget_amount: '150000',
    product_subtotal: '640',
    remaining_budget: '149360',
    selected_printings: 1,
    researched_candidates: 2,
    preferred_selected: 1,
    limitations: ['Product cap excludes delivery.'],
    exchange: {
      status: 'available',
      target_currency: 'JPY',
      rates: { EUR: '177.6' },
      as_of: '2026-11-12T00:00:00Z',
      source: rateSource,
    },
    lines: [
      {
        ...card,
        supplier: 'Cardmarket',
        original_currency: 'EUR',
        original_unit_price: '1.8',
        original_line_total: '3.6',
        converted_unit_price: '319.68',
        converted_line_total: '640',
        source: cm,
      },
    ],
    excluded_candidates: [
      { card_id: 'excluded', name: 'Another card', reason: 'Over budget.' },
    ],
  };
  const workbook = createBudgetWorkbook(result);
  expect(
    records(workbook.getWorksheet('Cards')!).find(
      (row) => row['Price basis'] === 'Collection selection estimate',
    ),
  ).toMatchObject({
    'Converted line estimate': 640,
    'Rate: target per 1 original': 177.6,
    'Exchange-rate date': '2026-11-12T00:00:00Z',
  });
  expect(records(workbook.getWorksheet('Totals')!).at(-1)).toMatchObject({
    'Product subtotal': 640,
    'Original currency': 'JPY',
    'Confirmed supplier total': 'Not confirmed',
  });
  expect(records(workbook.getWorksheet('Rates and notes')!)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        Record: 'Collection remaining',
        'Rate or stated amount': 149360,
      }),
      expect.objectContaining({
        Record: 'Excluded candidate',
        Details: 'Another card: Over budget.',
      }),
    ]),
  );
});

it('does not export credential-bearing or executable links and preserves long decimal evidence without rounding it', () => {
  const result = fixture();
  result.reference_estimates![0].lines[0].source.url = 'javascript:alert(1)';
  result.reference_estimates![1].lines[0].source.url =
    'https://user:password@www.tcgplayer.com/product/123';
  result.currency_conversion!.rates!.EUR = '177.1234567890123456789';
  const rows = records(createBudgetWorkbook(result).getWorksheet('Cards')!);
  expect(rows[0]['Rate: target per 1 original']).toBe(
    '177.1234567890123456789',
  );
  for (const row of rows)
    expect(row).toMatchObject({
      'Product or listing page': 'Unavailable',
      'Recorded price evidence': 'Unavailable',
    });
});
