# TradeCSV data contract (v0.2)

This document is the specification. The code follows it; if they disagree, that is a bug.

- Normalized output schema: `tradecsv.normalized/0.2`
- Diagnostic report schema: `tradecsv.report/0.2`
- Mapping file schema: `tradecsv.mapping/0.1`
- Input formats:
  - **Spot Fills Template v0.1** (format id `spot-fills-template/0.1`), defined by this project
  - **OKX unified bill, Chinese interface** (format id `okx-unified-bill-zh/v1`): USDT-margined perpetual fills, verified against a real export (§14, `docs/formats.md`)

Changes from v0.1: records gained `instrument`, `positionSide`, `positionEffect`, `quantityUnit`, `realizedPnl` and `realizedPnlCurrency`; `marketType` can be `perpetual`; the summary gained `nonFillRecords`.

## 1. What one input row means

Every data row is **one executed fill**: a single trade that actually happened, at one price and quantity. In the template and in mappings it is a spot fill. In the OKX unified bill it is a USDT-margined perpetual swap fill (§14); rows in that export that are not fills (funding, margin changes, transfers) are counted and excluded.

- An order can produce several fills. Each fill is its own row, and all of them are kept.
- Rows that describe orders (open, cancelled, unfilled, or order totals) are **not** fills. TradeCSV cannot tell them apart on its own, so do not put them in the file.
- One file = one account and one export. Records from different accounts must not be mixed in one file.
- Out of scope: positions and position history, coin-margined and delivery futures, options, deposits and withdrawals, P&L calculation, tax, valuation. Realized P&L is only passed through when the exchange reports it per fill.

## 2. File-level rules

| Rule | v0.1 behaviour |
|---|---|
| Encoding | UTF-8 only. A UTF-8 byte-order mark is accepted and removed. UTF-16 BOMs are rejected (`UNSUPPORTED_ENCODING`); invalid UTF-8 bytes are rejected (`INVALID_UTF8`). |
| Delimiter | Comma only. |
| Quoting | RFC 4180 double quotes. Fields may contain commas, `""` (an escaped quote) and line breaks. |
| Line endings | CRLF or LF. |
| Size | Default limit 50 MiB (`FILE_TOO_LARGE`). Configurable in the CLI with `--max-size-mb`. |
| Header | The first row is the header. Header names are compared after trimming surrounding spaces; nothing else is changed (case matters). |
| Duplicate headers | Rejected (`DUPLICATE_HEADER`). Columns are never silently renamed. |
| Missing columns | Each required column must exist (`MISSING_REQUIRED_COLUMN`). |
| Extra columns | Ignored and listed in the report as `unmappedColumns`. Their contents are not copied anywhere. |
| Broken quoting | If the CSV structure cannot be parsed reliably (`MALFORMED_CSV`), record counts are reported as `null` (unknown) and nothing is exported. |

### Records, numbering and blank rows

- **Record number** (`sourceRecord`) is the 1-based position of a row after the header, counting blank rows. When no field contains a line break, record *N* is on line *N + 1* of the file.
- A row whose fields are all empty (after trimming spaces) is a **blank record**. Blank records are ignored, counted in `blankRecordsIgnored`, and are **not** part of `totalRecords`.
- A row with a different number of fields than the header is rejected (`ROW_FIELD_COUNT`).

## 3. Spot Fills Template v0.1

Column names are exact (lower case, underscores). Column order does not matter.

| Column | Required | Meaning |
|---|---|---|
| `trade_id` | no | Identifier of the fill, unique per account within this export. Kept as text (leading zeros preserved). Strongly recommended: duplicate detection relies on it. |
| `order_id` | no | Identifier of the order that produced the fill. Several fills may share it. Kept as text. |
| `executed_at` | yes | Time of the fill, ISO 8601 **with** a UTC offset: `2026-03-01T09:30:00Z`, `2026-03-01T17:30:00.125+08:00`. A space may replace the `T`. |
| `base_asset` | yes | Asset bought or sold, e.g. `BTC`. |
| `quote_asset` | yes | Asset the price is expressed in, e.g. `USDT`. |
| `side` | yes | `buy` or `sell` (case-insensitive), from the point of view of the base asset. |
| `price` | yes | Quote asset per one unit of base asset. Decimal, greater than 0. |
| `quantity` | yes | Base asset quantity filled. Decimal, greater than 0. |
| `quote_amount` | no | Quote amount of the fill **as reported** by the source, excluding fees. Kept as reported; compared with `price × quantity` (see §6). |
| `fee_amount` | no | Fee for this fill. **Positive = fee paid, negative = rebate received.** |
| `fee_currency` | when `fee_amount` is set | Asset the fee is charged in. Never assumed to be the quote asset. |

The template is a format defined by this project. It is **not** an exchange's official export format.

## 4. Values

### Decimals

Accepted grammar after trimming surrounding spaces: `^[+-]?[0-9]+(\.[0-9]+)?$`, at most 80 characters.

Rejected (`INVALID_NUMBER`, never partially parsed): exponents (`1e-8`), thousands separators (`1,000`), decimal commas (`0,5`), a leading or trailing dot (`.5`, `5.`), spaces inside the number, `NaN`, `Infinity`, currency symbols.

Values are processed as strings and with arbitrary-precision decimal arithmetic. JavaScript `Number` is never used for prices, quantities, amounts or fees.

The normalized form removes a leading `+` and redundant leading zeros of the integer part; trailing zeros of the fraction are kept (they carry the source's precision). `-0` becomes `0`.

### Identifiers and assets

- `trade_id` and `order_id` are text, at most 128 characters (`INVALID_ID`). An empty cell becomes `null`.
- Asset codes (`base_asset`, `quote_asset`, `fee_currency`) must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`. They are kept as written (no case change). Base and quote must differ (`SAME_BASE_AND_QUOTE`, compared case-insensitively).

### Side

`side` must be stated explicitly. TradeCSV never infers buy or sell from the sign of the quantity; a negative quantity is an error (`INVALID_QUANTITY`).

## 5. Time

`executedAt` is always UTC in ISO 8601 with a `Z` suffix. Fractional seconds are kept exactly as given (up to 9 digits).

| Input form | How to enable | Rule |
|---|---|---|
| ISO 8601 with offset (`Z` or `±HH:MM`) | Default | Converted to UTC. |
| Date-time without an offset | Mapping: `"time": { "format": "naive", "utcOffset": "+08:00" }` | Interpreted at the given **fixed** offset. |
| Unix seconds | Mapping: `"time": { "format": "epoch_seconds" }` | Integer seconds since 1970-01-01T00:00:00Z. |
| Unix milliseconds | Mapping: `"time": { "format": "epoch_milliseconds" }` | Integer milliseconds. |

Rules:
- A time without an offset is **rejected** (`TIME_ZONE_MISSING`) unless the mapping declares a fixed offset. The computer's time zone is never used.
- Only fixed offsets are supported. Named zones with daylight-saving changes (for example `Europe/London`) are not supported in v0.1 because local times around a change can be ambiguous or nonexistent. If your export uses local time in such a zone, convert it first or wait for a later version.
- Calendar values are checked (month 1–12, valid day including leap years, hour 0–23, minute and second 0–59). Leap seconds (`:60`) are rejected.
- Epoch values must be plain digits and fall between 2000-01-01 and 2100-01-01 (`TIME_OUT_OF_RANGE`). This catches seconds given as milliseconds and the reverse.
- A format that does not match the declared one is rejected (`INVALID_TIME`); nothing is guessed.

## 6. Amounts

- `price × quantity` is computed exactly. It is not stored as a field, so it is never confused with a reported amount.
- If `quote_amount` is present, it is kept as reported. When it differs from `price × quantity` by more than one unit in its last decimal place, the record gets a warning (`QUOTE_AMOUNT_MISMATCH`) listing both values. Nothing is overwritten.
- Fees are never added to or subtracted from amounts.

## 7. Fees

- `feeAmount` and `feeCurrency` are separate. The fee currency is never assumed.
- An empty fee cell means **unknown**: `feeAmount` is `null`, not `0` (warning `FEE_MISSING`).
- Normalized convention: **positive = fee paid, negative = rebate**.
- The template already uses this convention. A mapping must state the source's convention in `fee.sign`:
  - `cost_positive`: the source uses the same convention; values are copied.
  - `cost_negative`: the source shows fees as negative numbers (and rebates as positive); values are negated.
  - `unknown`: the convention is not known; `feeAmount` is `null`, the raw value stays in `sourceValues`, and the record gets `FEE_SIGN_UNKNOWN`. TradeCSV never takes an absolute value.
- A fee amount without a fee currency gives `feeAmount: null`, `feeCurrency: null` and `FEE_CURRENCY_MISSING`; the raw value stays in `sourceValues`.

## 8. Duplicates and conflicts

Duplicate checks run only inside one file, for one `format` and one `account` (the CLI `--account` label, default `default`).

| Case | Result |
|---|---|
| Same `trade_id`, same content | Later records get warning `DUPLICATE_TRADE_ID` and `duplicateOf` = record number of the first one. All are kept. |
| Same `trade_id`, different content | Every record with that id gets error `CONFLICTING_TRADE_ID` and is rejected. No record is picked as the correct one. |
| No `trade_id`; same time, assets, side, price and quantity | Later records get warning `SUSPECTED_DUPLICATE` and `suspectedDuplicateOf`. All are kept. Separate fills with identical values do happen. |

"Same content" compares the normalized time, assets, side, order id, and decimal values numerically (`1.0` equals `1.00`). Nothing is deleted automatically in v0.1.

## 9. Diagnostics and counts

Each diagnostic has `severity` (`error` or `warning`), `code`, `record` (record number or `null` for file-level issues), `field` (canonical field or `null`), `message` and `hint`.

- An **error** rejects the record (record-level) or the whole file (file-level).
- A **warning** never rejects anything.

Counts:

- `totalRecords = acceptedRecords + rejectedRecords + nonFillRecords` (blank records excluded). `nonFillRecords` is 0 for the template and mappings.
- `acceptedRecords` includes records with warnings; `recordsWithWarnings` counts them.
- `duplicateCandidates` counts flagged records: `identical` and `suspected` count the later copies (the first occurrence is not flagged); `conflicting` counts every record of a conflicting group. These overlap with the totals and are never added to them.
- Duplicate checks compare only records that passed all other checks.
- When the file has no fee column at all, one file-level warning `FEE_MISSING` (record `null`) is reported instead of one per record.
- When the structure cannot be parsed reliably, `totalRecords`, `acceptedRecords` and `rejectedRecords` are `null`.

Report `status`:

| Status | Meaning |
|---|---|
| `ok` | No errors, no warnings. |
| `ok_with_warnings` | No errors; at least one warning. |
| `failed` | At least one error (record-level or file-level). |

### Exports when there are errors

By default nothing but the report is produced when any error exists, so an incomplete result cannot be mistaken for a complete one.

With partial export explicitly enabled (`--allow-partial`, or `allowPartial: true` in the library), record-level errors still allow an export of the accepted records. The export is marked `"completeness": "partial"` and states how many records were excluded and why. File-level errors never produce an export.

## 10. Outputs

### Normalized JSON (lossless, authoritative)

```json
{
  "schemaVersion": "tradecsv.normalized/0.2",
  "tool": { "name": "tradecsv", "version": "0.1.0" },
  "input": { "sha256": "…", "bytes": 1234 },
  "format": "spot-fills-template/0.1",
  "account": "default",
  "completeness": "complete",
  "excluded": { "records": 0, "byCode": {} },
  "records": [
    {
      "format": "spot-fills-template/0.1",
      "account": "default",
      "sourceRecord": 1,
      "marketType": "spot",
      "instrument": null,
      "tradeId": "000123",
      "orderId": "9001",
      "executedAt": "2026-03-01T09:30:00Z",
      "baseAsset": "BTC",
      "quoteAsset": "USDT",
      "side": "buy",
      "positionSide": null,
      "positionEffect": null,
      "price": "64000.10",
      "quantity": "0.00150000",
      "quantityUnit": "base",
      "quoteAmount": "96.000150",
      "feeAmount": "0.096",
      "feeCurrency": "USDT",
      "realizedPnl": null,
      "realizedPnlCurrency": null,
      "duplicateOf": null,
      "suspectedDuplicateOf": null,
      "sourceValues": { "executed_at": "2026-03-01T09:30:00Z", "price": "64000.10" }
    }
  ]
}
```

All decimals and identifiers are strings. `sourceValues` holds the original text of the mapped input fields only (never the unmapped columns). The output contains no run time stamp, so the same input and options always give the same file.

### Spreadsheet CSV (for viewing)

Same records, one per row, for opening in a spreadsheet:

- UTF-8 with BOM, CRLF line endings, every field quoted.
- **Formula protection** (OWASP CSV Injection guidance): a text cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`. Cells that are plain decimal numbers are left unchanged. The protection is applied only to this file; JSON values are never altered.
- Limits: spreadsheet programs may still convert long identifiers to numbers (losing digits or leading zeros) or reinterpret dates when they open a CSV. No escaping scheme is safe in every program. Use the JSON file as the source of truth, or import the CSV with all columns as text.

### Report JSON

```json
{
  "schemaVersion": "tradecsv.report/0.2",
  "tool": { "name": "tradecsv", "version": "0.1.0" },
  "input": { "sha256": "…", "bytes": 1234 },
  "format": "spot-fills-template/0.1",
  "account": "default",
  "status": "failed",
  "export": "none",
  "summary": {
    "totalRecords": 4, "acceptedRecords": 3, "rejectedRecords": 1,
    "recordsWithWarnings": 1, "blankRecordsIgnored": 0, "nonFillRecords": 0,
    "duplicateCandidates": { "identical": 0, "conflicting": 0, "suspected": 0 }
  },
  "unmappedColumns": [],
  "diagnostics": [
    { "severity": "error", "code": "INVALID_NUMBER", "record": 3, "field": "price",
      "message": "price is not a plain decimal number: \"1,250.5\"",
      "hint": "Use digits with an optional dot, no thousands separators or exponents, e.g. 1250.5" }
  ]
}
```

`export` is `complete`, `partial` or `none`.

## 11. Mapping files

A mapping describes a CSV whose columns differ from the template. It contains data only. Nothing in it is executed or evaluated.

```json
{
  "schemaVersion": "tradecsv.mapping/0.1",
  "formatId": "my-broker-spot-fills",
  "columns": {
    "trade_id": "Trade ID",
    "order_id": "Order ID",
    "executed_at": "Time",
    "base_asset": "Coin",
    "price": "Price",
    "quantity": "Amount",
    "side": "Side",
    "fee_amount": "Fee",
    "fee_currency": "Fee Coin"
  },
  "fixed": { "quote_asset": "USDT" },
  "time": { "format": "naive", "utcOffset": "+08:00" },
  "side": { "buy": ["BUY"], "sell": ["SELL"] },
  "fee": { "sign": "cost_positive" }
}
```

| Key | Rules |
|---|---|
| `schemaVersion` | Must be `tradecsv.mapping/0.1`. |
| `formatId` | Required. `^[a-z0-9][a-z0-9._/-]{0,63}$`. Becomes the `format` of every record. |
| `columns` | Canonical field → source header name. Fields: those of §3. |
| `fixed` | Constant value for `base_asset`, `quote_asset` or `fee_currency` only. A field cannot be both mapped and fixed. |
| `time.format` | `iso` (default), `naive`, `epoch_seconds`, `epoch_milliseconds`. |
| `time.utcOffset` | `±HH:MM`. Required for `naive`, not allowed otherwise. |
| `side` | Exact (case-sensitive, after trimming) source values meaning buy and sell. Default: `buy`/`sell` in any case. |
| `fee.sign` | `cost_positive`, `cost_negative` or `unknown`. Required when `fee_amount` is mapped. |

Unknown keys, unknown fields and invalid values make the mapping invalid (`INVALID_MAPPING`); the file is not processed.

## 12. Privacy

All processing is local. TradeCSV does not use the network, telemetry or any AI model. It reads the input file and writes only the output files you ask for. The input file is never modified, and existing output files are not overwritten unless you pass `--force`.

## 13. Diagnostic codes

| Code | Level | Scope |
|---|---|---|
| `EMPTY_FILE` | error | file |
| `FILE_TOO_LARGE` | error | file |
| `UNSUPPORTED_ENCODING` | error | file |
| `INVALID_UTF8` | error | file |
| `MALFORMED_CSV` | error | file |
| `DUPLICATE_HEADER` | error | file |
| `MISSING_REQUIRED_COLUMN` | error | file |
| `UNKNOWN_FORMAT` | error | file |
| `INVALID_MAPPING` | error | file |
| `NO_RECORDS` | error | file |
| `ROW_FIELD_COUNT` | error | record |
| `MISSING_VALUE` | error | record |
| `INVALID_NUMBER` | error | record |
| `INVALID_PRICE` | error | record |
| `INVALID_QUANTITY` | error | record |
| `INVALID_SIDE` | error | record |
| `INVALID_ASSET` | error | record |
| `INVALID_ID` | error | record |
| `SAME_BASE_AND_QUOTE` | error | record |
| `INVALID_TIME` | error | record |
| `TIME_ZONE_MISSING` | error | record |
| `TIME_OUT_OF_RANGE` | error | record |
| `CONFLICTING_TRADE_ID` | error | record |
| `QUOTE_AMOUNT_MISMATCH` | warning | record |
| `FEE_MISSING` | warning | record |
| `FEE_CURRENCY_MISSING` | warning | record |
| `FEE_SIGN_UNKNOWN` | warning | record |
| `DUPLICATE_TRADE_ID` | warning | record |
| `SUSPECTED_DUPLICATE` | warning | record |
| `UNSUPPORTED_INSTRUMENT` | error | record (OKX) |
| `UNSUPPORTED_ROW_TYPE` | error | record (OKX) |
| `INVALID_UNIT` | error | record (OKX) |
| `NON_FILL_RECORD` | warning | record (OKX) |
| `BALANCE_MISMATCH` | warning | record (OKX) |

## 14. OKX unified bill (Chinese interface), format `okx-unified-bill-zh/v1`

The OKX "统一交易账单" (unified bill history) export, downloaded from the Simplified Chinese interface. Evidence and its limits: `docs/formats.md`, entry 2026-10-22. Only what that evidence showed is accepted.

### Recognition

`--format auto` (the default) uses this format when the first line starts with `用户ID:` and the second line is exactly this header (a byte-order mark at the start of a field is ignored):

```text
id,关联订单id,时间,账单类型,交易品种,交易类型,数量,交易单位,成交价,收益,手续费,手续费单位,仓位余额变动,仓位余额,交易账户余额变动,交易账户余额,交易账户余额单位
```

A file whose first line starts with `用户ID:` but whose header differs (another language, another OKX export) is rejected with `UNKNOWN_FORMAT`. Records are numbered from the line after the header (record *N* is on line *N + 2*). Mixed line endings (CRLF on the first line, LF afterwards, as in the real export) are handled.

### Rows

| 账单类型 / 交易类型 | Result |
|---|---|
| 永续合约 / 开多 | fill: `side` buy, `positionSide` long, `positionEffect` open |
| 永续合约 / 平多 | fill: sell, long, close |
| 永续合约 / 开空 | fill: sell, short, open |
| 永续合约 / 平空 | fill: buy, short, close |
| 永续合约 / 资金费收入, 永续合约 / 自动追加保证金, 划转 / 转入 | not a fill: counted in `nonFillRecords`, warning `NON_FILL_RECORD`, excluded from the export |
| anything else | error `UNSUPPORTED_ROW_TYPE` (for example funding paid, liquidations): not verified yet, so not guessed |

### Fields of a fill

| Field | From | Rule |
|---|---|---|
| `marketType` | — | `perpetual` |
| `instrument` | 交易品种 | Must match `BASE-USDT-SWAP`; anything else is `UNSUPPORTED_INSTRUMENT` (coin-margined `USD-SWAP` and delivery futures are not verified). |
| `baseAsset`, `quoteAsset` | 交易品种 | `BASE` and `USDT` from the instrument id. |
| `tradeId` | id | The bill id (one per fill). Used for duplicate and conflict checks. |
| `orderId` | 关联订单id | Shared by the fills of one order. |
| `executedAt` | 时间 + first line | `时间` has no offset; the first line states the export's time zone (`时区:UTC+8`). It is applied as a fixed offset. A missing time zone is a file-level `TIME_ZONE_MISSING`. |
| `price` | 成交价 | Plain decimal, greater than 0. |
| `quantity`, `quantityUnit` | 数量, 交易单位 | Number of contracts, kept as reported; `quantityUnit` is `contracts`. 交易单位 must be 张 (`INVALID_UNIT`). Contracts are **not** converted to coins: the contract size is not in the file. |
| `feeAmount`, `feeCurrency` | 手续费, 手续费单位 | In this export a fee is a signed change of the account balance (negative = paid), so it is negated: −0.06 becomes 0.06 (paid), +0.06 would become −0.06 (rebate). |
| `realizedPnl`, `realizedPnlCurrency` | 收益, 交易账户余额单位 | As reported by OKX (0 on opening fills). TradeCSV does not compute P&L. |
| `quoteAmount` | — | `null` (not in this export). |
| `sourceValues` | — | The row's columns except the running balances 仓位余额 and 交易账户余额, which are not needed. The first line (user id, account type) is never copied. |

### Consistency check

In the evidence, every fill satisfied 交易账户余额变动 = −仓位余额变动 + 收益 + 手续费 to within one unit of the 8th decimal place. A row that differs by more gets warning `BALANCE_MISMATCH`, which means the columns may not mean what this reader assumes for that row.
