// OKX 统一交易账单 (Chinese interface), USDT-margined perpetual fills.
// The sample is synthetic (scripts/make-okx-sample.py); expected values below are read off the sample rows by hand.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { processCsv, toNormalizedJson, toSpreadsheetCsv, type ProcessResult } from "../src/index.js";
import { normalizeLineEndings } from "../src/core/csv.js";

const SAMPLE = readFileSync(new URL("../examples/okx/okx-unified-bill-sample.csv", import.meta.url), "utf8");
const codes = (r: ProcessResult) => r.report.diagnostics.map((d) => `${d.code}@${d.record ?? "file"}`);
/** Edit one data row of the sample (records are numbered from the newest row). */
const editRecord = (rec: number, fn: (fields: string[]) => void) => {
  const lines = SAMPLE.split("\n");
  const fields = lines[rec + 1]!.split(",");
  fn(fields);
  lines[rec + 1] = fields.join(",");
  return lines.join("\n");
};

describe("OKX unified bill: recognition and counts", () => {
  const r = processCsv(SAMPLE);
  it("is recognized by its exact header", () => {
    expect(r.report.format).toBe("okx-unified-bill-zh/v1");
    expect(r.export).toBe("complete");
  });
  it("counts fills, non-fills and rejects: total = accepted + rejected + non-fill", () => {
    // 7 data rows: 5 fills, 1 funding payment (资金费收入), 1 transfer (划转/转入)
    expect(r.report.summary).toEqual({ totalRecords: 7, acceptedRecords: 5, rejectedRecords: 0, recordsWithWarnings: 0, blankRecordsIgnored: 0, nonFillRecords: 2, duplicateCandidates: { identical: 0, conflicting: 0, suspected: 0 } });
    expect(codes(r)).toEqual(["NON_FILL_RECORD@1", "NON_FILL_RECORD@3"]);
  });
  it("handles a byte-order mark on every line and mixed CRLF/LF line endings, like the real export", () => {
    expect(SAMPLE.startsWith("﻿")).toBe(true);
    expect(SAMPLE.split("\n").slice(1, 4).every((l) => l.startsWith("﻿"))).toBe(true);
    expect(SAMPLE.indexOf("\r\n")).toBe(SAMPLE.indexOf("\n") - 1); // only the first line ends with CRLF
    expect(r.records.every((x) => !/﻿/.test(JSON.stringify(x)))).toBe(true);
  });
  it("never copies the user id into any output", () => {
    const withId = SAMPLE.replace("用户ID:0000000000000000000", "用户ID:987654321987654321");
    const res = processCsv(withId);
    expect(JSON.stringify(res)).not.toContain("987654321987654321");
    expect(toNormalizedJson(res)).not.toContain("987654321987654321");
  });
});

describe("OKX unified bill: normalized fills (hand-checked)", () => {
  const r = processCsv(SAMPLE);
  const byId = (id: string) => r.records.find((x) => x.tradeId === id)!;
  it("opening long, partial fill of order …001", () => {
    expect(byId("1000000000000000001")).toMatchObject({
      sourceRecord: 7, marketType: "perpetual", instrument: "BTC-USDT-SWAP", baseAsset: "BTC", quoteAsset: "USDT",
      orderId: "2000000000000000001", executedAt: "2026-03-05T02:00:01Z", // 10:00:01 at UTC+8
      side: "buy", positionSide: "long", positionEffect: "open",
      price: "60000.00000000", quantity: "2", quantityUnit: "contracts", quoteAmount: null,
      feeAmount: "0.06000000", feeCurrency: "USDT", // -0.06 in the bill = fee paid
      realizedPnl: "0.00000000", realizedPnlCurrency: "USDT",
    });
    expect(byId("1000000000000000002")).toMatchObject({ orderId: "2000000000000000001", quantity: "3", price: "60010.00000000" });
  });
  it("maps the four trade types to side, position side and open/close", () => {
    const pick = (id: string) => { const f = byId(id); return [f.side, f.positionSide, f.positionEffect]; };
    expect(pick("1000000000000000001")).toEqual(["buy", "long", "open"]); // 开多
    expect(pick("1000000000000000003")).toEqual(["sell", "long", "close"]); // 平多
    expect(pick("1000000000000000004")).toEqual(["sell", "short", "open"]); // 开空
    expect(pick("1000000000000000006")).toEqual(["buy", "short", "close"]); // 平空
  });
  it("keeps the exchange-reported realized P&L and converts times", () => {
    expect(byId("1000000000000000003")).toMatchObject({ realizedPnl: "2.49700000", executedAt: "2026-03-05T10:30:00Z", feeAmount: "0.15125000" });
    expect(byId("1000000000000000006")).toMatchObject({ realizedPnl: "0.10000000", executedAt: "2026-03-06T13:45:30Z", feeAmount: "0.01495000" });
  });
  it("leaves running balances out of sourceValues", () => {
    expect(Object.keys(byId("1000000000000000001").sourceValues)).not.toContain("交易账户余额");
    expect(Object.keys(byId("1000000000000000001").sourceValues)).not.toContain("仓位余额");
  });
});

describe("OKX unified bill: things that are not guessed", () => {
  it("a positive fee is a rebate (negative after normalizing)", () => {
    // record 7: fee -0.06 → +0.06; also adjust the balance change so the identity still holds (−12 + 0 + 0.06 = −11.94)
    const t = editRecord(7, (f) => { f[10] = "0.06000000"; f[14] = "-11.94000000"; });
    const r = processCsv(t);
    expect(r.records.find((x) => x.sourceRecord === 7)!.feeAmount).toBe("-0.06000000");
    expect(codes(r)).not.toContain("BALANCE_MISMATCH@7");
  });
  it("coin-margined and other instruments are rejected as unverified", () => {
    const r = processCsv(editRecord(7, (f) => { f[4] = "BTC-USD-SWAP"; }));
    expect(codes(r)).toContain("UNSUPPORTED_INSTRUMENT@7");
    expect(r.export).toBe("none");
  });
  it("unknown row types are rejected, not dropped", () => {
    expect(codes(processCsv(editRecord(2, (f) => { f[5] = "强平平空"; })))).toContain("UNSUPPORTED_ROW_TYPE@2");
    expect(codes(processCsv(editRecord(3, (f) => { f[5] = "资金费支出"; })))).toContain("UNSUPPORTED_ROW_TYPE@3"); // not seen in the evidence yet
  });
  it("units other than 张 are rejected", () => {
    expect(codes(processCsv(editRecord(7, (f) => { f[7] = "BTC"; })))).toContain("INVALID_UNIT@7");
  });
  it("a missing time zone line is an error, never assumed", () => {
    const r = processCsv(SAMPLE.replace(",﻿时区:UTC+8", ""));
    expect(codes(r)).toEqual(["TIME_ZONE_MISSING@file"]);
  });
  it("other time zones are applied as stated", () => {
    const r = processCsv(SAMPLE.replace("时区:UTC+8", "时区:UTC-5"));
    expect(r.records.find((x) => x.tradeId === "1000000000000000001")!.executedAt).toBe("2026-03-05T15:00:01Z");
  });
  it("flags rows whose balance columns do not add up (beyond one unit in the 8th decimal)", () => {
    expect(codes(processCsv(editRecord(7, (f) => { f[14] = "-12.07000000"; })))).toContain("BALANCE_MISMATCH@7");
    expect(codes(processCsv(editRecord(7, (f) => { f[14] = "-12.06000001"; })))).not.toContain("BALANCE_MISMATCH@7"); // rounding
  });
  it("an OKX export with a different header is not read as this format", () => {
    const r = processCsv(SAMPLE.replace("关联订单id", "订单编号"));
    expect(codes(r)).toEqual(["UNKNOWN_FORMAT@file"]);
  });
  it("same bill id with different content is a conflict", () => {
    const r = processCsv(editRecord(6, (f) => { f[0] = "1000000000000000001"; }));
    expect(codes(r).filter((c) => c.startsWith("CONFLICTING"))).toEqual(["CONFLICTING_TRADE_ID@6", "CONFLICTING_TRADE_ID@7"]);
  });
  it("--format can force the template, and then the file is not accepted", () => {
    expect(processCsv(SAMPLE, { format: "spot-fills-template/0.1" }).report.status).toBe("failed");
  });
});

describe("exports and line endings", () => {
  it("spreadsheet CSV carries the derivative columns", () => {
    const out = toSpreadsheetCsv(processCsv(SAMPLE).records);
    const [head, first] = out.replace("﻿", "").split("\r\n");
    expect(head).toContain('"position_side","position_effect"');
    expect(first).toContain('"perpetual","ETH-USDT-SWAP"'); // records keep the file's order (newest first)
    expect(first).toContain('"10","contracts"');
  });
  it("CRLF inside quoted fields is kept; CRLF between records is not", () => {
    expect(normalizeLineEndings('a,b\r\n"x\r\ny",z\r\n')).toBe('a,b\n"x\r\ny",z\n');
  });
});
