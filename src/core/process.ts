// The whole pipeline: read → check structure → validate and normalize each record → duplicates → report.
// Pure function: no file system, no network, no clock. Same input and options → same result.
import { DEFAULT_MAX_BYTES, decodeInput, isBlankRow, parseCsv } from "./csv.js";
import { compareDecimal, decimalKey, isPlainDecimal, isPositive, multiply, negateDecimal, normalizeDecimal, withinLastPlace } from "./decimal.js";
import { validateMapping } from "./mapping.js";
import { sha256Hex } from "./sha256.js";
import { parseTime } from "./time.js";
import {
  REPORT_SCHEMA, REQUIRED_FIELDS,
  type CanonicalField, type Diagnostic, type DiagnosticCode, type MappingConfig, type NormalizedFill,
  type ProcessOptions, type ProcessResult, type Report, type Summary,
} from "./types.js";
import { TEMPLATE_FORMAT_ID, TEMPLATE_MAPPING } from "../formats/template.js";
import { VERSION } from "../version.js";

const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const ID_MAX = 128;
const q = (s: string) => JSON.stringify(s.length > 60 ? s.slice(0, 60) + "…" : s);

class Collector {
  list: Diagnostic[] = [];
  add(severity: Diagnostic["severity"], code: DiagnosticCode, record: number | null, field: CanonicalField | null, message: string, hint: string) {
    this.list.push({ severity, code, record, field, message, hint });
  }
}

interface Candidate { fill: NormalizedFill; warnings: Diagnostic[] }

export function processCsv(input: string | Uint8Array, options: ProcessOptions = {}): ProcessResult {
  const account = (options.account ?? "default").trim() || "default";
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const inputInfo = { sha256: sha256Hex(bytes), bytes: bytes.length };
  const fileDiag = new Collector();

  const fail = (format: string | null, summary?: Partial<Summary>, unmapped: string[] = []): ProcessResult =>
    finish(inputInfo, format, account, fileDiag.list, [], [], summary, unmapped, false);

  // Mapping
  let mapping: MappingConfig = TEMPLATE_MAPPING;
  if (options.mapping !== undefined) {
    const check = validateMapping(options.mapping);
    if (!check.ok) {
      fileDiag.add("error", "INVALID_MAPPING", null, null, `The mapping is invalid: ${check.problems.join(" ")}`, "Fix the mapping file; see docs/format.md §11.");
      return fail(null);
    }
    mapping = check.mapping;
  }
  const isTemplate = options.mapping === undefined;
  const format = mapping.formatId;

  // File, encoding, CSV structure
  const decoded = decodeInput(input, maxBytes);
  if (!decoded.ok) { fileDiag.add("error", decoded.code, null, null, decoded.message, decoded.hint); return fail(format); }
  const parsed = parseCsv(decoded.text);
  if (!parsed.ok) { fileDiag.add("error", parsed.code, null, null, parsed.message, parsed.hint); return fail(format); }
  const { header, rows } = parsed.table;

  // Header
  const seen = new Map<string, number>();
  const dups = new Set<string>();
  header.forEach((h) => { if (h !== "") { if (seen.has(h)) dups.add(h); else seen.set(h, header.indexOf(h)); } });
  if (dups.size) fileDiag.add("error", "DUPLICATE_HEADER", null, null, `Duplicate column names: ${[...dups].map(q).join(", ")}`, "Each column name must appear once. TradeCSV does not rename columns.");

  const colIndex: Partial<Record<CanonicalField, number>> = {};
  const missing: string[] = [];
  for (const [field, col] of Object.entries(mapping.columns) as [CanonicalField, string][]) {
    const idx = seen.get(col.trim());
    if (idx !== undefined) colIndex[field] = idx;
    else if (!isTemplate || REQUIRED_FIELDS.includes(field)) missing.push(col);
  }
  const used = new Set(Object.values(colIndex));
  const unmapped = header.filter((h, i) => h !== "" && !used.has(i));
  if (missing.length) {
    const noneFound = isTemplate && REQUIRED_FIELDS.every((f) => colIndex[f] === undefined);
    if (noneFound) fileDiag.add("error", "UNKNOWN_FORMAT", null, null, "The header does not match the Spot Fills Template v0.1 and no mapping was given", "Rename the columns to the template names (tradecsv template) or pass a mapping file (--mapping).");
    else fileDiag.add("error", "MISSING_REQUIRED_COLUMN", null, null, `Missing column(s): ${missing.map(q).join(", ")}`, isTemplate ? "Template columns: executed_at, base_asset, quote_asset, side, price, quantity are required." : "Check the column names in the mapping against the file's header (case matters).");
  }
  if (fileDiag.list.length) return fail(format, undefined, unmapped);

  const nonBlank = rows.filter((r) => !isBlankRow(r)).length;
  if (nonBlank === 0) {
    fileDiag.add("error", "NO_RECORDS", null, null, "The file has a header but no records", "Export a period that contains fills.");
    return fail(format, { totalRecords: 0, acceptedRecords: 0, rejectedRecords: 0, blankRecordsIgnored: rows.length }, unmapped);
  }
  const feeMapped = colIndex.fee_amount !== undefined;
  if (!feeMapped) fileDiag.add("warning", "FEE_MISSING", null, "fee_amount", "The file has no fee column, so every fee is unknown (null)", "Add fee_amount and fee_currency if the source provides them.");

  // Records
  const recDiag = new Collector();
  const candidates: Candidate[] = [];
  let blank = 0;
  const rejected = new Set<number>();
  rows.forEach((row, i) => {
    const rec = i + 1;
    if (isBlankRow(row)) { blank++; return; }
    if (row.length !== header.length) {
      recDiag.add("error", "ROW_FIELD_COUNT", rec, null, `Record has ${row.length} fields; the header has ${header.length}`, "Check for missing or extra commas, or an unquoted comma inside a value.");
      rejected.add(rec);
      return;
    }
    const d = new Collector();
    const raw = (f: CanonicalField): string | undefined => { const idx = colIndex[f]; return idx === undefined ? undefined : row[idx]; };
    const sourceValues: Partial<Record<CanonicalField, string>> = {};
    for (const f of Object.keys(colIndex) as CanonicalField[]) sourceValues[f] = raw(f)!;
    const fixed = (f: "base_asset" | "quote_asset" | "fee_currency") => mapping.fixed?.[f];
    const val = (f: CanonicalField): string => (raw(f) ?? (f === "base_asset" || f === "quote_asset" || f === "fee_currency" ? fixed(f) ?? "" : "")).trim();
    const err = (code: DiagnosticCode, f: CanonicalField | null, m: string, h: string) => d.add("error", code, rec, f, m, h);
    const warn = (code: DiagnosticCode, f: CanonicalField | null, m: string, h: string) => d.add("warning", code, rec, f, m, h);

    for (const f of REQUIRED_FIELDS) if (val(f) === "") err("MISSING_VALUE", f, `${f} is empty`, "Every record needs executed_at, base_asset, quote_asset, side, price and quantity.");

    // time
    let executedAt = "";
    if (val("executed_at") !== "") {
      const t = parseTime(val("executed_at"), mapping.time ?? { format: "iso" });
      if (t.ok) executedAt = t.utc; else err(t.code, "executed_at", t.message, t.hint);
    }
    // assets
    const asset = (f: "base_asset" | "quote_asset") => {
      const v = val(f);
      if (v !== "" && !ASSET_RE.test(v)) err("INVALID_ASSET", f, `${f} is not a valid asset code: ${q(v)}`, "Use letters, digits, dot, underscore or dash, e.g. BTC or USDT.");
      return v;
    };
    const base = asset("base_asset"), quote = asset("quote_asset");
    if (base && quote && base.toLowerCase() === quote.toLowerCase()) err("SAME_BASE_AND_QUOTE", "quote_asset", `base_asset and quote_asset are both ${q(base)}`, "Check the asset columns.");
    // side
    let side: "buy" | "sell" | null = null;
    const sv = val("side");
    if (sv !== "") {
      if (mapping.side) side = mapping.side.buy.includes(sv) ? "buy" : mapping.side.sell.includes(sv) ? "sell" : null;
      else side = sv.toLowerCase() === "buy" ? "buy" : sv.toLowerCase() === "sell" ? "sell" : null;
      if (!side) err("INVALID_SIDE", "side", `side is not a recognized value: ${q(sv)}`, mapping.side ? `Accepted: ${[...mapping.side.buy, ...mapping.side.sell].map(q).join(", ")}.` : "Use buy or sell.");
    }
    // decimals
    const decimal = (f: CanonicalField): string | null => {
      const v = val(f);
      if (v === "") return null;
      if (!isPlainDecimal(v)) { err("INVALID_NUMBER", f, `${f} is not a plain decimal number: ${q(v)}`, "Use digits with an optional dot: no thousands separators, decimal commas or exponents (e.g. 1250.5, 0.00000012)."); return null; }
      return normalizeDecimal(v);
    };
    const price = decimal("price");
    if (price !== null && !isPositive(price)) err("INVALID_PRICE", "price", `price must be greater than 0 (got ${price})`, "Spot fills have a positive price.");
    const quantity = decimal("quantity");
    if (quantity !== null && !isPositive(quantity)) err("INVALID_QUANTITY", "quantity", `quantity must be greater than 0 (got ${quantity})`, "Quantity is the base amount filled. Buy or sell comes from the side column; TradeCSV does not infer it from a minus sign.");
    const quoteAmount = decimal("quote_amount");
    if (quoteAmount !== null && compareDecimal(quoteAmount, "0") < 0) err("INVALID_NUMBER", "quote_amount", `quote_amount must not be negative (got ${quoteAmount})`, "quote_amount is the reported value of the fill, excluding fees.");
    // ids
    const id = (f: "trade_id" | "order_id") => {
      const v = val(f);
      if (v.length > ID_MAX) err("INVALID_ID", f, `${f} is longer than ${ID_MAX} characters`, "Identifiers are limited to 128 characters.");
      return v === "" ? null : v;
    };
    const tradeId = id("trade_id"), orderId = id("order_id");
    // fees
    let feeAmount: string | null = null, feeCurrency: string | null = null;
    if (feeMapped) {
      const fa = val("fee_amount"), fc = val("fee_currency");
      if (fc !== "" && !ASSET_RE.test(fc)) err("INVALID_ASSET", "fee_currency", `fee_currency is not a valid asset code: ${q(fc)}`, "Use an asset code like USDT or BNB.");
      if (fa === "") warn("FEE_MISSING", "fee_amount", "fee_amount is empty, so the fee is unknown (null, not 0)", "Fill in the fee if the source has it.");
      else {
        const amt = decimal("fee_amount");
        const sign = mapping.fee?.sign ?? "cost_positive";
        if (amt !== null) {
          if (fc === "") warn("FEE_CURRENCY_MISSING", "fee_currency", `fee_amount ${amt} has no fee_currency, so the fee is left as unknown`, "TradeCSV never assumes the fee currency. Fill in fee_currency or map it.");
          else if (sign === "unknown") { feeCurrency = fc; warn("FEE_SIGN_UNKNOWN", "fee_amount", `The fee sign convention is unknown, so fee_amount ${amt} is left as null (raw value kept in sourceValues)`, "Set fee.sign in the mapping once you know whether the source shows fees as positive or negative."); }
          else { feeAmount = sign === "cost_negative" ? negateDecimal(amt) : amt; feeCurrency = fc; }
        }
      }
    }
    if (d.list.some((x) => x.severity === "error")) { recDiag.list.push(...d.list); rejected.add(rec); return; }
    // reported amount vs price × quantity
    if (quoteAmount !== null) {
      const exact = multiply(price!, quantity!);
      if (!withinLastPlace(exact, quoteAmount)) warn("QUOTE_AMOUNT_MISMATCH", "quote_amount", `quote_amount ${quoteAmount} differs from price × quantity = ${exact}`, "Both values are kept. Check whether the amount includes fees or comes from another fill.");
    }
    candidates.push({
      fill: { format, account, sourceRecord: rec, marketType: "spot", tradeId, orderId, executedAt, baseAsset: base, quoteAsset: quote, side: side!, price: price!, quantity: quantity!, quoteAmount, feeAmount, feeCurrency, duplicateOf: null, suspectedDuplicateOf: null, sourceValues },
      warnings: d.list,
    });
  });

  // Duplicates and conflicts (within this file, format and account)
  const dupCount = { identical: 0, conflicting: 0, suspected: 0 };
  const contentKey = (f: NormalizedFill) => [f.executedAt, f.baseAsset, f.quoteAsset, f.side, decimalKey(f.price), decimalKey(f.quantity), f.orderId ?? "", f.quoteAmount === null ? "" : decimalKey(f.quoteAmount), f.feeAmount === null ? "" : decimalKey(f.feeAmount), f.feeCurrency ?? ""].join("|");
  const byId = new Map<string, Candidate[]>();
  for (const c of candidates) if (c.fill.tradeId !== null) byId.set(c.fill.tradeId, [...(byId.get(c.fill.tradeId) ?? []), c]);
  const conflicted = new Set<Candidate>();
  for (const [tid, group] of byId) {
    if (group.length < 2) continue;
    const keys = new Set(group.map((c) => contentKey(c.fill)));
    if (keys.size > 1) {
      const recs = group.map((c) => c.fill.sourceRecord);
      for (const c of group) {
        conflicted.add(c);
        recDiag.add("error", "CONFLICTING_TRADE_ID", c.fill.sourceRecord, "trade_id", `trade_id ${q(tid)} appears in records ${recs.join(", ")} with different content`, "None of them is chosen. Check the source export; the same fill id must not have different values.");
      }
      dupCount.conflicting += group.length;
    } else {
      const first = group[0]!.fill.sourceRecord;
      for (const c of group.slice(1)) {
        c.fill.duplicateOf = first;
        c.warnings.push({ severity: "warning", code: "DUPLICATE_TRADE_ID", record: c.fill.sourceRecord, field: "trade_id", message: `Same trade_id and content as record ${first}`, hint: "Kept, and marked with duplicateOf. Remove one copy if the file contains the same fill twice." });
        dupCount.identical++;
      }
    }
  }
  const firstByKey = new Map<string, number>();
  for (const c of candidates) {
    if (c.fill.tradeId !== null || conflicted.has(c)) continue;
    const k = [c.fill.executedAt, c.fill.baseAsset, c.fill.quoteAsset, c.fill.side, decimalKey(c.fill.price), decimalKey(c.fill.quantity)].join("|");
    const first = firstByKey.get(k);
    if (first === undefined) firstByKey.set(k, c.fill.sourceRecord);
    else {
      c.fill.suspectedDuplicateOf = first;
      c.warnings.push({ severity: "warning", code: "SUSPECTED_DUPLICATE", record: c.fill.sourceRecord, field: null, message: `Same time, assets, side, price and quantity as record ${first}, and no trade_id`, hint: "Kept. Separate fills can be identical; without a trade_id TradeCSV cannot tell. Marked with suspectedDuplicateOf." });
      dupCount.suspected++;
    }
  }
  for (const c of conflicted) rejected.add(c.fill.sourceRecord);
  const accepted = candidates.filter((c) => !conflicted.has(c));
  for (const c of candidates) if (!conflicted.has(c)) recDiag.list.push(...c.warnings);

  const summary: Summary = {
    totalRecords: accepted.length + rejected.size,
    acceptedRecords: accepted.length,
    rejectedRecords: rejected.size,
    recordsWithWarnings: accepted.filter((c) => c.warnings.length > 0).length,
    blankRecordsIgnored: blank,
    duplicateCandidates: dupCount,
  };
  const ordered = [...recDiag.list].sort((a, b) => (a.record ?? 0) - (b.record ?? 0)); // stable: keeps field order within a record
  return finish(inputInfo, format, account, [...fileDiag.list, ...ordered], accepted.map((c) => c.fill), [...rejected], summary, unmapped, options.allowPartial === true);
}

function finish(input: Report["input"], format: string | null, account: string, diagnostics: Diagnostic[], fills: NormalizedFill[], _rejected: number[], summary: Partial<Summary> | undefined, unmapped: string[], allowPartial: boolean): ProcessResult {
  const hasError = diagnostics.some((d) => d.severity === "error");
  const fileError = diagnostics.some((d) => d.severity === "error" && d.record === null);
  const full: Summary = {
    totalRecords: null, acceptedRecords: null, rejectedRecords: null, recordsWithWarnings: 0, blankRecordsIgnored: 0,
    duplicateCandidates: { identical: 0, conflicting: 0, suspected: 0 }, ...summary,
  };
  const exportKind = !hasError ? "complete" : allowPartial && !fileError && fills.length > 0 ? "partial" : "none";
  const report: Report = {
    schemaVersion: REPORT_SCHEMA,
    tool: { name: "tradecsv", version: VERSION },
    input, format, account,
    status: hasError ? "failed" : diagnostics.length ? "ok_with_warnings" : "ok",
    export: exportKind,
    summary: full,
    unmappedColumns: unmapped,
    diagnostics,
  };
  return { report, records: exportKind === "none" ? [] : fills, export: exportKind };
}

export { TEMPLATE_FORMAT_ID };
