// Output formats (docs/format.md §10). None of them changes a business value:
// formula protection is applied only to the spreadsheet CSV, never to the JSON.
import { isPlainDecimal } from "./decimal.js";
import { NORMALIZED_SCHEMA, type DiagnosticCode, type NormalizedFill, type ProcessResult } from "./types.js";
import { VERSION } from "../version.js";

/** Lossless normalized output. Throws if the result may not be exported (export === "none"). */
export function toNormalizedJson(result: ProcessResult): string {
  if (result.export === "none") throw new Error("Nothing to export: the report has errors and partial export was not enabled.");
  const byCode: Partial<Record<DiagnosticCode, number>> = {};
  for (const d of result.report.diagnostics) if (d.severity === "error" && d.record !== null) byCode[d.code] = (byCode[d.code] ?? 0) + 1;
  const doc = {
    schemaVersion: NORMALIZED_SCHEMA,
    tool: { name: "tradecsv", version: VERSION },
    input: result.report.input,
    format: result.report.format,
    account: result.report.account,
    completeness: result.export,
    excluded: { records: result.report.summary.rejectedRecords ?? 0, byCode },
    records: result.records,
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

export function toReportJson(result: ProcessResult): string {
  return JSON.stringify(result.report, null, 2) + "\n";
}

export const SPREADSHEET_COLUMNS = [
  "source_record", "format", "account", "market_type", "instrument", "trade_id", "order_id", "executed_at", "base_asset", "quote_asset",
  "side", "position_side", "position_effect", "price", "quantity", "quantity_unit", "quote_amount", "fee_amount", "fee_currency",
  "realized_pnl", "realized_pnl_currency", "duplicate_of", "suspected_duplicate_of",
] as const;

const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Text cell for spreadsheets: values that a spreadsheet could treat as a formula get a leading apostrophe
 * (OWASP CSV Injection guidance). Plain decimal numbers are left as they are.
 */
export function spreadsheetCell(value: string | number | null): string {
  if (value === null) return "";
  const s = String(value);
  if (isPlainDecimal(s)) return s;
  return FORMULA_START.test(s) ? "'" + s : s;
}

const quoteField = (s: string) => '"' + s.replace(/"/g, '""') + '"';

/** Spreadsheet-oriented CSV: UTF-8 BOM, CRLF, every field quoted, formula protection on text cells. */
export function toSpreadsheetCsv(records: NormalizedFill[]): string {
  const lines = [SPREADSHEET_COLUMNS.map(quoteField).join(",")];
  for (const r of records) {
    const cells = [r.sourceRecord, r.format, r.account, r.marketType, r.instrument, r.tradeId, r.orderId, r.executedAt, r.baseAsset, r.quoteAsset,
      r.side, r.positionSide, r.positionEffect, r.price, r.quantity, r.quantityUnit, r.quoteAmount, r.feeAmount, r.feeCurrency,
      r.realizedPnl, r.realizedPnlCurrency, r.duplicateOf, r.suspectedDuplicateOf];
    lines.push(cells.map((c) => quoteField(spreadsheetCell(c))).join(","));
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}
