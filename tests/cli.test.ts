// CLI behaviour: exit codes, files written, no silent overwrite, input untouched. Runs the built CLI (npm test builds first).
import { describe, expect, it, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "dist", "cli", "main.js");
const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8" });
let out: string;
beforeEach(() => { out = mkdtempSync(join(tmpdir(), "tradecsv-")); return () => rmSync(out, { recursive: true, force: true }); });

describe("cli", () => {
  it("prints help and version", () => {
    expect(run("--help").stdout).toContain("tradecsv check <input.csv>");
    expect(run("--version").stdout.trim()).toBe("0.2.0");
    expect(run("template").stdout.trim()).toBe("trade_id,order_id,executed_at,base_asset,quote_asset,side,price,quantity,quote_amount,fee_amount,fee_currency");
  });
  it("check: exit 0 for a valid file, 1 for errors, 2 for usage problems", () => {
    expect(run("check", "examples/valid-fills.csv").status).toBe(0);
    const bad = run("check", "examples/broken-fills.csv");
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("INVALID_NUMBER record 1 [price]");
    expect(run("check", "missing.csv").status).toBe(2);
    expect(run("frobnicate", "x").status).toBe(2);
    expect(run("check", "examples/valid-fills.csv", "--nope").status).toBe(2);
  });
  it("check --json prints the report", () => {
    const r = JSON.parse(run("check", "examples/broken-fills.csv", "--json").stdout);
    expect(r.schemaVersion).toBe("tradecsv.report/0.2");
    expect(r.summary.rejectedRecords).toBe(7);
  });
  it("convert writes report, JSON and CSV for a valid file", () => {
    const before = readFileSync(join(ROOT, "examples/valid-fills.csv"));
    const r = run("convert", "examples/valid-fills.csv", "--out", out);
    expect(r.status).toBe(0);
    for (const f of ["report.json", "normalized.json", "normalized.csv"]) expect(existsSync(join(out, f))).toBe(true);
    const doc = JSON.parse(readFileSync(join(out, "normalized.json"), "utf8"));
    expect(doc.completeness).toBe("complete");
    expect(doc.records).toHaveLength(6);
    expect(readFileSync(join(ROOT, "examples/valid-fills.csv")).equals(before)).toBe(true); // input untouched
  });
  it("convert with errors writes only the report, unless --allow-partial", () => {
    const r = run("convert", "examples/broken-fills.csv", "--out", out);
    expect(r.status).toBe(1);
    expect(existsSync(join(out, "report.json"))).toBe(true);
    expect(existsSync(join(out, "normalized.json"))).toBe(false);
    expect(r.stdout).toContain("--allow-partial");
    const p = run("convert", "examples/broken-fills.csv", "--out", out, "--allow-partial", "--force");
    expect(p.status).toBe(1); // errors still exist
    expect(JSON.parse(readFileSync(join(out, "normalized.json"), "utf8")).completeness).toBe("partial");
  });
  it("does not overwrite existing outputs without --force", () => {
    writeFileSync(join(out, "report.json"), "keep me");
    const r = run("convert", "examples/valid-fills.csv", "--out", out);
    expect(r.status).toBe(2);
    expect(readFileSync(join(out, "report.json"), "utf8")).toBe("keep me");
    expect(run("convert", "examples/valid-fills.csv", "--out", out, "--force").status).toBe(0);
  });
  it("uses a mapping file", () => {
    const r = run("convert", "examples/custom/broker-fills.csv", "--mapping", "examples/custom/broker-mapping.json", "--out", out);
    expect(r.status).toBe(0);
    const doc = JSON.parse(readFileSync(join(out, "normalized.json"), "utf8"));
    expect(doc.format).toBe("example-broker-spot-fills");
    expect(doc.records.map((x: { executedAt: string }) => x.executedAt)).toEqual(["2026-03-04T01:00:00Z", "2026-03-04T01:00:01Z", "2026-03-04T13:30:00Z"]);
  });
  it("converts the OKX unified bill sample", () => {
    const r = run("convert", "examples/okx/okx-unified-bill-sample.csv", "--out", out);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("2 not trades (excluded)");
    const doc = JSON.parse(readFileSync(join(out, "normalized.json"), "utf8"));
    expect(doc.format).toBe("okx-unified-bill-zh/v1");
    expect(doc.records).toHaveLength(5);
    expect(run("check", "examples/okx/okx-unified-bill-sample.csv", "--format", "nope").status).toBe(2);
  });
  it("rejects files over --max-size-mb before reading them", () => {
    const big = join(out, "big.csv");
    writeFileSync(big, "x".repeat(1024 * 1024 + 10));
    const r = run("check", big, "--max-size-mb", "1");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("FILE_TOO_LARGE");
  });
});
