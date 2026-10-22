// OKX "统一交易账单" (Unified bill history) CSV, Simplified Chinese interface — USDT-margined perpetual swap fills.
// Evidence: docs/formats.md, entry 2026-10-22. Only what that export showed is accepted; anything else is reported, not guessed.
import Big from "big.js";
import { Collector, ID_MAX, q, readDecimal, type Candidate, type ReadRecords } from "../core/common.js";
import { isPositive, negateDecimal, withinLastPlace } from "../core/decimal.js";
import { parseTime } from "../core/time.js";

export const OKX_BILL_FORMAT_ID = "okx-unified-bill-zh/v1";

/** Header row of the verified export (each field may start with a byte-order mark in the file; removed before comparing). */
export const OKX_BILL_HEADER = ["id", "关联订单id", "时间", "账单类型", "交易品种", "交易类型", "数量", "交易单位", "成交价", "收益", "手续费", "手续费单位", "仓位余额变动", "仓位余额", "交易账户余额变动", "交易账户余额", "交易账户余额单位"] as const;

/** Trade types that are fills, observed in the evidence export under 账单类型 "永续合约". */
const FILL_TYPES: Record<string, { side: "buy" | "sell"; positionSide: "long" | "short"; positionEffect: "open" | "close" }> = {
  开多: { side: "buy", positionSide: "long", positionEffect: "open" },
  平多: { side: "sell", positionSide: "long", positionEffect: "close" },
  开空: { side: "sell", positionSide: "short", positionEffect: "open" },
  平空: { side: "buy", positionSide: "short", positionEffect: "close" },
};
/** Rows observed in the evidence export that are not fills: excluded and counted. */
const NON_FILL = new Set(["永续合约/资金费收入", "永续合约/自动追加保证金", "划转/转入"]);
/** Only USDT-margined linear swaps were in the evidence. Inverse (USD-SWAP) and other instruments are not verified. */
const INSTRUMENT_RE = /^([A-Z0-9]{1,20})-USDT-SWAP$/;

export const stripBom = (s: string) => s.replace(/^\uFEFF+/, "");
const clean = (row: string[]) => row.map((f) => stripBom(f).trim());

/** True when the first row is the OKX metadata line and the second row is the verified header. */
export function looksLikeOkxBill(rows: string[][]): boolean {
  const meta = rows[0], hdr = rows[1];
  return !!meta && !!hdr && /^用户ID:/.test(stripBom(meta[0] ?? "").trim()) && clean(hdr).join(",") === OKX_BILL_HEADER.join(",");
}

/** Has the metadata line, but the header differs from the verified one. */
export function looksLikeOtherOkxExport(rows: string[][]): boolean {
  return !!rows[0] && /^用户ID:/.test(stripBom(rows[0][0] ?? "").trim()) && !looksLikeOkxBill(rows);
}

/** "时区:UTC+8" in the metadata line → "+08:00", or null when absent or unreadable. The user id is never read or kept. */
export function okxOffset(meta: string[]): string | null {
  for (const f of clean(meta)) {
    const m = /^时区:UTC([+-])(\d{1,2})(?::(\d{2}))?$/.exec(f);
    if (m) { const h = Number(m[2]), mi = Number(m[3] ?? "0"); if (h <= 14 && mi < 60) return `${m[1]}${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`; }
  }
  return null;
}

/** Columns copied to sourceValues: what the record is built from. Running balances are left out (not needed, and personal). */
const SOURCE_COLS = ["id", "关联订单id", "时间", "账单类型", "交易品种", "交易类型", "数量", "交易单位", "成交价", "收益", "手续费", "手续费单位", "仓位余额变动", "交易账户余额变动", "交易账户余额单位"];

export function readOkxBill(dataRows: string[][], utcOffset: string, ctx: { format: string; account: string }): ReadRecords {
  const out: ReadRecords = { candidates: [], diagnostics: [], rejected: new Set(), blank: 0, nonFill: 0 };
  const ix = Object.fromEntries(OKX_BILL_HEADER.map((h, i) => [h, i])) as Record<(typeof OKX_BILL_HEADER)[number], number>;
  dataRows.forEach((raw, i) => {
    const rec = i + 1;
    const row = clean(raw);
    if (row.every((f) => f === "")) { out.blank++; return; }
    if (row.length !== OKX_BILL_HEADER.length) {
      out.diagnostics.push({ severity: "error", code: "ROW_FIELD_COUNT", record: rec, field: null, message: `Record has ${row.length} fields; the header has ${OKX_BILL_HEADER.length}`, hint: "The file may be cut off or edited. Export it again from OKX." });
      out.rejected.add(rec);
      return;
    }
    const v = (h: (typeof OKX_BILL_HEADER)[number]) => row[ix[h]]!;
    const d = new Collector();
    const billType = v("账单类型"), txType = v("交易类型");
    const kind = FILL_TYPES[txType];
    if (!(billType === "永续合约" && kind)) {
      if (NON_FILL.has(`${billType}/${txType}`)) {
        out.nonFill++;
        out.diagnostics.push({ severity: "warning", code: "NON_FILL_RECORD", record: rec, field: "交易类型", message: `Not a trade (${billType} / ${txType}); excluded from the export`, hint: "Funding payments, margin changes and transfers are listed in the report but are not fills." });
      } else {
        out.diagnostics.push({ severity: "error", code: "UNSUPPORTED_ROW_TYPE", record: rec, field: "交易类型", message: `Bill type ${q(billType)} / ${q(txType)} has not been verified`, hint: "TradeCSV only accepts row types it has evidence for. Please report this type (without your personal data) so it can be added." });
        out.rejected.add(rec);
      }
      return;
    }
    // Instrument and assets
    const inst = INSTRUMENT_RE.exec(v("交易品种"));
    if (!inst) d.add("error", "UNSUPPORTED_INSTRUMENT", rec, "交易品种", `Instrument ${q(v("交易品种"))} is not a verified type`, "Only USDT-margined perpetual swaps (BASE-USDT-SWAP) are verified. Coin-margined (USD-SWAP) and delivery futures are not supported yet.");
    if (v("交易单位") !== "张") d.add("error", "INVALID_UNIT", rec, "交易单位", `Quantity unit is ${q(v("交易单位"))}, expected 张 (contracts)`, "Quantities are kept as numbers of contracts; other units have not been verified.");
    // Numbers
    const price = readDecimal(d, rec, "成交价", v("成交价"));
    if (price !== null && !isPositive(price)) d.add("error", "INVALID_PRICE", rec, "成交价", `成交价 must be greater than 0 (got ${price})`, "A fill has a positive price.");
    if (v("成交价") === "") d.add("error", "MISSING_VALUE", rec, "成交价", "成交价 is empty", "A fill needs a price.");
    const qty = readDecimal(d, rec, "数量", v("数量"));
    if (qty !== null && !isPositive(qty)) d.add("error", "INVALID_QUANTITY", rec, "数量", `数量 must be greater than 0 (got ${qty})`, "The quantity of a fill is a positive number of contracts.");
    if (v("数量") === "") d.add("error", "MISSING_VALUE", rec, "数量", "数量 is empty", "A fill needs a quantity.");
    const pnl = readDecimal(d, rec, "收益", v("收益"));
    const feeRaw = readDecimal(d, rec, "手续费", v("手续费"));
    const posChange = readDecimal(d, rec, "仓位余额变动", v("仓位余额变动"));
    const balChange = readDecimal(d, rec, "交易账户余额变动", v("交易账户余额变动"));
    const feeCcy = v("手续费单位"), pnlCcy = v("交易账户余额单位");
    for (const [col, c] of [["手续费单位", feeCcy], ["交易账户余额单位", pnlCcy]] as const) {
      if (!/^[A-Za-z0-9]{1,20}$/.test(c)) d.add("error", "INVALID_ASSET", rec, col, `${col} is not a valid asset code: ${q(c)}`, "Expected a currency such as USDT.");
    }
    // Time: the export states its time zone once, in the metadata line
    const t = parseTime(v("时间"), { format: "naive", utcOffset });
    if (!t.ok) d.add("error", t.code, rec, "时间", t.message, t.hint);
    // Ids
    for (const col of ["id", "关联订单id"] as const) {
      if (v(col) === "") d.add("error", "MISSING_VALUE", rec, col, `${col} is empty`, "OKX bills always carry an id and an order id.");
      else if (v(col).length > ID_MAX) d.add("error", "INVALID_ID", rec, col, `${col} is longer than ${ID_MAX} characters`, "Identifiers are limited to 128 characters.");
    }
    if (d.hasError) { out.diagnostics.push(...d.list); out.rejected.add(rec); return; }

    // Consistency check from the evidence: 交易账户余额变动 = −仓位余额变动 + 收益 + 手续费. In the real export it holds
    // to within one unit of the 8th decimal (the columns are rounded separately), so a 1-unit difference is accepted.
    if (posChange !== null && balChange !== null && pnl !== null && feeRaw !== null) {
      const expected = new Big(pnl).plus(new Big(feeRaw)).minus(new Big(posChange));
      if (!withinLastPlace(expected.toFixed(), balChange)) d.add("warning", "BALANCE_MISMATCH", rec, "交易账户余额变动", `交易账户余额变动 ${balChange} ≠ −仓位余额变动 + 收益 + 手续费 = ${expected.toFixed()}`, "The columns may not mean what TradeCSV assumes for this row. Check it against OKX.");
    }
    const sourceValues: Record<string, string> = {};
    for (const col of SOURCE_COLS) sourceValues[col] = raw[ix[col as (typeof OKX_BILL_HEADER)[number]]]!.replace(/^\uFEFF+/, "");
    const fill: Candidate["fill"] = {
      format: ctx.format, account: ctx.account, sourceRecord: rec,
      marketType: "perpetual", instrument: v("交易品种"),
      tradeId: v("id"), orderId: v("关联订单id"),
      executedAt: (t as { utc: string }).utc,
      baseAsset: inst![1]!, quoteAsset: "USDT",
      side: kind.side, positionSide: kind.positionSide, positionEffect: kind.positionEffect,
      price: price!, quantity: qty!, quantityUnit: "contracts", quoteAmount: null,
      // In this export a fee is a signed change of the account balance (negative = paid), so it is negated.
      feeAmount: feeRaw === null ? null : negateDecimal(feeRaw), feeCurrency: feeRaw === null ? null : feeCcy,
      realizedPnl: pnl, realizedPnlCurrency: pnl === null ? null : pnlCcy,
      duplicateOf: null, suspectedDuplicateOf: null, sourceValues,
    };
    if (feeRaw === null) d.add("warning", "FEE_MISSING", rec, "手续费", "手续费 is empty, so the fee is unknown (null, not 0)", "Export the bill again; OKX normally fills this column.");
    out.candidates.push({ fill, warnings: d.list });
  });
  return out;
}
