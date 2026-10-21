# Related projects

Checked on 2026-10-21. TradeCSV is not the first tool that reads trade CSV files; this note records how it differs, so that it can be used alongside these projects rather than instead of them.

| Project | What it does | Relation to TradeCSV |
|---|---|---|
| [rotki](https://docs.rotki.com/usage-guides/import-csv) | Open-source, local portfolio tracker. Imports many exchange CSVs and has a generic CSV format. | A full application with its own database. TradeCSV is a small library and CLI that only checks and normalizes spot fills and reports problems per record, and can be embedded in other tools. |
| [DaLI (dali-rp2)](https://github.com/eprbell/dali-rp2) | Data loader for the RP2 crypto tax calculator; reads CSVs and APIs through plugins and produces RP2 input. | Tax-oriented (US). TradeCSV does no tax or P&L work; it stops at a validated, lossless record of fills. |
| [Papa Parse](https://www.papaparse.com/docs) | General CSV parser for JavaScript. | Used by TradeCSV for RFC 4180 parsing. TradeCSV adds the trade-specific rules: decimal handling without floating point, explicit time zones, fee sign conventions, duplicate and conflict detection, and counted diagnostics. |

What TradeCSV contributes: a documented data contract for spot fills (`docs/format.md`) and a validator that refuses to guess (time zones, fee currencies, fee signs, sides) and says exactly which record and field is wrong.
