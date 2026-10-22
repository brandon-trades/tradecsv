// The whole pipeline: read → recognize the format → validate and normalize each record → duplicates → report.
// Pure function: no file system, no network, no clock. Same input and options → same result.
import { DEFAULT_MAX_BYTES, decodeInput, isBlankRow, parseCsv } from "./csv.js";
import { ASSET_RE, Collector, ID_MAX, q, readDecimal, type Candidate, type ReadRecords } from "./common.js";
import { compareDecimal, decimalKey, isPositive, multiply, negateDecimal, withinLastPlace } from "./decimal.js";
import { validateMapping } from "./mapping.js";
import { sha256Hex } from "./sha256.js";
import { parseTime } from "./time.js";
import {
  REPORT_SCHEMA, REQUIRED_FIELDS,
  type CanonicalField, type Diagnostic, type MappingConfig, type NormalizedFill,
  type ProcessOptions, type ProcessResult, type Report, type Summary,
} from "./types.js";
import { TEMPLATE_FORMAT_ID, TEMPLATE_MAPPING } from "../formats/template.js";
import { OKX_BILL_FORMAT_ID, OKX_BILL_HEADER, looksLikeOkxBill, looksLikeOtherOkxExport, okxOffset, readOkxBill } from "../formats/okx-unified-bill.js";
import { VERSION } from "../version.js";

export function processCsv(input: string | Uint8Array, options: ProcessOptions = {}): ProcessResult {
  const account = (options.account ?? "default").trim() || "default";
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const inputInfo = { sha256: sha256Hex(bytes), bytes: bytes.length };
  const fileDiag = new Collector();
  const fail = (format: string | null, summary?: Partial<Summary>, unmapped: string[] = []): ProcessResult =>
    finish(inputInfo, format, account, fileDiag.list, [], summary, unmapped, false);

  // Mapping
  let mapping: MappingConfig | null = null;
  if (options.mapping !== undefined) {
    const check = validateMapping(options.mapping);
    if (!check.ok) {
      fileDiag.add("error", "INVALID_MAPPING", null, null, `The mapping is invalid: ${check.problems.join(" ")}`, "Fix the mapping file; see docs/format.md §11.");
      return fail(null);
    }
    mapping = check.mapping;
  }
  const choice = options.format ?? "auto";

  // File, encoding, CSV structure
  const decoded = decodeInput(input, maxBytes);
  if (!decoded.ok) { fileDiag.add("error", decoded.code, null, null, decoded.message, decoded.hint); return fail(mapping?.formatId ?? null); }
  const parsed = parseCsv(decoded.text);
  if (!parsed.ok) { fileDiag.add("error", parsed.code, null, null, parsed.message, parsed.hint); return fail(mapping?.formatId ?? null); }
  const allRows = [parsed.table.header, ...parsed.table.rows];

  // Format
  const isOkx = !mapping && choice !== "spot-fills-template/0.1" && looksLikeOkxBill(allRows);
  if (!mapping && choice === OKX_BILL_FORMAT_ID && !isOkx) {
    fileDiag.add("error", "UNKNOWN_FORMAT", null, null, "The file is not an OKX unified bill export with the verified header", `Expected a first line starting with 用户ID: and the header ${OKX_BILL_HEADER.join(",")}.`);
    return fail(OKX_BILL_FORMAT_ID);
  }
  if (!mapping && !isOkx && choice === "auto" && looksLikeOtherOkxExport(allRows)) {
    fileDiag.add("error", "UNKNOWN_FORMAT", null, null, "This looks like an OKX export, but its columns differ from the verified OKX unified bill (Chinese interface)", "Only the 统一交易账单 export from the Simplified Chinese interface is verified. Other OKX exports (other languages, position history) are not supported yet.");
    return fail(null);
  }
  const ctx = { account, format: isOkx ? OKX_BILL_FORMAT_ID : (mapping ?? TEMPLATE_MAPPING).formatId };

  let read: ReadRecords, unmapped: string[] = [];
  if (isOkx) {
    const offset = okxOffset(allRows[0]!);
    if (!offset) {
      fileDiag.add("error", "TIME_ZONE_MISSING", null, "时区", "The export's first line does not state a time zone (时区:UTC±H)", "TradeCSV does not guess the time zone. Export the bill again from OKX.");
      return fail(ctx.format);
    }
    const data = allRows.slice(2);
    if (data.every(isBlankRow)) {
      fileDiag.add("error", "NO_RECORDS", null, null, "The file has a header but no records", "Export a period that contains trades.");
      return fail(ctx.format, { totalRecords: 0, acceptedRecords: 0, rejectedRecords: 0, blankRecordsIgnored: data.length });
    }
    read = readOkxBill(data, offset, ctx);
  } else {
    const r = readTemplate(parsed.table.header, parsed.table.rows, mapping ?? TEMPLATE_MAPPING, mapping === null, ctx, fileDiag);
    if (!r) return fail(ctx.format, fileDiag.list.some((d) => d.code === "NO_RECORDS") ? { totalRecords: 0, acceptedRecords: 0, rejectedRecords: 0, blankRecordsIgnored: parsed.table.rows.length } : undefined, unmappedOf(parsed.table.header, mapping ?? TEMPLATE_MAPPING));
    read = r.read; unmapped = r.unmapped;
  }

  // Duplicates and conflicts (within this file, format and account)
  const { candidates } = read;
  const recDiag: Diagnostic[] = [...read.diagnostics];
  const rejected = new Set(read.rejected);
  const dupCount = { identical: 0, conflicting: 0, suspected: 0 };
  const contentKey = (f: NormalizedFill) => [f.executedAt, f.instrument ?? "", f.baseAsset, f.quoteAsset, f.side, f.positionSide ?? "", f.positionEffect ?? "", decimalKey(f.price), decimalKey(f.quantity), f.orderId ?? "",
    f.quoteAmount === null ? "" : decimalKey(f.quoteAmount), f.feeAmount === null ? "" : decimalKey(f.feeAmount), f.feeCurrency ?? "", f.realizedPnl === null ? "" : decimalKey(f.realizedPnl)].join("|");
  const byId = new Map<string, Candidate[]>();
  for (const c of candidates) if (c.fill.tradeId !== null) byId.set(c.fill.tradeId, [...(byId.get(c.fill.tradeId) ?? []), c]);
  const conflicted = new Set<Candidate>();
  for (const [tid, group] of byId) {
    if (group.length < 2) continue;
    if (new Set(group.map((c) => contentKey(c.fill))).size > 1) {
      const recs = group.map((c) => c.fill.sourceRecord);
      for (const c of group) {
        conflicted.add(c);
        recDiag.push({ severity: "error", code: "CONFLICTING_TRADE_ID", record: c.fill.sourceRecord, field: isOkx ? "id" : "trade_id", message: `Trade id ${q(tid)} appears in records ${recs.join(", ")} with different content`, hint: "None of them is chosen. Check the source export; the same fill id must not have different values." });
      }
      dupCount.conflicting += group.length;
    } else {
      const first = group[0]!.fill.sourceRecord;
      for (const c of group.slice(1)) {
        c.fill.duplicateOf = first;
        c.warnings.push({ severity: "warning", code: "DUPLICATE_TRADE_ID", record: c.fill.sourceRecord, field: isOkx ? "id" : "trade_id", message: `Same trade id and content as record ${first}`, hint: "Kept, and marked with duplicateOf. Remove one copy if the file contains the same fill twice." });
        dupCount.identical++;
      }
    }
  }
  const firstByKey = new Map<string, number>();
  for (const c of candidates) {
    if (c.fill.tradeId !== null || conflicted.has(c)) continue;
    const f = c.fill;
    const k = [f.executedAt, f.instrument ?? "", f.baseAsset, f.quoteAsset, f.side, decimalKey(f.price), decimalKey(f.quantity)].join("|");
    const first = firstByKey.get(k);
    if (first === undefined) firstByKey.set(k, f.sourceRecord);
    else {
      f.suspectedDuplicateOf = first;
      c.warnings.push({ severity: "warning", code: "SUSPECTED_DUPLICATE", record: f.sourceRecord, field: null, message: `Same time, assets, side, price and quantity as record ${first}, and no trade_id`, hint: "Kept. Separate fills can be identical; without a trade_id TradeCSV cannot tell. Marked with suspectedDuplicateOf." });
      dupCount.suspected++;
    }
  }
  for (const c of conflicted) rejected.add(c.fill.sourceRecord);
  const accepted = candidates.filter((c) => !conflicted.has(c));
  for (const c of accepted) recDiag.push(...c.warnings);

  const summary: Summary = {
    totalRecords: accepted.length + rejected.size + read.nonFill,
    acceptedRecords: accepted.length,
    rejectedRecords: rejected.size,
    recordsWithWarnings: accepted.filter((c) => c.warnings.length > 0).length,
    blankRecordsIgnored: read.blank,
    nonFillRecords: read.nonFill,
    duplicateCandidates: dupCount,
  };
  const ordered = recDiag.sort((a, b) => (a.record ?? 0) - (b.record ?? 0)); // stable: keeps field order within a record
  return finish(inputInfo, ctx.format, account, [...fileDiag.list, ...ordered], accepted.map((c) => c.fill), summary, unmapped, options.allowPartial === true);
}

const unmappedOf = (header: string[], m: MappingConfig) => {
  const used = new Set(Object.values(m.columns).map((c) => c.trim()));
  return header.filter((h) => h !== "" && !used.has(h));
};

/** Spot Fills Template v0.1, or a spot CSV described by a mapping (docs/format.md §3, §11). Returns null on a file-level error. */
function readTemplate(header: string[], rows: string[][], mapping: MappingConfig, isTemplate: boolean, ctx: { format: string; account: string }, fileDiag: Collector): { read: ReadRecords; unmapped: string[] } | null {
  const seen = new Map<string, number>();
  const dups = new Set<string>();
  header.forEach((h, i) => { if (h !== "") { if (seen.has(h)) dups.add(h); else seen.set(h, i); } });
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
    if (noneFound) fileDiag.add("error", "UNKNOWN_FORMAT", null, null, "The header does not match the Spot Fills Template v0.1 or a verified exchange format, and no mapping was given", "Rename the columns to the template names (tradecsv template) or pass a mapping file (--mapping). Verified exchange formats: docs/formats.md.");
    else fileDiag.add("error", "MISSING_REQUIRED_COLUMN", null, null, `Missing column(s): ${missing.map(q).join(", ")}`, isTemplate ? "Template columns: executed_at, base_asset, quote_asset, side, price, quantity are required." : "Check the column names in the mapping against the file's header (case matters).");
  }
  if (fileDiag.hasError) return null;
  if (rows.every(isBlankRow)) {
    fileDiag.add("error", "NO_RECORDS", null, null, "The file has a header but no records", "Export a period that contains fills.");
    return null;
  }
  const feeMapped = colIndex.fee_amount !== undefined;
  if (!feeMapped) fileDiag.add("warning", "FEE_MISSING", null, "fee_amount", "The file has no fee column, so every fee is unknown (null)", "Add fee_amount and fee_currency if the source provides them.");

  const read: ReadRecords = { candidates: [], diagnostics: [], rejected: new Set(), blank: 0, nonFill: 0 };
  rows.forEach((row, i) => {
    const rec = i + 1;
    if (isBlankRow(row)) { read.blank++; return; }
    if (row.length !== header.length) {
      read.diagnostics.push({ severity: "error", code: "ROW_FIELD_COUNT", record: rec, field: null, message: `Record has ${row.length} fields; the header has ${header.length}`, hint: "Check for missing or extra commas, or an unquoted comma inside a value." });
      read.rejected.add(rec);
      return;
    }
    const d = new Collector();
    const raw = (f: CanonicalField): string | undefined => { const idx = colIndex[f]; return idx === undefined ? undefined : row[idx]; };
    const sourceValues: Record<string, string> = {};
    for (const f of Object.keys(colIndex) as CanonicalField[]) sourceValues[f] = raw(f)!;
    const fixed = (f: CanonicalField) => (f === "base_asset" || f === "quote_asset" || f === "fee_currency" ? mapping.fixed?.[f] : undefined);
    const val = (f: CanonicalField): string => (raw(f) ?? fixed(f) ?? "").trim();
    const err = (code: Diagnostic["code"], f: string | null, m: string, h: string) => d.add("error", code, rec, f, m, h);
    const warn = (code: Diagnostic["code"], f: string | null, m: string, h: string) => d.add("warning", code, rec, f, m, h);

    for (const f of REQUIRED_FIELDS) if (val(f) === "") err("MISSING_VALUE", f, `${f} is empty`, "Every record needs executed_at, base_asset, quote_asset, side, price and quantity.");
    let executedAt = "";
    if (val("executed_at") !== "") {
      const t = parseTime(val("executed_at"), mapping.time ?? { format: "iso" });
      if (t.ok) executedAt = t.utc; else err(t.code, "executed_at", t.message, t.hint);
    }
    const asset = (f: "base_asset" | "quote_asset") => {
      const v = val(f);
      if (v !== "" && !ASSET_RE.test(v)) err("INVALID_ASSET", f, `${f} is not a valid asset code: ${q(v)}`, "Use letters, digits, dot, underscore or dash, e.g. BTC or USDT.");
      return v;
    };
    const base = asset("base_asset"), quote = asset("quote_asset");
    if (base && quote && base.toLowerCase() === quote.toLowerCase()) err("SAME_BASE_AND_QUOTE", "quote_asset", `base_asset and quote_asset are both ${q(base)}`, "Check the asset columns.");
    let side: "buy" | "sell" | null = null;
    const sv = val("side");
    if (sv !== "") {
      if (mapping.side) side = mapping.side.buy.includes(sv) ? "buy" : mapping.side.sell.includes(sv) ? "sell" : null;
      else side = sv.toLowerCase() === "buy" ? "buy" : sv.toLowerCase() === "sell" ? "sell" : null;
      if (!side) err("INVALID_SIDE", "side", `side is not a recognized value: ${q(sv)}`, mapping.side ? `Accepted: ${[...mapping.side.buy, ...mapping.side.sell].map(q).join(", ")}.` : "Use buy or sell.");
    }
    const price = readDecimal(d, rec, "price", val("price"));
    if (price !== null && !isPositive(price)) err("INVALID_PRICE", "price", `price must be greater than 0 (got ${price})`, "Spot fills have a positive price.");
    const quantity = readDecimal(d, rec, "quantity", val("quantity"));
    if (quantity !== null && !isPositive(quantity)) err("INVALID_QUANTITY", "quantity", `quantity must be greater than 0 (got ${quantity})`, "Quantity is the base amount filled. Buy or sell comes from the side column; TradeCSV does not infer it from a minus sign.");
    const quoteAmount = readDecimal(d, rec, "quote_amount", val("quote_amount"));
    if (quoteAmount !== null && compareDecimal(quoteAmount, "0") < 0) err("INVALID_NUMBER", "quote_amount", `quote_amount must not be negative (got ${quoteAmount})`, "quote_amount is the reported value of the fill, excluding fees.");
    const id = (f: "trade_id" | "order_id") => {
      const v = val(f);
      if (v.length > ID_MAX) err("INVALID_ID", f, `${f} is longer than ${ID_MAX} characters`, "Identifiers are limited to 128 characters.");
      return v === "" ? null : v;
    };
    const tradeId = id("trade_id"), orderId = id("order_id");
    let feeAmount: string | null = null, feeCurrency: string | null = null;
    if (feeMapped) {
      const fa = val("fee_amount"), fc = val("fee_currency");
      if (fc !== "" && !ASSET_RE.test(fc)) err("INVALID_ASSET", "fee_currency", `fee_currency is not a valid asset code: ${q(fc)}`, "Use an asset code like USDT or BNB.");
      if (fa === "") warn("FEE_MISSING", "fee_amount", "fee_amount is empty, so the fee is unknown (null, not 0)", "Fill in the fee if the source has it.");
      else {
        const amt = readDecimal(d, rec, "fee_amount", fa);
        const sign = mapping.fee?.sign ?? "cost_positive";
        if (amt !== null) {
          if (fc === "") warn("FEE_CURRENCY_MISSING", "fee_currency", `fee_amount ${amt} has no fee_currency, so the fee is left as unknown`, "TradeCSV never assumes the fee currency. Fill in fee_currency or map it.");
          else if (sign === "unknown") { feeCurrency = fc; warn("FEE_SIGN_UNKNOWN", "fee_amount", `The fee sign convention is unknown, so fee_amount ${amt} is left as null (raw value kept in sourceValues)`, "Set fee.sign in the mapping once you know whether the source shows fees as positive or negative."); }
          else { feeAmount = sign === "cost_negative" ? negateDecimal(amt) : amt; feeCurrency = fc; }
        }
      }
    }
    if (d.hasError) { read.diagnostics.push(...d.list); read.rejected.add(rec); return; }
    if (quoteAmount !== null) {
      const exact = multiply(price!, quantity!);
      if (!withinLastPlace(exact, quoteAmount)) warn("QUOTE_AMOUNT_MISMATCH", "quote_amount", `quote_amount ${quoteAmount} differs from price × quantity = ${exact}`, "Both values are kept. Check whether the amount includes fees or comes from another fill.");
    }
    read.candidates.push({
      fill: { format: ctx.format, account: ctx.account, sourceRecord: rec, marketType: "spot", instrument: null, tradeId, orderId, executedAt, baseAsset: base, quoteAsset: quote,
        side: side!, positionSide: null, positionEffect: null, price: price!, quantity: quantity!, quantityUnit: "base", quoteAmount, feeAmount, feeCurrency,
        realizedPnl: null, realizedPnlCurrency: null, duplicateOf: null, suspectedDuplicateOf: null, sourceValues },
      warnings: d.list,
    });
  });
  return { read, unmapped };
}

function finish(input: Report["input"], format: string | null, account: string, diagnostics: Diagnostic[], fills: NormalizedFill[], summary: Partial<Summary> | undefined, unmapped: string[], allowPartial: boolean): ProcessResult {
  const hasError = diagnostics.some((d) => d.severity === "error");
  const fileError = diagnostics.some((d) => d.severity === "error" && d.record === null);
  const full: Summary = {
    totalRecords: null, acceptedRecords: null, rejectedRecords: null, recordsWithWarnings: 0, blankRecordsIgnored: 0, nonFillRecords: 0,
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

export { TEMPLATE_FORMAT_ID, OKX_BILL_FORMAT_ID };
