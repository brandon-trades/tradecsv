// Expected values in these tests were worked out by hand from the inputs (see comments), not produced by the code under test.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { processCsv, toNormalizedJson, toSpreadsheetCsv, validateMapping, type MappingConfig, type ProcessResult } from "../src/index.js";

const H = "trade_id,order_id,executed_at,base_asset,quote_asset,side,price,quantity,quote_amount,fee_amount,fee_currency";
const csv = (...rows: string[]) => [H, ...rows].join("\n") + "\n";
const codes = (r: ProcessResult) => r.report.diagnostics.map((d) => `${d.code}@${d.record ?? "file"}`);
const ex = (p: string) => readFileSync(new URL(`../examples/${p}`, import.meta.url));

describe("1. normal buy and sell fills", () => {
  const r = processCsv(ex("valid-fills.csv"));
  it("accepts every record and reports counts", () => {
    expect(r.report.summary).toMatchObject({ totalRecords: 6, acceptedRecords: 6, rejectedRecords: 0, recordsWithWarnings: 1, blankRecordsIgnored: 0 });
    expect(r.report.status).toBe("ok_with_warnings");
    expect(r.export).toBe("complete");
  });
  it("normalizes the first fill exactly", () => {
    expect(r.records[0]).toMatchObject({
      sourceRecord: 1, marketType: "spot", tradeId: "000123", orderId: "9001", executedAt: "2026-03-01T09:30:00Z",
      baseAsset: "BTC", quoteAsset: "USDT", side: "buy", price: "64000.10", quantity: "0.00150000", quoteAmount: "96.000150",
      feeAmount: "0.096", feeCurrency: "USDT",
    });
    expect(r.records[2]).toMatchObject({ side: "sell", baseAsset: "ETH" });
  });
});

describe("2. one order with several fills", () => {
  it("keeps every fill of order 9001", () => {
    const r = processCsv(ex("valid-fills.csv"));
    expect(r.records.filter((x) => x.orderId === "9001").map((x) => x.tradeId)).toEqual(["000123", "000124"]);
  });
});

describe("3. precision and identifiers", () => {
  const r = processCsv(ex("valid-fills.csv"));
  it("keeps tiny prices, huge quantities, long ids and leading zeros as text", () => {
    const pepe = r.records[3]!;
    expect(pepe.price).toBe("0.000001234");
    expect(pepe.quantity).toBe("25000000000");
    expect(r.records[5]!.tradeId).toBe("9876543210987654321"); // > 2^53, would lose digits as a Number
    expect(r.records[0]!.tradeId).toBe("000123");
  });
  it("accepts reported amounts that match price × quantity exactly (0.000001234 × 25000000000 = 30850)", () => {
    expect(r.report.diagnostics.some((d) => d.code === "QUOTE_AMOUNT_MISMATCH")).toBe(false);
  });
  it("rejects numbers that are not plain decimals instead of parsing a prefix", () => {
    for (const bad of ["1e-5", "1,000", "0,5", ".5", "5.", "1 000", "NaN", "Infinity", "12abc", "0x10", "$5"]) {
      const res = processCsv(csv(`1,,2026-01-01T00:00:00Z,BTC,USDT,buy,"${bad}",1,,,`));
      expect(codes(res), bad).toContain("INVALID_NUMBER@1");
    }
  });
  it("normalizes +, leading zeros and negative zero without changing precision", () => {
    const res = processCsv(csv("1,,2026-01-01T00:00:00Z,BTC,USDT,buy,+0064000.500,001.10,,-0.000,USDT"));
    expect(res.records[0]).toMatchObject({ price: "64000.500", quantity: "1.10", feeAmount: "0.000" });
  });
});

describe("4. fee currencies and unknown fees", () => {
  const r = processCsv(ex("valid-fills.csv"));
  it("keeps fee amount and currency separate: quote, base and third currency", () => {
    expect([r.records[0]!.feeCurrency, r.records[1]!.feeCurrency, r.records[2]!.feeCurrency]).toEqual(["USDT", "BTC", "BNB"]);
    expect(r.records[1]!.feeAmount).toBe("0.0000005");
  });
  it("keeps a missing fee as unknown, not 0", () => {
    expect(r.records[4]).toMatchObject({ feeAmount: null, feeCurrency: null });
    expect(codes(r)).toContain("FEE_MISSING@5");
  });
  it("never assumes the fee currency", () => {
    const res = processCsv(csv("1,,2026-01-01T00:00:00Z,BTC,USDT,buy,10,1,,0.01,"));
    expect(res.records[0]).toMatchObject({ feeAmount: null, feeCurrency: null });
    expect(res.records[0]!.sourceValues.fee_amount).toBe("0.01");
    expect(codes(res)).toContain("FEE_CURRENCY_MISSING@1");
  });
  it("reports one file-level warning when there is no fee column at all", () => {
    const res = processCsv("executed_at,base_asset,quote_asset,side,price,quantity\n2026-01-01T00:00:00Z,BTC,USDT,buy,10,1\n");
    expect(codes(res)).toEqual(["FEE_MISSING@file"]);
    expect(res.records[0]!.feeAmount).toBeNull();
  });
});

describe("5. rebates and fee sign conventions", () => {
  const base: MappingConfig = {
    schemaVersion: "tradecsv.mapping/0.1", formatId: "t",
    columns: { executed_at: "t", base_asset: "b", quote_asset: "q", side: "s", price: "p", quantity: "n", fee_amount: "f", fee_currency: "fc" },
    fee: { sign: "cost_positive" },
  };
  const file = "t,b,q,s,p,n,f,fc\n2026-01-01T00:00:00Z,BTC,USDT,buy,10,1,-0.5,USDT\n2026-01-01T00:00:01Z,BTC,USDT,buy,10,1,0.2,USDT\n";
  it("template: negative fee is a rebate", () => {
    expect(processCsv(ex("valid-fills.csv")).records[3]!.feeAmount).toBe("-0.5");
  });
  it("cost_negative sources are negated (fee -0.126 paid → 0.126; +0.01 rebate → -0.01)", () => {
    const m = JSON.parse(ex("custom/broker-mapping.json").toString());
    const r = processCsv(ex("custom/broker-fills.csv"), { mapping: m });
    expect(r.records.map((x) => x.feeAmount)).toEqual(["0.126", "0.063001", "-0.01"]);
  });
  it("cost_positive sources are copied", () => {
    expect(processCsv(file, { mapping: base }).records.map((x) => x.feeAmount)).toEqual(["-0.5", "0.2"]);
  });
  it("unknown sign: fee left null with a warning, raw value kept, no absolute value taken", () => {
    const r = processCsv(file, { mapping: { ...base, fee: { sign: "unknown" } } });
    expect(r.records.map((x) => x.feeAmount)).toEqual([null, null]);
    expect(r.records[0]!.sourceValues.fee_amount).toBe("-0.5");
    expect(r.records[0]!.feeCurrency).toBe("USDT");
    expect(codes(r)).toEqual(["FEE_SIGN_UNKNOWN@1", "FEE_SIGN_UNKNOWN@2"]);
  });
  it("a mapping with fee_amount must declare the sign convention", () => {
    const { fee: _f, ...noSign } = base;
    const v = validateMapping(noSign);
    expect(v.ok).toBe(false);
  });
});

describe("6. time", () => {
  const one = (t: string, mapping?: MappingConfig) => processCsv(t === "" ? "" : `executed_at,base_asset,quote_asset,side,price,quantity\n${t},BTC,USDT,buy,10,1\n`, mapping ? { mapping } : {});
  it("converts offsets to UTC (hand-checked)", () => {
    expect(processCsv(ex("valid-fills.csv")).records.map((x) => x.executedAt)).toEqual([
      "2026-03-01T09:30:00Z", "2026-03-01T09:30:00.250Z", "2026-03-01T09:45:12Z", "2026-03-02T06:00:00Z", "2026-03-02T10:15:00Z", "2026-03-02T10:20:00.123456Z",
    ]);
    expect(one("2025-12-31T23:30:00-01:00").records[0]!.executedAt).toBe("2026-01-01T00:30:00Z"); // crosses a year
    expect(one("2024-03-01T05:00:00+08:00").records[0]!.executedAt).toBe("2024-02-29T21:00:00Z"); // leap day
  });
  it("rejects times without an offset instead of guessing", () => {
    expect(codes(one("2026-03-03 08:01:00"))).toContain("TIME_ZONE_MISSING@1");
    expect(codes(one("2026-03-03T08:01:00"))).toContain("TIME_ZONE_MISSING@1");
  });
  it("rejects ambiguous or invalid forms", () => {
    for (const t of ["03/04/2026 08:00", "2026-02-30T00:00:00Z", "2026-03-01T24:00:00Z", "2026-03-01T23:59:60Z", "2026-03-01T10:00:00+15:00", "1772357400", "2026-03-01T10:00Z"]) {
      expect(one(t).report.status, t).toBe("failed");
    }
  });
  const m = (time: MappingConfig["time"]): MappingConfig => ({ schemaVersion: "tradecsv.mapping/0.1", formatId: "t", columns: { executed_at: "executed_at", base_asset: "base_asset", quote_asset: "quote_asset", side: "side", price: "price", quantity: "quantity" }, time });
  it("naive times need an explicit fixed offset", () => {
    expect(one("2026-03-04 09:00:00", m({ format: "naive", utcOffset: "+08:00" })).records[0]!.executedAt).toBe("2026-03-04T01:00:00Z");
    expect(codes(one("2026-03-04T09:00:00Z", m({ format: "naive", utcOffset: "+08:00" })))).toContain("INVALID_TIME@1");
    expect(validateMapping(m({ format: "naive" })).ok).toBe(false);
  });
  it("epoch seconds and milliseconds are explicit and range-checked", () => {
    expect(one("1772357400", m({ format: "epoch_seconds" })).records[0]!.executedAt).toBe("2026-03-01T09:30:00Z");
    expect(one("1772357400123", m({ format: "epoch_milliseconds" })).records[0]!.executedAt).toBe("2026-03-01T09:30:00.123Z");
    expect(codes(one("1772357400123", m({ format: "epoch_seconds" })))).toContain("TIME_OUT_OF_RANGE@1"); // ms read as s
    expect(codes(one("1772357400", m({ format: "epoch_milliseconds" })))).toContain("TIME_OUT_OF_RANGE@1"); // s read as ms
    expect(codes(one("1772357400.5", m({ format: "epoch_seconds" })))).toContain("INVALID_TIME@1");
  });
});

describe("7. duplicates and conflicts", () => {
  it("same id, same content: both kept, later one flagged", () => {
    const r = processCsv(csv("7,o,2026-01-01T00:00:00Z,BTC,USDT,buy,10.0,1,,0.1,USDT", "7,o,2026-01-01T00:00:00Z,BTC,USDT,buy,10,1.00,,0.10,USDT"));
    expect(r.records.map((x) => x.duplicateOf)).toEqual([null, 1]);
    expect(r.report.summary).toMatchObject({ acceptedRecords: 2, duplicateCandidates: { identical: 1, conflicting: 0, suspected: 0 } });
    expect(r.report.status).toBe("ok_with_warnings");
  });
  it("same id, different content: all rejected, none chosen", () => {
    const r = processCsv(ex("broken-fills.csv"));
    expect(codes(r).filter((c) => c.startsWith("CONFLICTING_TRADE_ID"))).toEqual(["CONFLICTING_TRADE_ID@5", "CONFLICTING_TRADE_ID@6"]);
    expect(r.report.summary.duplicateCandidates.conflicting).toBe(2);
  });
  it("no id, identical values: suspected duplicate, kept", () => {
    const r = processCsv(ex("broken-fills.csv"), { allowPartial: true });
    const rec10 = r.records.find((x) => x.sourceRecord === 10)!;
    expect(rec10.suspectedDuplicateOf).toBe(9);
    expect(r.report.summary.duplicateCandidates.suspected).toBe(1);
  });
});

describe("8. CSV structure", () => {
  it("handles BOM, CRLF, quotes, commas and line breaks inside fields", () => {
    const text = "﻿executed_at,base_asset,quote_asset,side,price,quantity,trade_id\r\n2026-01-01T00:00:00Z,BTC,USDT,buy,10,1,\"a,\"\"b\"\"\nc\"\r\n";
    const r = processCsv(new TextEncoder().encode(text));
    expect(r.records[0]!.tradeId).toBe('a,"b"\nc');
    expect(r.report.summary.totalRecords).toBe(1);
  });
  it("rejects duplicate headers instead of renaming them", () => {
    const r = processCsv("executed_at,base_asset,quote_asset,side,price,quantity,price\n2026-01-01T00:00:00Z,BTC,USDT,buy,10,1,11\n");
    expect(codes(r)).toEqual(["DUPLICATE_HEADER@file"]);
    expect(r.report.summary.totalRecords).toBeNull();
  });
  it("rejects rows with the wrong number of fields", () => {
    expect(codes(processCsv(ex("broken-fills.csv")))).toContain("ROW_FIELD_COUNT@7");
  });
  it("reports unbalanced quotes as malformed with unknown counts", () => {
    const r = processCsv('executed_at,base_asset,quote_asset,side,price,quantity\n2026-01-01T00:00:00Z,BTC,USDT,buy,"10,1\n');
    expect(codes(r)).toEqual(["MALFORMED_CSV@file"]);
    expect(r.report.summary).toMatchObject({ totalRecords: null, acceptedRecords: null, rejectedRecords: null });
    expect(r.export).toBe("none");
  });
  it("rejects UTF-16 and invalid UTF-8", () => {
    expect(codes(processCsv(new Uint8Array([0xff, 0xfe, 0x61, 0x00])))).toEqual(["UNSUPPORTED_ENCODING@file"]);
    expect(codes(processCsv(new Uint8Array([0x61, 0x2c, 0xc3, 0x28])))).toEqual(["INVALID_UTF8@file"]);
  });
});

describe("9. locating problems and counting", () => {
  const r = processCsv(ex("broken-fills.csv"));
  it("locates each error by record and field", () => {
    expect(codes(r)).toEqual([
      "INVALID_NUMBER@1", "TIME_ZONE_MISSING@2", "INVALID_QUANTITY@3", "INVALID_SIDE@4", "CONFLICTING_TRADE_ID@5", "CONFLICTING_TRADE_ID@6",
      "ROW_FIELD_COUNT@7", "SUSPECTED_DUPLICATE@10", "QUOTE_AMOUNT_MISMATCH@11", "FEE_CURRENCY_MISSING@12",
    ]);
    expect(r.report.diagnostics[0]).toMatchObject({ severity: "error", field: "price" });
  });
  it("counts: total = accepted + rejected, blank excluded, overlaps not added", () => {
    // 12 rows after the header: 1 blank (row 8), 7 rejected (1-7), 4 accepted (9-12).
    expect(r.report.summary).toEqual({ totalRecords: 11, acceptedRecords: 4, rejectedRecords: 7, recordsWithWarnings: 3, blankRecordsIgnored: 1, nonFillRecords: 0, duplicateCandidates: { identical: 0, conflicting: 2, suspected: 1 } });
  });
  it("exports nothing by default when there are errors", () => {
    expect(r.export).toBe("none");
    expect(r.records).toEqual([]);
    expect(() => toNormalizedJson(r)).toThrow();
  });
  it("partial export only when enabled, and marked as partial", () => {
    const p = processCsv(ex("broken-fills.csv"), { allowPartial: true });
    expect(p.export).toBe("partial");
    expect(p.records.map((x) => x.sourceRecord)).toEqual([9, 10, 11, 12]);
    const doc = JSON.parse(toNormalizedJson(p));
    expect(doc.completeness).toBe("partial");
    expect(doc.excluded).toEqual({ records: 7, byCode: { INVALID_NUMBER: 1, TIME_ZONE_MISSING: 1, INVALID_QUANTITY: 1, INVALID_SIDE: 1, CONFLICTING_TRADE_ID: 2, ROW_FIELD_COUNT: 1 } });
  });
});

describe("10. edge cases at file level", () => {
  it("empty file", () => expect(codes(processCsv(""))).toEqual(["EMPTY_FILE@file"]));
  it("header only", () => {
    const r = processCsv(H + "\n");
    expect(codes(r)).toEqual(["NO_RECORDS@file"]);
    expect(r.report.summary.totalRecords).toBe(0);
  });
  it("no valid records", () => {
    const r = processCsv(csv("1,,bad,BTC,USDT,buy,10,1,,,"), { allowPartial: true });
    expect(r.export).toBe("none");
    expect(r.report.summary).toMatchObject({ totalRecords: 1, acceptedRecords: 0, rejectedRecords: 1 });
  });
  it("file over the size limit", () => expect(codes(processCsv(csv("1,,2026-01-01T00:00:00Z,BTC,USDT,buy,10,1,,,"), { maxBytes: 50 }))).toEqual(["FILE_TOO_LARGE@file"]));
  it("unknown format", () => expect(codes(processCsv("Date,Pair,Type\n1,2,3\n"))).toEqual(["UNKNOWN_FORMAT@file"]));
  it("partially matching header lists the missing columns", () => {
    const r = processCsv("executed_at,base_asset,price,quantity\n2026-01-01T00:00:00Z,BTC,10,1\n");
    expect(codes(r)).toEqual(["MISSING_REQUIRED_COLUMN@file"]);
    expect(r.report.diagnostics[0]!.message).toContain("quote_asset");
  });
  it("invalid mapping is rejected before reading the file", () => {
    const r = processCsv(H + "\n", { mapping: { schemaVersion: "x" } as never });
    expect(codes(r)).toEqual(["INVALID_MAPPING@file"]);
  });
});

describe("11. JSON values vs spreadsheet escaping", () => {
  const file = csv("=1+1,@SUM(A1),2026-01-01T00:00:00Z,BTC,USDT,sell,10,1,,-0.5,USDT", "-007,+x,2026-01-01T00:00:01Z,BTC,USDT,buy,10,1,,,");
  const r = processCsv(file);
  it("JSON keeps the real values", () => {
    expect(r.records.map((x) => [x.tradeId, x.orderId])).toEqual([["=1+1", "@SUM(A1)"], ["-007", "+x"]]);
    expect(r.records[0]!.feeAmount).toBe("-0.5");
  });
  it("spreadsheet CSV neutralizes formula-like text but not plain numbers", () => {
    const out = toSpreadsheetCsv(r.records);
    expect(out.startsWith("﻿")).toBe(true);
    expect(out).toContain(`"'=1+1","'@SUM(A1)"`);
    expect(out).toContain(`"-0.5","USDT"`); // a plain negative number stays numeric
    expect(out).toContain(`"-007","'+x"`); // "-007" is a plain decimal string; "+x" is text
    expect(r.records[0]!.tradeId).toBe("=1+1"); // unchanged after export
  });
});

describe("12. determinism", () => {
  it("same input and options give identical output", () => {
    const a = processCsv(ex("broken-fills.csv"), { allowPartial: true });
    const b = processCsv(ex("broken-fills.csv"), { allowPartial: true });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(toNormalizedJson(a)).toBe(toNormalizedJson(b));
  });
  it("records the input hash (sha256 of 'abc' is the FIPS 180-2 test vector)", async () => {
    const { sha256Hex } = await import("../src/core/sha256.js");
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("version", () => {
  it("matches package.json", async () => {
    const { VERSION } = await import("../src/version.js");
    expect(VERSION).toBe(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  });
});
