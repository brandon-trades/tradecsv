# Contributing

Thanks for helping. TradeCSV is small on purpose: it checks and normalizes spot fills, and nothing more.

## Before you open a pull request

```bash
npm ci
npm run check
```

- Keep the core (`src/core`, `src/formats`) free of file system, network and DOM access.
- Never use JavaScript `Number`, `parseFloat` or automatic type conversion for prices, quantities, amounts, fees or ids.
- Any change to behaviour must update `docs/format.md` first, then the code and tests.
- Tests for data rules should state hand-checked expected values, not values copied from the output of the code under test.

## Adding an exchange format

A built-in adapter needs evidence: an official description or sample of the CSV export, or a de-identified real export you are allowed to share. Add a dated entry to `docs/formats.md` (source, product, export type, header row, meaning of time, side, quantity and fee columns). Do not commit real trade data without permission. API documentation alone is not evidence of a CSV format.

## Reporting a wrong result

Open an issue with the smallest synthetic CSV that reproduces it, the command you ran, and the report. Please do not post real account data.
