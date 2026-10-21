// Validation of mapping files (docs/format.md §11). A mapping is data only: nothing in it is executed.
import { CANONICAL_FIELDS, MAPPING_SCHEMA, REQUIRED_FIELDS, type CanonicalField, type MappingConfig } from "./types.js";
import { parseOffset } from "./time.js";

const FIXABLE = ["base_asset", "quote_asset", "fee_currency"] as const;
const TOP_KEYS = ["schemaVersion", "formatId", "columns", "fixed", "time", "side", "fee"];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export type MappingCheck = { ok: true; mapping: MappingConfig } | { ok: false; problems: string[] };

/** Validate an untrusted value (e.g. parsed JSON) as a mapping. Returns every problem found. */
export function validateMapping(value: unknown): MappingCheck {
  const p: string[] = [];
  if (!isObj(value)) return { ok: false, problems: ["The mapping must be a JSON object."] };
  for (const k of Object.keys(value)) if (!TOP_KEYS.includes(k)) p.push(`Unknown key "${k}".`);
  if (value.schemaVersion !== MAPPING_SCHEMA) p.push(`schemaVersion must be "${MAPPING_SCHEMA}".`);
  if (typeof value.formatId !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,63}$/.test(value.formatId)) p.push('formatId must match ^[a-z0-9][a-z0-9._/-]{0,63}$ (e.g. "my-broker-spot-fills").');

  const columns = value.columns;
  if (!isObj(columns)) p.push("columns must be an object mapping field names to source column names.");
  else for (const [k, v] of Object.entries(columns)) {
    if (!(CANONICAL_FIELDS as readonly string[]).includes(k)) p.push(`columns: unknown field "${k}".`);
    if (typeof v !== "string" || v.trim() === "") p.push(`columns.${k} must be a non-empty column name.`);
  }
  const fixed = value.fixed;
  if (fixed !== undefined) {
    if (!isObj(fixed)) p.push("fixed must be an object.");
    else for (const [k, v] of Object.entries(fixed)) {
      if (!(FIXABLE as readonly string[]).includes(k)) p.push(`fixed: only ${FIXABLE.join(", ")} can be fixed (got "${k}").`);
      if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(v)) p.push(`fixed.${k} must be an asset code like "USDT".`);
      if (isObj(columns) && k in columns) p.push(`"${k}" is both mapped and fixed; choose one.`);
    }
  }
  const provided = new Set([...(isObj(columns) ? Object.keys(columns) : []), ...(isObj(fixed) ? Object.keys(fixed) : [])]);
  for (const f of REQUIRED_FIELDS) if (!provided.has(f)) p.push(`Required field "${f}" is neither mapped nor fixed.`);

  const time = value.time;
  if (time !== undefined) {
    if (!isObj(time)) p.push("time must be an object.");
    else {
      for (const k of Object.keys(time)) if (!["format", "utcOffset"].includes(k)) p.push(`time: unknown key "${k}".`);
      if (!["iso", "naive", "epoch_seconds", "epoch_milliseconds"].includes(time.format as string)) p.push('time.format must be "iso", "naive", "epoch_seconds" or "epoch_milliseconds".');
      if (time.format === "naive") {
        if (typeof time.utcOffset !== "string" || parseOffset(time.utcOffset) === null) p.push('time.utcOffset is required for naive times, e.g. "+08:00".');
      } else if (time.utcOffset !== undefined) p.push("time.utcOffset is only allowed with format \"naive\".");
    }
  }
  const side = value.side;
  if (side !== undefined) {
    if (!isObj(side)) p.push("side must be an object with buy and sell lists.");
    else {
      for (const k of Object.keys(side)) if (!["buy", "sell"].includes(k)) p.push(`side: unknown key "${k}".`);
      const list = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.trim() !== "");
      if (!list(side.buy) || !list(side.sell)) p.push("side.buy and side.sell must be non-empty lists of strings.");
      else if ((side.buy as string[]).some((b) => (side.sell as string[]).includes(b))) p.push("A value cannot mean both buy and sell.");
    }
  }
  const fee = value.fee;
  if (fee !== undefined) {
    if (!isObj(fee)) p.push("fee must be an object.");
    else {
      for (const k of Object.keys(fee)) if (k !== "sign") p.push(`fee: unknown key "${k}".`);
      if (!["cost_positive", "cost_negative", "unknown"].includes(fee.sign as string)) p.push('fee.sign must be "cost_positive", "cost_negative" or "unknown".');
    }
  }
  if (isObj(columns) && "fee_amount" in columns && !(isObj(fee) && typeof fee.sign === "string")) {
    p.push('fee.sign is required when fee_amount is mapped: "cost_positive" (fees positive), "cost_negative" (fees negative) or "unknown".');
  }
  if (p.length) return { ok: false, problems: p };
  return { ok: true, mapping: value as unknown as MappingConfig };
}

/** Source column name for a canonical field, if mapped. */
export const columnOf = (m: MappingConfig, f: CanonicalField): string | undefined => m.columns[f];
