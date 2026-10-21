#!/usr/bin/env node
// Thin command-line wrapper around the core library: file I/O, arguments and exit codes only.
// Exit codes: 0 = no errors (warnings allowed), 1 = data errors found, 2 = usage or I/O problem.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { processCsv } from "../core/process.js";
import { toNormalizedJson, toReportJson, toSpreadsheetCsv } from "../core/export.js";
import { DEFAULT_MAX_BYTES } from "../core/csv.js";
import { TEMPLATE_COLUMNS } from "../formats/template.js";
import type { ProcessResult } from "../core/types.js";
import { VERSION } from "../version.js";

const HELP = `tradecsv ${VERSION} - check spot trade-fill CSV files locally and export normalized records

Usage:
  tradecsv check <input.csv> [options]            Validate and print the report summary (no files written)
  tradecsv convert <input.csv> --out <dir> [options]
                                                  Validate, write report.json and, if there are no errors,
                                                  normalized.json and normalized.csv
  tradecsv template                               Print the Spot Fills Template v0.1 header row

Options:
  --mapping <file.json>   Column mapping for files that do not use the template (docs/format.md §11)
  --account <label>       Account label used to scope duplicate detection (default: default)
  --out <dir>             Output directory for convert (created if missing)
  --allow-partial         convert: also export the accepted records when some records were rejected
                          (the export is marked "partial")
  --force                 convert: overwrite existing output files
  --max-size-mb <n>       Input size limit in MiB (default: 50)
  --json                  check: print the full report as JSON
  -h, --help              Show this help
  -v, --version           Show the version

Exit codes: 0 no errors (warnings allowed), 1 data errors found, 2 usage or file problem.
All processing is local; nothing is sent over the network.`;

class UsageError extends Error {}

function main(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true, strict: true,
      options: {
        mapping: { type: "string" }, account: { type: "string" }, out: { type: "string" },
        "allow-partial": { type: "boolean" }, force: { type: "boolean" }, "max-size-mb": { type: "string" },
        json: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
      },
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const { values: o, positionals } = parsed;
  if (o.version) { console.log(VERSION); return 0; }
  const [cmd, input, ...extra] = positionals;
  if (o.help || !cmd) { console.log(HELP); return o.help ? 0 : 2; }
  if (cmd === "template") { console.log(TEMPLATE_COLUMNS.join(",")); return 0; }
  if (cmd !== "check" && cmd !== "convert") throw new UsageError(`Unknown command "${cmd}". Run tradecsv --help.`);
  if (!input) throw new UsageError(`Missing input file. Usage: tradecsv ${cmd} <input.csv>`);
  if (extra.length) throw new UsageError(`Unexpected arguments: ${extra.join(" ")}`);

  let maxBytes = DEFAULT_MAX_BYTES;
  if (o["max-size-mb"] !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(o["max-size-mb"]) || Number(o["max-size-mb"]) <= 0) throw new UsageError("--max-size-mb must be a positive number");
    maxBytes = Math.floor(Number(o["max-size-mb"]) * 1024 * 1024);
  }
  const inputPath = resolve(input);
  if (!existsSync(inputPath) || !statSync(inputPath).isFile()) throw new UsageError(`Input file not found: ${input}`);
  const size = statSync(inputPath).size;
  if (size > maxBytes) {
    console.error(`FILE_TOO_LARGE: ${input} is ${size} bytes; the limit is ${maxBytes} bytes. Split the file or use --max-size-mb.`);
    return 1;
  }

  let mapping: unknown;
  if (o.mapping !== undefined) {
    const mp = resolve(o.mapping);
    if (!existsSync(mp)) throw new UsageError(`Mapping file not found: ${o.mapping}`);
    try { mapping = JSON.parse(readFileSync(mp, "utf8")); } catch (e) { throw new UsageError(`Mapping file is not valid JSON: ${(e as Error).message}`); }
  }

  let outFiles: { report: string; json: string; csv: string } | null = null;
  if (cmd === "convert") {
    if (!o.out) throw new UsageError("convert needs --out <dir>");
    const dir = resolve(o.out);
    outFiles = { report: join(dir, "report.json"), json: join(dir, "normalized.json"), csv: join(dir, "normalized.csv") };
    if (Object.values(outFiles).includes(inputPath)) throw new UsageError("The output would overwrite the input file.");
    const existing = Object.values(outFiles).filter((f) => existsSync(f));
    if (existing.length && !o.force) throw new UsageError(`Output file(s) already exist: ${existing.map((f) => basename(f)).join(", ")}. Use --force to overwrite, or choose another --out.`);
    mkdirSync(dir, { recursive: true });
  } else if (o.out || o.force || o["allow-partial"]) {
    throw new UsageError("--out, --force and --allow-partial are only used with convert");
  }

  const result = processCsv(new Uint8Array(readFileSync(inputPath)), {
    mapping: mapping as never, account: o.account, maxBytes, allowPartial: o["allow-partial"] === true,
  });

  if (cmd === "check") {
    if (o.json) process.stdout.write(toReportJson(result)); else printSummary(input, result);
    return result.report.status === "failed" ? 1 : 0;
  }
  const files = outFiles!;
  writeFileSync(files.report, toReportJson(result));
  const written = [files.report];
  if (result.export !== "none") {
    writeFileSync(files.json, toNormalizedJson(result));
    writeFileSync(files.csv, toSpreadsheetCsv(result.records));
    written.push(files.json, files.csv);
  }
  printSummary(input, result);
  console.log(`\nWritten: ${written.map((f) => basename(f)).join(", ")} in ${resolve(o.out!)}`);
  if (result.export === "none" && result.report.status === "failed") {
    console.log("No normalized output was written because the report has errors." + (result.report.diagnostics.some((d) => d.severity === "error" && d.record === null) ? "" : " Use --allow-partial to export only the accepted records (marked partial)."));
  }
  if (result.export === "partial") console.log(`Partial export: ${result.report.summary.rejectedRecords} record(s) were excluded; see report.json.`);
  return result.report.status === "failed" ? 1 : 0;
}

function printSummary(input: string, r: ProcessResult) {
  const s = r.report.summary;
  const n = (v: number | null) => (v === null ? "unknown" : String(v));
  console.log(`${input}: ${r.report.status.toUpperCase()} (format ${r.report.format ?? "unknown"}, account ${r.report.account})`);
  console.log(`  records: ${n(s.totalRecords)} total, ${n(s.acceptedRecords)} accepted, ${n(s.rejectedRecords)} rejected, ${s.recordsWithWarnings} with warnings, ${s.blankRecordsIgnored} blank ignored`);
  const dc = s.duplicateCandidates;
  if (dc.identical || dc.conflicting || dc.suspected) console.log(`  duplicates: ${dc.identical} identical, ${dc.conflicting} conflicting, ${dc.suspected} suspected`);
  if (r.report.unmappedColumns.length) console.log(`  ignored columns: ${r.report.unmappedColumns.join(", ")}`);
  const diags = r.report.diagnostics;
  const shown = diags.slice(0, 20);
  for (const d of shown) console.log(`  ${d.severity === "error" ? "ERROR  " : "warning"} ${d.code}${d.record !== null ? ` record ${d.record}` : ""}${d.field ? ` [${d.field}]` : ""}: ${d.message}`);
  if (diags.length > shown.length) console.log(`  … ${diags.length - shown.length} more (see the full report)`);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) { console.error(`tradecsv: ${e.message}`); process.exitCode = 2; }
  else { console.error(`tradecsv: unexpected error: ${(e as Error).message}`); process.exitCode = 2; }
}
