# TradeCSV

Check a spot trade-fill CSV file on your own computer, see exactly which records are wrong and why, and export normalized records that other tools can read without losing precision.

**Example use:** before importing a year of trades into a journal, tax tool or spreadsheet, run TradeCSV to catch rows with missing time zones, unparseable numbers, unknown fee currencies, or two different fills that share one trade id. It tells you the record number and field. It does not guess, and it does not change your file.

Status: **v0.1.0, first release.** The input is the project's own [Spot Fills Template](docs/format.md#3-spot-fills-template-v01), or any CSV described by a [mapping file](docs/format.md#11-mapping-files). No exchange's export format has been verified yet ([docs/formats.md](docs/formats.md)).

## What it supports

| Supported | Not supported in v0.1 |
|---|---|
| Spot fills: one row = one executed trade | Orders, cancellations, derivatives, leverage, positions, deposits, withdrawals |
| UTF-8 CSV, comma separated, RFC 4180 quoting (BOM, CRLF/LF, quoted commas and line breaks) | Other encodings or delimiters |
| Times in ISO 8601 with an offset; with a mapping: naive times at a declared fixed offset, Unix seconds or milliseconds | Guessing a time zone; named time zones with daylight saving |
| Decimals as plain strings (`0.000001234`, `25000000000`) | Exponents, thousands separators, decimal commas |
| Fees in any currency, rebates, unknown fees | P&L, tax, valuation, investment advice |
| Duplicate and conflicting trade ids within one file | Merging accounts or files |

## Install and run (from source)

TradeCSV is not published to npm yet. You need Node.js 22.12 or newer (tested locally on Node 24; CI is configured for Node 22 and 24).

```bash
git clone <repository-url> tradecsv
cd tradecsv
npm ci
npm run build
node dist/cli/main.js check examples/valid-fills.csv
node dist/cli/main.js check examples/broken-fills.csv
node dist/cli/main.js convert examples/valid-fills.csv --out out/valid
```

Optional: `npm link` makes the `tradecsv` command available in your shell.

```text
tradecsv check <input.csv> [--mapping map.json] [--account label] [--json]
tradecsv convert <input.csv> --out <dir> [--mapping map.json] [--account label] [--allow-partial] [--force]
tradecsv template
```

Exit codes: `0` no errors (warnings allowed), `1` data errors found, `2` usage or file problem.

`convert` always writes `report.json`. It writes `normalized.json` and `normalized.csv` only when there are no errors, unless you pass `--allow-partial`, in which case the export contains the accepted records and is marked `"completeness": "partial"`. Existing output files are not overwritten without `--force`.

## Example

Input (`examples/valid-fills.csv`, excerpt):

```csv
trade_id,order_id,executed_at,base_asset,quote_asset,side,price,quantity,quote_amount,fee_amount,fee_currency
000123,9001,2026-03-01T09:30:00Z,BTC,USDT,buy,64000.10,0.00150000,96.000150,0.096,USDT
000125,9002,2026-03-01 17:45:12+08:00,ETH,USDT,sell,3150.5,1.2,3780.60,0.0045,BNB
```

Normalized record (`normalized.json`, excerpt). Decimals and ids stay strings; time is UTC:

```json
{
  "sourceRecord": 3,
  "marketType": "spot",
  "tradeId": "000125",
  "orderId": "9002",
  "executedAt": "2026-03-01T09:45:12Z",
  "baseAsset": "ETH",
  "quoteAsset": "USDT",
  "side": "sell",
  "price": "3150.5",
  "quantity": "1.2",
  "quoteAmount": "3780.60",
  "feeAmount": "0.0045",
  "feeCurrency": "BNB"
}
```

A file with problems (`examples/broken-fills.csv`):

```text
$ node dist/cli/main.js check examples/broken-fills.csv
examples/broken-fills.csv: FAILED (format spot-fills-template/0.1, account default)
  records: 11 total, 4 accepted, 7 rejected, 3 with warnings, 1 blank ignored
  duplicates: 0 identical, 2 conflicting, 1 suspected
  ERROR   INVALID_NUMBER record 1 [price]: price is not a plain decimal number: "1,250.5"
  ERROR   TIME_ZONE_MISSING record 2 [executed_at]: executed_at has no time zone: "2026-03-03 08:01:00"
  ERROR   INVALID_QUANTITY record 3 [quantity]: quantity must be greater than 0 (got -0.1)
  ERROR   INVALID_SIDE record 4 [side]: side is not a recognized value: "long"
  ERROR   CONFLICTING_TRADE_ID record 5 [trade_id]: trade_id "1005" appears in records 5, 6 with different content
  ERROR   CONFLICTING_TRADE_ID record 6 [trade_id]: trade_id "1005" appears in records 5, 6 with different content
  ERROR   ROW_FIELD_COUNT record 7: Record has 9 fields; the header has 11
  warning SUSPECTED_DUPLICATE record 10: Same time, assets, side, price and quantity as record 9, and no trade_id
  warning QUOTE_AMOUNT_MISMATCH record 11 [quote_amount]: quote_amount 850 differs from price × quantity = 800
  warning FEE_CURRENCY_MISSING record 12 [fee_currency]: fee_amount 0.4 has no fee_currency, so the fee is left as unknown
```

Full outputs for all three examples are in [`examples/expected/`](examples/expected).

## Files that do not use the template

Write a mapping file. It only names columns, fixed values and documented options; nothing in it is executed. See [`examples/custom/`](examples/custom) and [docs/format.md §11](docs/format.md#11-mapping-files).

```bash
node dist/cli/main.js convert examples/custom/broker-fills.csv --mapping examples/custom/broker-mapping.json --out out/custom
```

## Library use

The CLI is a thin wrapper around a core library with no file system, network or DOM access, so the same code runs in Node and in browsers.

```ts
import { readFileSync } from "node:fs";
import { processCsv, toNormalizedJson } from "tradecsv";

const result = processCsv(readFileSync("fills.csv"), { account: "main" });
console.log(result.report.status, result.report.summary);
for (const d of result.report.diagnostics) console.log(d.severity, d.code, d.record, d.field, d.message);
if (result.export !== "none") console.log(toNormalizedJson(result));
```

Until the package is published, install it from a local checkout (`npm install ../tradecsv`).

## Rules it follows

The full contract is [docs/format.md](docs/format.md). In short:

- Prices, quantities, amounts, fees and ids are never converted to JavaScript numbers.
- A time without an offset is rejected unless you declare a fixed offset. Your computer's time zone is never used.
- Buy or sell must be stated; it is never inferred from a minus sign.
- A missing fee is unknown (`null`), not `0`. The fee currency is never assumed. A fee sign convention that is not stated leaves the fee `null` with a warning.
- The same trade id with different content is a conflict: all such records are rejected and none is chosen. Identical copies and suspected duplicates are kept and flagged, never deleted.
- `totalRecords = acceptedRecords + rejectedRecords`; blank rows are counted separately. When the CSV structure is broken, the counts are reported as unknown.

## Privacy

Everything runs locally. TradeCSV makes no network requests, has no telemetry and uses no AI model. It reads the input file and writes only the output files you ask for.

## Limits

- Inputs up to 50 MiB by default (`--max-size-mb` to change).
- The spreadsheet CSV adds a leading `'` to text cells that start with `=`, `+`, `-`, `@`, tab or carriage return (OWASP CSV Injection guidance). No escaping is safe in every spreadsheet program, and spreadsheets may still turn long ids into numbers. Treat `normalized.json` as the source of truth.
- Exchange formats are not verified yet; see [docs/formats.md](docs/formats.md) for the evidence required.

## Development

```bash
npm ci
npm run check      # type check, build, tests
npm run examples   # regenerate examples/expected (after npm run build)
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Related tools and how TradeCSV differs: [docs/related-projects.md](docs/related-projects.md).

## License

[MIT](LICENSE)

---

### 中文简介

TradeCSV 在本地检查现货逐笔成交 CSV：逐条指出问题记录和字段（时区缺失、数字格式错误、手续费币种不明、同一成交编号内容冲突等），并导出不丢精度的标准化记录。全部在本机处理，不联网。v0.1 只支持本项目自定义的模板格式和自定义列映射，尚未核验任何交易所的官方导出格式。
