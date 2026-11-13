import ExcelJS from 'exceljs';
import type { Card, CurrencyConversion, Result, Source } from './contracts';

const UNKNOWN = 'Unavailable';
type Identity = Pick<Card, 'card_id' | 'name'> & Partial<Card>;
type Row = Record<string, ExcelJS.CellValue>;
type Column = { key: string; header: string; width: number };

// Values are snapshots, not new quotes or client-side FX calculations.
function money(value: string | null | undefined): ExcelJS.CellValue {
  if (value == null || !/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  const significant = value.replace(/^-?0*|\./g, '').replace(/0+$/, '');
  return significant.length <= 15 && Number.isFinite(Number(value))
    ? Number(value)
    : value;
}

function publicUrl(value?: string): string | undefined {
  try {
    const url = new URL(value || '');
    if (url.protocol !== 'https:' || url.username || url.password) return;
    if (
      [...url.searchParams.keys()].some((key) =>
        /^(token|key|api[_-]?key|access[_-]?token|authorization|password|secret|signature)$/i.test(
          key,
        ),
      )
    )
      return;
    return url.href;
  } catch {
    return;
  }
}

function link(value?: string): ExcelJS.CellValue {
  const url = publicUrl(value);
  return url ? { text: url, hyperlink: url } : UNKNOWN;
}

function productLink(
  source: Source | undefined,
  supplier: string,
): ExcelJS.CellValue {
  const href = publicUrl(source?.url);
  if (!href) return UNKNOWN;
  const url = new URL(href);
  const host = url.hostname.replace(/^www\./, '');
  return (supplier === 'TCGplayer' &&
    host === 'tcgplayer.com' &&
    /^\/product\//i.test(url.pathname)) ||
    (supplier === 'Cardmarket' &&
      host === 'cardmarket.com' &&
      /\/Pokemon\/Products\/Singles(?:\/|$)/i.test(url.pathname))
    ? link(href)
    : UNKNOWN;
}

function key(card: Identity): string {
  return JSON.stringify([
    card.card_id,
    card.condition || '',
    card.language || '',
    card.printing || '',
  ]);
}

function requests(result: Result): Card[] {
  const cards = new Map<string, Card>();
  for (const card of result.plan.cards) {
    const old = cards.get(key(card));
    cards.set(key(card), {
      ...card,
      quantity: (old?.quantity || 0) + card.quantity,
    });
  }
  return [...cards.values()];
}

function resolve(identity: Identity, cards: Card[]): Identity {
  const candidates = cards.filter(
    (card) =>
      card.card_id === identity.card_id &&
      (['condition', 'language', 'printing'] as const).every(
        (field) => !identity[field] || card[field] === identity[field],
      ),
  );
  return candidates.length === 1 ? { ...candidates[0], ...identity } : identity;
}

function sheet(
  workbook: ExcelJS.Workbook,
  name: string,
  title: string,
  note: string,
  columns: Column[],
  rows: Row[],
) {
  const ws = workbook.addWorksheet(name, {
    views: [
      {
        state: 'frozen',
        ySplit: 4,
        xSplit: name === 'Cards' ? 2 : 0,
        showGridLines: false,
      },
    ],
  });
  ws.columns = columns.map(({ key, width }) => ({ key, width }));
  ws.mergeCells(1, 1, 1, columns.length);
  ws.getCell(1, 1).value = title;
  ws.getCell(1, 1).font = {
    name: 'Calibri',
    size: 18,
    bold: true,
    color: { argb: 'FF152939' },
  };
  ws.getRow(1).height = 32;
  ws.mergeCells(2, 1, 2, columns.length);
  ws.getCell(2, 1).value = note;
  ws.getCell(2, 1).alignment = { wrapText: true, vertical: 'middle' };
  ws.getRow(2).height = 34;
  ws.getRow(4).values = columns.map((column) => column.header);
  ws.getRow(4).height = 45;
  ws.getRow(4).eachCell((cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF152939' },
    };
    cell.font = { name: 'Calibri', bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { wrapText: true, vertical: 'middle' };
  });
  for (const values of rows) {
    // Plain strings stay text, including names beginning with '=' or '+'.
    const row = ws.addRow(values);
    row.height = 42;
    row.eachCell((cell) => {
      cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF152939' } };
      cell.alignment = { vertical: 'top', wrapText: true };
      if (row.number % 2)
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF1F5F8' },
        };
      if (typeof cell.value === 'number') {
        const field = columns[Number(cell.col) - 1]?.key;
        cell.numFmt =
          field === 'quantity' || field === 'requested'
            ? '0'
            : '#,##0.00#############';
      }
      if (cell.type === ExcelJS.ValueType.Hyperlink)
        cell.font = {
          ...cell.font,
          color: { argb: 'FF0972D3' },
          underline: true,
        };
    });
  }
  if (rows.length)
    ws.autoFilter = {
      from: { row: 4, column: 1 },
      to: { row: rows.length + 4, column: columns.length },
    };
  ws.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: '1:4',
  };
  return ws;
}

const cardColumns: Column[] = [
  { key: 'name', header: 'Card name', width: 30 },
  { key: 'code', header: 'Set and card code', width: 28 },
  { key: 'card_id', header: 'Catalog ID', width: 18 },
  { key: 'requested', header: 'Requested quantity', width: 14 },
  { key: 'supplier', header: 'Supplier', width: 16 },
  { key: 'basis', header: 'Price basis', width: 25 },
  { key: 'quantity', header: 'Priced quantity', width: 14 },
  { key: 'currency', header: 'Original currency', width: 14 },
  { key: 'unit', header: 'Original unit price', width: 18 },
  { key: 'line', header: 'Original line cost', width: 18 },
  { key: 'target', header: 'Converted currency', width: 14 },
  { key: 'converted_unit', header: 'Converted unit estimate', width: 19 },
  { key: 'converted_line', header: 'Converted line estimate', width: 19 },
  { key: 'rate', header: 'Rate: target per 1 original', width: 22 },
  { key: 'as_of', header: 'Exchange-rate date', width: 24 },
  { key: 'product', header: 'Product or listing page', width: 48 },
  { key: 'source', header: 'Recorded price evidence', width: 48 },
  { key: 'retrieved', header: 'Price retrieved at', width: 24 },
  { key: 'availability', header: 'Availability', width: 22 },
  {
    key: 'variant',
    header: 'Requested condition, language, finish',
    width: 32,
  },
  { key: 'option', header: 'Budget option', width: 20 },
];

export function createBudgetWorkbook(
  result: Result,
  now = new Date(),
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Pokémon TCG Marketplace';
  workbook.created = now;
  workbook.modified = now;
  const cards = requests(result);
  const rows: Row[] = [];
  const represented = new Set<string>();
  const conversion = result.currency_conversion;
  function add(
    identity: Identity,
    supplier: string,
    values: Row,
    source?: Source,
    fx = conversion,
  ) {
    const card = resolve(identity, cards);
    represented.add(`${key(card)}:${supplier}`);
    rows.push({
      name: card.name,
      code:
        [card.set_name, card.number && `#${card.number}`]
          .filter(Boolean)
          .join(' · ') || UNKNOWN,
      card_id: card.card_id,
      requested: card.quantity ?? null,
      supplier,
      variant:
        [card.condition, card.language, card.printing]
          .filter(Boolean)
          .join(' · ') || UNKNOWN,
      target: fx?.target_currency || UNKNOWN,
      rate:
        fx?.status === 'available'
          ? money(fx.rates?.[String(values.currency)])
          : null,
      as_of: fx?.status === 'available' ? fx.as_of || UNKNOWN : UNKNOWN,
      product: productLink(source, supplier),
      source: link(source?.url),
      retrieved: source?.retrieved_at || UNKNOWN,
      ...values,
    });
  }
  for (const estimate of result.reference_estimates || []) {
    for (const line of estimate.lines)
      add(
        line,
        estimate.supplier,
        {
          basis: 'Price-guide estimate',
          quantity: line.quantity,
          currency: estimate.currency,
          unit: money(line.unit_price),
          line: money(line.line_total),
          converted_unit:
            conversion?.status === 'available'
              ? money(line.converted_unit_price)
              : null,
          converted_line:
            conversion?.status === 'available'
              ? money(line.converted_line_total)
              : null,
          availability: 'Unverified',
          option: 'Supplier price guide',
        },
        line.source,
      );
  }
  const allocations = new Set<string>();
  for (const budget of result.budgets) {
    for (const line of budget.lines)
      for (const allocation of line.allocations) {
        const duplicate = JSON.stringify([
          key(line),
          allocation.offer_id,
          allocation.quantity,
          allocation.unit_price,
          allocation.line_total,
          budget.currency,
        ]);
        if (allocations.has(duplicate)) continue;
        allocations.add(duplicate);
        const offer = result.offers.find(
          (offer) => offer.id === allocation.offer_id,
        );
        add(
          line,
          allocation.supplier,
          {
            basis: 'Seller listing',
            quantity: allocation.quantity,
            currency: budget.currency,
            unit: money(allocation.unit_price),
            line: money(allocation.line_total),
            converted_unit:
              conversion?.status === 'available'
                ? money(allocation.converted_unit_price)
                : null,
            converted_line:
              conversion?.status === 'available'
                ? money(allocation.converted_line_total)
                : null,
            availability:
              offer?.availability || 'Stock allocated in saved result',
            option: budget.supplier,
          },
          {
            url: allocation.url,
            title: offer?.source.title || line.name,
            retrieved_at: offer?.source.retrieved_at || '',
          },
        );
      }
  }
  const collection = result.collection_summary;
  if (collection)
    for (const line of collection.lines) {
      const fx = collection.exchange;
      add(
        line,
        line.supplier,
        {
          basis: 'Collection selection estimate',
          quantity: resolve(line, cards).quantity ?? null,
          currency: line.original_currency,
          unit: money(line.original_unit_price),
          line: money(line.original_line_total),
          target: collection.currency,
          converted_unit: money(line.converted_unit_price),
          converted_line: money(line.converted_line_total),
          availability: 'Unverified',
          option: 'Selected collection',
        },
        line.source,
        fx,
      );
    }
  for (const card of cards)
    for (const supplier of ['Cardmarket', 'TCGplayer']) {
      if (!represented.has(`${key(card)}:${supplier}`))
        add(card, supplier, {
          basis: 'Price unavailable',
          quantity: null,
          currency: UNKNOWN,
          unit: null,
          line: null,
          converted_unit: null,
          converted_line: null,
          availability: 'Unverified',
          option: 'Unpriced request',
        });
    }
  sheet(
    workbook,
    'Cards',
    'Pokémon TCG buying budget',
    'Recorded prices and links. Price-guide, collection-selection and seller-listing rows are separate evidence; do not add them together. Blank amounts are unknown, not zero.',
    cardColumns,
    rows,
  );

  const totalRows: Row[] = [];
  for (const estimate of result.reference_estimates || [])
    totalRows.push({
      option: 'Price-guide estimate',
      supplier: estimate.supplier,
      currency: estimate.currency,
      subtotal: money(estimate.product_subtotal),
      shipping: 'Unknown',
      shipping_confirmed: 'No',
      final: 'Not confirmed',
      target: conversion?.target_currency || UNKNOWN,
      converted_subtotal:
        conversion?.status === 'available'
          ? money(estimate.converted?.product_subtotal)
          : null,
      converted_shipping: null,
      converted_final: null,
      coverage: `${estimate.priced_cards} of ${estimate.requested_cards} cards`,
    });
  // Match the UI: do not present empty stock budgets as free purchase options
  // when price-guide estimates are the only available evidence.
  for (const budget of result.budgets.filter(
    (budget) =>
      !result.reference_estimates?.length ||
      budget.complete ||
      budget.lines.some((line) => line.covered > 0),
  ))
    totalRows.push({
      option:
        budget.supplier === 'combined'
          ? 'Combined purchase option'
          : 'Supplier purchase option',
      supplier: budget.supplier,
      currency: budget.currency,
      subtotal: money(budget.product_subtotal),
      shipping:
        budget.known_shipping == null
          ? 'Unknown'
          : money(budget.known_shipping),
      shipping_confirmed: budget.shipping_confirmed ? 'Yes' : 'No',
      final:
        budget.confirmed_total == null
          ? 'Not confirmed'
          : money(budget.confirmed_total),
      target: conversion?.target_currency || UNKNOWN,
      converted_subtotal:
        conversion?.status === 'available'
          ? money(budget.converted?.product_subtotal)
          : null,
      converted_shipping:
        conversion?.status === 'available'
          ? money(budget.converted?.known_shipping)
          : null,
      converted_final:
        conversion?.status === 'available'
          ? money(budget.converted?.confirmed_total)
          : null,
      coverage: budget.complete
        ? 'Complete card coverage'
        : 'Incomplete card coverage',
    });
  if (collection)
    totalRows.push({
      option: 'Selected collection',
      supplier: 'Selected price guides',
      currency: collection.currency,
      subtotal: money(collection.product_subtotal),
      shipping: 'Unknown',
      shipping_confirmed: 'No',
      final: 'Not confirmed',
      target: collection.currency,
      converted_subtotal: money(collection.product_subtotal),
      coverage: `${collection.selected_printings} selected printings`,
    });
  sheet(
    workbook,
    'Totals',
    'Budget alternatives',
    'Each row is a separate alternative. Unknown shipping, tax and fees are not zero. Converted amounts are estimates; retain the recorded supplier total and currency.',
    [
      { key: 'option', header: 'Budget option', width: 30 },
      { key: 'supplier', header: 'Supplier', width: 24 },
      { key: 'currency', header: 'Original currency', width: 14 },
      { key: 'subtotal', header: 'Product subtotal', width: 20 },
      { key: 'shipping', header: 'Known shipping', width: 18 },
      { key: 'shipping_confirmed', header: 'Shipping confirmed', width: 17 },
      { key: 'final', header: 'Confirmed supplier total', width: 23 },
      { key: 'target', header: 'Converted currency', width: 16 },
      {
        key: 'converted_subtotal',
        header: 'Converted product estimate',
        width: 23,
      },
      {
        key: 'converted_shipping',
        header: 'Converted known shipping',
        width: 23,
      },
      {
        key: 'converted_final',
        header: 'Converted supplier total estimate',
        width: 25,
      },
      { key: 'coverage', header: 'Coverage', width: 30 },
    ],
    totalRows,
  );

  const notes: Row[] = [];
  function rates(fx: CurrencyConversion | undefined, scope: string) {
    if (!fx) return;
    for (const [from, rate] of Object.entries(
      fx.status === 'available' ? fx.rates || {} : {},
    ))
      notes.push({
        kind: scope,
        from,
        to: fx.target_currency,
        rate: money(rate),
        as_of: fx.as_of || UNKNOWN,
        retrieved: fx.retrieved_at || UNKNOWN,
        source: link(fx.source?.url),
        details: 'Target currency per 1 unit of original currency.',
      });
    notes.push({
      kind: scope,
      to: fx.target_currency,
      details:
        fx.message ||
        fx.notice ||
        (fx.status === 'available'
          ? 'Recorded conversion snapshot.'
          : 'Conversion unavailable; original prices retained.'),
    });
  }
  rates(conversion, 'Budget exchange');
  rates(collection?.exchange, 'Collection exchange');
  notes.push(
    { kind: 'Exported at', details: now.toISOString() },
    { kind: 'Format', details: result.plan.format },
    { kind: 'Recommendation', details: result.recommendation },
    {
      kind: 'Limitations',
      details:
        'An export of the saved result, not a refreshed quotation. Prices and stock may change. Missing supplier product links are not invented; the recorded evidence link is retained.',
    },
  );
  for (const text of result.legality.issues)
    notes.push({ kind: 'Legality limitation', details: text });
  for (const error of result.supplier_errors)
    notes.push({
      kind: 'Supplier limitation',
      from: error.supplier,
      details: error.message,
    });
  for (const card of result.stock_shortages || [])
    notes.push({
      kind: 'Verified listing shortfall',
      from: card.card_id,
      details: `${card.quantity} × ${card.name}`,
    });
  for (const card of result.availability_unverified || [])
    notes.push({
      kind: 'Availability unverified',
      from: card.card_id,
      details: `${card.quantity} × ${card.name}`,
    });
  if (collection) {
    notes.push(
      {
        kind: 'Collection cap',
        to: collection.currency,
        rate: money(collection.budget_amount),
        details:
          'Product budget; excludes unconfirmed delivery, taxes and fees.',
      },
      {
        kind: 'Collection remaining',
        to: collection.currency,
        rate: money(collection.remaining_budget),
        details: 'Remaining product budget in the saved selection.',
      },
    );
    for (const text of collection.limitations)
      notes.push({ kind: 'Collection limitation', details: text });
    for (const card of collection.excluded_candidates)
      notes.push({
        kind: 'Excluded candidate',
        from: card.card_id,
        details: `${card.name}: ${card.reason}`,
      });
  }
  sheet(
    workbook,
    'Rates and notes',
    'Exchange-rate snapshots and limitations',
    'Rates and amounts are copied from the saved result. No supplier or exchange-rate requests run during export.',
    [
      { key: 'kind', header: 'Record', width: 26 },
      { key: 'from', header: 'Original currency or card', width: 24 },
      { key: 'to', header: 'Target currency', width: 16 },
      { key: 'rate', header: 'Rate or stated amount', width: 22 },
      { key: 'as_of', header: 'Rate as of', width: 26 },
      { key: 'retrieved', header: 'Rate retrieved at', width: 26 },
      { key: 'source', header: 'Rate source', width: 45 },
      { key: 'details', header: 'Details', width: 85 },
    ],
    notes,
  );
  return workbook;
}

export async function downloadBudgetExcel(result: Result): Promise<void> {
  const now = new Date();
  const workbook = createBudgetWorkbook(result, now);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([new Uint8Array(buffer)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `tcg-${result.collection_summary ? 'collection-' : ''}budget-${now.toISOString().slice(0, 10)}.xlsx`;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
