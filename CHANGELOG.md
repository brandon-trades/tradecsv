# Changelog

## 0.1.0 — 2026-10-21

First release.

- Core library: CSV reading (UTF-8, RFC 4180), validation, normalization, duplicate and conflict detection, diagnostic report, exports (lossless JSON, spreadsheet CSV with formula protection, report JSON).
- Spot Fills Template v0.1 and data-only mapping files (column names, fixed assets, time format and fixed offset, side values, fee sign convention).
- CLI: `check`, `convert`, `template`.
- Synthetic examples with expected outputs, 53 tests, CI on Node 22 and 24.
- No exchange-specific formats yet; see `docs/formats.md`.
