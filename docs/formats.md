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
