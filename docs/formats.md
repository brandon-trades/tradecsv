# Supported formats and evidence (v0.1)

A format is listed as supported only when there is evidence for its exact columns and meaning: an official document or sample of the CSV export, or a de-identified real export that we are allowed to use. Exchange API documentation alone does not prove what a CSV export looks like.

## Supported

| Format id | What it is | Evidence | Status |
|---|---|---|---|
| `spot-fills-template/0.1` | Spot Fills Template v0.1, defined by this project (`docs/format.md` §3) | This repository's specification | Supported |
| Custom (`--mapping`) | Any spot-fill CSV described by a mapping file (`docs/format.md` §11) | Provided by the user who writes the mapping | Supported mechanism; the correctness of each mapping is the mapping author's responsibility |

The template is **not** the official export format of any exchange or broker.

## Not yet supported (needs evidence)

| Platform | Export | Status | What is missing |
|---|---|---|---|
| OKX | Spot trade history (fills) CSV | Not verified, not implemented | No official description of the CSV columns was found. See the evidence log below. |
| Kraken | Trades history CSV | Partly documented, not implemented | Field meanings are documented officially; the exact header row, how to split `pair` into base and quote, and the fee sign are not. See the evidence log. |
| Binance | Spot trade history CSV | Not implemented | Third-party sources say the trade-history export was removed around February 2022; no official column list found. |
| Others | — | Not started | — |

A built-in adapter will be added only together with a dated evidence entry: source, product, export type, header row, and the meaning of the time, side, quantity and fee columns.

## Evidence log

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
