# Excel budget exports

Select **Download Excel** in the buying-budget header for a completed deck, singles or collection result. The same action is available when opening a saved budget or reviewing it in the administration activity workspace. The current converted/original price-view toggle does not hide either currency in the export.

The workbook contains three sheets:

- **Cards**: card name, set and card number, catalog ID, requested and priced quantities, requested variant, supplier, original unit/line prices, converted unit/line estimates, the recorded exchange rate and date, clickable product/listing pages, price-evidence links, retrieval dates and availability. Cardmarket and TCGplayer remain separate rows. Missing supplier prices remain blank, labelled unavailable.
- **Totals**: separate supplier price-guide estimates, purchasing alternatives and the selected collection estimate. Combined purchasing alternatives stay separate. Unknown shipping and unconfirmed totals are explicit; confirmed zero shipping stays zero. As in the UI, empty stock budgets are omitted when only price-guide estimates exist.
- **Rates and notes**: saved exchange-rate factors, source and timestamps, recommendation, supplier/legality/availability limitations, and collection spending cap, remaining allowance and exclusions.

Price-guide estimates, collection-selection estimates and allocated seller listings are labelled separately. They are alternative evidence, not amounts to add together. Collection-selection rows retain their original upward rounding to preserve the spending cap; other rows retain the amounts already calculated by the backend. The export does not recalculate FX or infer stock from a price reference.

Product links come only from recorded supplier product/listing URLs. If the saved evidence points to a catalog API instead, the workbook retains that evidence and marks the product page unavailable. It does not guess a marketplace listing. HTTPS links with embedded credentials or credential query parameters are excluded, and cell strings are written as literal text rather than spreadsheet formulas.

The file is generated locally in the browser with a lazy-loaded [ExcelJS document workbook](https://github.com/exceljs/exceljs#browser), including [native clickable hyperlinks](https://github.com/exceljs/exceljs#hyperlink-value). No new execution, supplier lookup, currency request, upload, API permission or database migration is needed. The export is a snapshot of the saved result; prices and availability may have changed since retrieval.

Validation includes an XLSX write/read round trip, both supplier currencies and links, historical conversions, missing prices, variant quantities, collection rounding, unsafe links, literal text cells, retryable download errors and a real browser download of a recorded collection result. The ExcelJS UUID dependency is overridden to the patched CommonJS-compatible 11.x line; the production dependency audit reports no vulnerabilities.
