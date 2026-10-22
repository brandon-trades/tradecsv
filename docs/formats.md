# Supported formats and evidence (v0.1)

A format is listed as supported only when there is evidence for its exact columns and meaning: an official document or sample of the CSV export, or a de-identified real export that we are allowed to use. Exchange API documentation alone does not prove what a CSV export looks like.

## Supported

| Format id | What it is | Evidence | Status |
|---|---|---|---|
| `spot-fills-template/0.1` | Spot Fills Template v0.1, defined by this project (`docs/format.md` §3) | This repository's specification | Supported |
| `okx-unified-bill-zh/v1` | OKX 统一交易账单 (unified bill history), Simplified Chinese interface: USDT-margined perpetual swap fills | One real export, 2026-10-22 (below) | Supported for what the evidence showed |
| Custom (`--mapping`) | Any spot-fill CSV described by a mapping file (`docs/format.md` §11) | Provided by the user who writes the mapping | Supported mechanism; the correctness of each mapping is the mapping author's responsibility |

The template is **not** the official export format of any exchange or broker.

## Not yet supported (needs evidence)

| Platform | Export | Status | What is missing |
|---|---|---|---|
| OKX | Unified bill: spot rows, coin-margined swaps, delivery futures, other row types, English interface | Not verified | Not present in the export used as evidence. |
| OKX | Spot trade history (fills) CSV | Not verified, not implemented | No official description of the CSV columns was found. See the evidence log below. |
| Kraken | Trades history CSV | Partly documented, not implemented | Field meanings are documented officially; the exact header row, how to split `pair` into base and quote, and the fee sign are not. See the evidence log. |
| Binance | Spot trade history CSV | Not implemented | Third-party sources say the trade-history export was removed around February 2022; no official column list found. |
| Others | — | Not started | — |

A built-in adapter will be added only together with a dated evidence entry: source, product, export type, header row, and the meaning of the time, side, quantity and fee columns.

## Evidence log

### 2026-10-22 — OKX 统一交易账单 (Chinese interface), perpetual swap fills

- **Source:** one real export downloaded by the maintainer from their own OKX sub-account, Simplified Chinese interface. File name pattern `欧易统一交易账单_<from>~<to>~UTC+8~<hash>.csv`, inside a zip. The file is **not** in this repository; the example `examples/okx/okx-unified-bill-sample.csv` is synthetic and copies only the structure.
- **Structure observed:** UTF-8 with a byte-order mark at the start of the file and at the start of every line and metadata field; first line `用户ID:…,账户类型:…,时区:UTC+8`; second line the 17-column header listed in `docs/format.md` §14; newest rows first; the first line ends with CRLF and all other lines with LF.
- **Contents:** 195 rows: 192 fills (永续合约 with 开多 84, 平多 65, 开空 26, 平空 17), 1 funding received (资金费收入), 1 automatic margin addition (自动追加保证金), 1 transfer in (划转 / 转入). All instruments `*-USDT-SWAP`; 交易单位 always 张; 手续费单位 and 交易账户余额单位 always USDT.
- **Checked by arithmetic:**
  - Every row has a distinct `id`; 21 of the 30 orders behind the fills have several fills (up to 20), so one row is one fill, not one order.
  - All 192 fees are negative, and 交易账户余额变动 = −仓位余额变动 + 收益 + 手续费 holds for all 192 fills to within 1e-8. So the fee is a signed balance change (negative = paid), and 收益 is the realized P&L, settled in the 交易账户余额单位.
  - 收益 is 0 on all 110 opening fills.
- **Result of running TradeCSV v0.2 on the real file:** 195 records, 192 accepted, 0 rejected, 3 non-fill, 0 `BALANCE_MISMATCH`; no user id in any output. Two problems found by this run and fixed before release: mixed line endings (the parser guessed CRLF from the first line), and the balance check, which first required exact equality although the columns are rounded separately.
- **Not covered by this evidence:** the English interface; spot, margin, coin-margined (`USD-SWAP`) and delivery-futures rows; funding paid; liquidations and auto-deleveraging; maker rebates (positive fees); other time zones in the first line. These are rejected or treated as described in `docs/format.md` §14 until there is evidence.

### 2026-10-21 — OKX spot trade-history CSV

- **Goal:** confirm the header row and column meaning of OKX's spot trade history (fills) CSV export.
- **Searched:** OKX help center and third-party import guides.
- **Found:** only third-party guides (tax and portfolio tools) describing where the download is in the OKX web interface (Assets → Order center / Report center → Trading account history → Download). They say the download is a zip file and that the export contains trading-related balance changes, including fills and fees. None of them lists the CSV columns, and they disagree on the maximum date range.
- **Not confirmed:** header names, whether each row is a fill or a balance change, time zone of the time column, sign convention of quantities and fees, how base and quote assets are given.
- **Conclusion:** not enough evidence. No OKX adapter in v0.1. Users with an OKX export can describe it with a mapping file, after checking the columns themselves.
- **Sources consulted:**
  - https://traderssecondbrain.com/guides/how-to-export-okx-trade-history
  - https://help.tokentax.co/en/articles/6197641-getting-your-okex-data
  - https://guides.koinx.com/integration/okx
  - https://support.cryptact.com/hc/en-us/articles/360057381151-How-to-download-files-from-OKX-formerly-OKEx

### 2026-10-21 — Kraken trades history CSV

- **Source (official):** Kraken Support, "Trades History FAQ", last updated 2026-10-06: https://support.kraken.com/articles/360001184886-how-to-interpret-trades-history-fields
- **Confirmed by that page:**
  - Each row has `txid`, a transaction id per partial execution (a fill); `ordertxid` is shared by the fills of one order.
  - `time` is UTC, in the form `YYYY-MM-DD HH:MM:SS.0000`; this maps to TradeCSV's `naive` time with offset `+00:00`.
  - `type` is `buy` or `sell`.
  - `price` and `cost` are in the quote currency; `cost = price × vol`, excluding fees.
  - `vol` is the base-currency amount.
  - `margin` is `0` for non-margin trades.
- **Not confirmed:**
  1. The exact header text and order. The page lists field names (it writes both `ordertype` and `order-type`), not a header row.
  2. The format of `pair` and how to split it into base and quote assets. The page says only "Base currency + Quote currency"; no example is given.
  3. The sign convention of `fee`.
  4. Which currency the fee was actually charged in. The page says `fee` is shown in the quote currency even when the fee was deducted in the base currency, and that the actual deduction is only in the Ledger history. So `fee` is not reliably "fee amount + fee currency" in TradeCSV's sense.
- **Also relevant:** margin trades appear in the same export (`margin` > 0) and are out of scope for spot.
- **Conclusion:** strong evidence for the meaning of each row, but not enough to build an adapter. Items 1 and 2 need an official sample file or a de-identified real export. Item 4 means a Kraken adapter should treat the fee as a quote-currency estimate, or take fees from the ledger export instead.

### 2026-10-21 — Binance spot trade history CSV

- **Searched:** Binance help center and other sources for an official column list.
- **Found:** no official document. A third-party tool (https://hackage.haskell.org/package/binance-exports) states that Binance removed the Trade History page and its export around February 2022, and that only the Order History export remains.
- **Conclusion:** not enough evidence. Orders are not fills (`docs/format.md` §1), so an Order History export would need separate evidence of how fills are represented in it.
