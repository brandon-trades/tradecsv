// Reading the file: size, encoding and RFC 4180 structure. Uses Papa Parse with header:false so that
// duplicate headers and rows with the wrong number of fields stay visible (no silent renaming or padding).
import Papa from "papaparse";

export interface ParsedTable {
  header: string[];
  /** Data rows after the header, in order; index i is record number i + 1. */
  rows: string[][];
}

export type ReadResult =
  | { ok: true; table: ParsedTable }
  | { ok: false; code: "EMPTY_FILE" | "FILE_TOO_LARGE" | "UNSUPPORTED_ENCODING" | "INVALID_UTF8" | "MALFORMED_CSV"; message: string; hint: string };

export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/** Decode bytes as UTF-8 (BOM removed). Strings are taken as already decoded (a leading BOM is removed). */
export function decodeInput(input: string | Uint8Array, maxBytes: number): { ok: true; text: string; bytes: number } | Extract<ReadResult, { ok: false }> {
  if (typeof input === "string") {
    const bytes = new TextEncoder().encode(input).length;
    if (bytes > maxBytes) return tooLarge(bytes, maxBytes);
    return { ok: true, text: input.replace(/^\uFEFF/, ""), bytes };
  }
  if (input.length > maxBytes) return tooLarge(input.length, maxBytes);
  if ((input[0] === 0xff && input[1] === 0xfe) || (input[0] === 0xfe && input[1] === 0xff)) {
    return { ok: false, code: "UNSUPPORTED_ENCODING", message: "The file is UTF-16 encoded", hint: "Save or export the file as UTF-8 CSV." };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    return { ok: true, text: text.replace(/^\uFEFF/, ""), bytes: input.length };
  } catch {
    return { ok: false, code: "INVALID_UTF8", message: "The file is not valid UTF-8", hint: "Save or export the file as UTF-8 CSV (other encodings such as GBK or Windows-1252 are not supported in v0.1)." };
  }
}

function tooLarge(bytes: number, max: number) {
  return { ok: false as const, code: "FILE_TOO_LARGE" as const, message: `The file is ${bytes} bytes; the limit is ${max} bytes`, hint: "Split the file, or raise the limit (CLI: --max-size-mb)." };
}

/**
 * Turn CRLF line breaks outside quoted fields into LF, leaving quoted content untouched.
 * Needed because real exports can mix line endings (the OKX bill export ends its first line with CRLF and the rest with LF),
 * and the parser otherwise guesses one line ending from the first line.
 */
export function normalizeLineEndings(text: string): string {
  let out = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') inQuotes = !inQuotes; // an escaped quote ("") toggles twice, so the state is unchanged
    if (!inQuotes && c === "\r" && text[i + 1] === "\n") continue;
    out += c;
  }
  return out;
}

export function parseCsv(input: string): ReadResult {
  if (input.trim() === "") return { ok: false, code: "EMPTY_FILE", message: "The file is empty", hint: "Export the fills again; the file must contain a header row and at least one record." };
  const text = normalizeLineEndings(input);
  const res = Papa.parse<string[]>(text, { header: false, delimiter: ",", newline: "\n", quoteChar: '"', escapeChar: '"', skipEmptyLines: false, dynamicTyping: false });
  const fatal = res.errors.find((e) => e.type === "Quotes" || e.type === "Delimiter");
  if (fatal) {
    return { ok: false, code: "MALFORMED_CSV", message: `The CSV structure cannot be read reliably (${fatal.code}${fatal.row != null ? ` near data row ${fatal.row + 1}` : ""})`, hint: "Check for unbalanced double quotes. Record counts are unknown, so nothing is exported." };
  }
  const data = res.data;
  // A trailing line break produces one final empty row; it is not a record.
  if (data.length && data[data.length - 1]!.length === 1 && data[data.length - 1]![0] === "" && /\n$/.test(text)) data.pop();
  const [header, ...rows] = data;
  if (!header) return { ok: false, code: "EMPTY_FILE", message: "The file has no header row", hint: "The first row must contain the column names." };
  return { ok: true, table: { header: header.map((h) => h.trim()), rows } };
}

export const isBlankRow = (row: string[]): boolean => row.every((f) => f.trim() === "");
