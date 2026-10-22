// Helpers shared by the format readers.
import { isPlainDecimal, normalizeDecimal } from "./decimal.js";
import type { Diagnostic, DiagnosticCode, NormalizedFill } from "./types.js";

export const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export const ID_MAX = 128;
export const q = (s: string) => JSON.stringify(s.length > 60 ? s.slice(0, 60) + "…" : s);

export class Collector {
  list: Diagnostic[] = [];
  add(severity: Diagnostic["severity"], code: DiagnosticCode, record: number | null, field: string | null, message: string, hint: string) {
    this.list.push({ severity, code, record, field, message, hint });
  }
  get hasError() { return this.list.some((d) => d.severity === "error"); }
}

export interface Candidate { fill: NormalizedFill; warnings: Diagnostic[] }

/** What a format reader returns for the data rows. */
export interface ReadRecords {
  candidates: Candidate[];
  /** Record-level errors (rejected records) and non-fill notes. */
  diagnostics: Diagnostic[];
  rejected: Set<number>;
  blank: number;
  nonFill: number;
}

/** Validate a plain decimal; adds INVALID_NUMBER and returns null when invalid or empty. */
export function readDecimal(d: Collector, rec: number, field: string, raw: string, hint = "Use digits with an optional dot: no thousands separators, decimal commas or exponents (e.g. 1250.5, 0.00000012)."): string | null {
  const v = raw.trim();
  if (v === "") return null;
  if (!isPlainDecimal(v)) { d.add("error", "INVALID_NUMBER", rec, field, `${field} is not a plain decimal number: ${q(v)}`, hint); return null; }
  return normalizeDecimal(v);
}
