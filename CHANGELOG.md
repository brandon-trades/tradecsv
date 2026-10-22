# Changelog

## 0.2.0 — 2026-10-22

- New input format `okx-unified-bill-zh/v1`: OKX 统一交易账单 (Chinese interface), USDT-margined perpetual swap fills. Verified against one real export (`docs/formats.md`); recognized automatically from the header, or forced with `--format`.
- Records gained `instrument`, `positionSide`, `positionEffect`, `quantityUnit` (`contracts` is kept as is), `realizedPnl` and `realizedPnlCurrency`; `marketType` can be `perpetual`. Schemas are now `tradecsv.normalized/0.2` and `tradecsv.report/0.2`.
- Non-trade rows (funding, margin changes, transfers) are counted in `nonFillRecords` and excluded; unverified row types and instruments are rejected.
- CSV reading now handles files that mix CRLF and LF line endings (found with the real OKX export).
- 74 tests.

## 0.1.0 — 2026-10-21

First release.

- Core library: CSV reading (UTF-8, RFC 4180), validation, normalization, duplicate and conflict detection, diagnostic report, exports (lossless JSON, spreadsheet CSV with formula protection, report JSON).
- Spot Fills Template v0.1 and data-only mapping files (column names, fixed assets, time format and fixed offset, side values, fee sign convention).
- CLI: `check`, `convert`, `template`.
- Synthetic examples with expected outputs, 53 tests, CI on Node 22 and 24.
- No exchange-specific formats yet; see `docs/formats.md`.
