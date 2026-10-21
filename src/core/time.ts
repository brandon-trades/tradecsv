// Time parsing. Every accepted value becomes UTC ISO 8601 with "Z".
// The host computer's time zone is never consulted; times without an offset need an explicit fixed offset.
import type { TimeConfig } from "./types.js";

export type TimeResult = { ok: true; utc: string } | { ok: false; code: "INVALID_TIME" | "TIME_ZONE_MISSING" | "TIME_OUT_OF_RANGE"; message: string; hint: string };

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/;
const OFFSET_RE = /^([+-])(\d{2}):(\d{2})$/;
const EPOCH_MIN_S = 946684800n; // 2000-01-01T00:00:00Z
const EPOCH_MAX_S = 4102444800n; // 2100-01-01T00:00:00Z

/** Parse "+08:00" / "-05:30" into minutes east of UTC, or null if invalid. */
export function parseOffset(s: string): number | null {
  const m = OFFSET_RE.exec(s);
  if (!m) return null;
  const h = Number(m[2]), min = Number(m[3]);
  if (h > 14 || min > 59 || (h === 14 && min > 0)) return null;
  return (m[1] === "-" ? -1 : 1) * (h * 60 + min);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const daysInMonth = (y: number, m: number) => [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;

function formatUtc(ms: number, fraction: string | null): string {
  const d = new Date(ms);
  const base = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${base}${fraction ? "." + fraction : ""}Z`;
}

const bad = (code: "INVALID_TIME" | "TIME_ZONE_MISSING" | "TIME_OUT_OF_RANGE", message: string, hint: string): TimeResult => ({ ok: false, code, message, hint });

export function parseTime(raw: string, config: TimeConfig): TimeResult {
  const s = raw.trim();
  if (config.format === "epoch_seconds" || config.format === "epoch_milliseconds") {
    if (!/^\d{1,16}$/.test(s)) return bad("INVALID_TIME", `executed_at is not a whole number of ${config.format === "epoch_seconds" ? "seconds" : "milliseconds"}: "${raw}"`, "Epoch times must be plain digits, e.g. 1772357400 (seconds) or 1772357400000 (milliseconds).");
    const v = BigInt(s);
    const secs = config.format === "epoch_seconds" ? v : v / 1000n;
    if (secs < EPOCH_MIN_S || secs >= EPOCH_MAX_S) {
      return bad("TIME_OUT_OF_RANGE", `executed_at ${raw} is outside 2000-01-01..2100-01-01 when read as ${config.format === "epoch_seconds" ? "seconds" : "milliseconds"}`, "Check whether the column holds seconds or milliseconds and set time.format accordingly.");
    }
    if (config.format === "epoch_seconds") return { ok: true, utc: formatUtc(Number(v) * 1000, null) };
    return { ok: true, utc: formatUtc(Number(v / 1000n) * 1000, pad(Number(v % 1000n), 3)) };
  }

  const m = ISO_RE.exec(s);
  if (!m) {
    return bad("INVALID_TIME", `executed_at is not a supported date-time: "${raw}"`, config.format === "naive"
      ? "Expected YYYY-MM-DD HH:MM:SS (optionally with .fraction) and no offset, as declared in the mapping."
      : "Expected ISO 8601 with an offset, e.g. 2026-03-01T09:30:00Z or 2026-03-01 17:30:00+08:00.");
  }
  const [, Y, Mo, D, h, mi, se, frac, off] = m;
  const y = Number(Y), mo = Number(Mo), d = Number(D), hh = Number(h), mm = Number(mi), ss = Number(se);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || hh > 23 || mm > 59 || ss > 59) {
    return bad("INVALID_TIME", `executed_at is not a valid calendar date-time: "${raw}"`, "Check month, day, hour, minute and second (leap seconds are not accepted).");
  }
  let offsetMin: number;
  if (config.format === "naive") {
    if (off) return bad("INVALID_TIME", `executed_at has an offset but the mapping declares naive times: "${raw}"`, "Use time.format \"iso\" for values that carry their own offset.");
    const o = config.utcOffset ? parseOffset(config.utcOffset) : null;
    if (o === null) return bad("TIME_ZONE_MISSING", "No valid utcOffset is configured for naive times", "Set time.utcOffset, e.g. \"+08:00\", in the mapping.");
    offsetMin = o;
  } else {
    if (!off) return bad("TIME_ZONE_MISSING", `executed_at has no time zone: "${raw}"`, "Add Z or an offset like +08:00, or declare a fixed offset in a mapping (time.format \"naive\"). TradeCSV never assumes the computer's time zone.");
    if (off === "Z") offsetMin = 0;
    else {
      const o = parseOffset(off);
      if (o === null) return bad("INVALID_TIME", `executed_at has an invalid UTC offset: "${raw}"`, "Offsets must be between -14:00 and +14:00, e.g. +08:00.");
      offsetMin = o;
    }
  }
  if (y < 1970 || y > 2100) return bad("TIME_OUT_OF_RANGE", `executed_at year ${y} is outside 1970..2100`, "Check the date column.");
  // Whole seconds shifted by a whole-minute offset; the fraction is unaffected and kept exactly.
  const ms = Date.UTC(y, mo - 1, d, hh, mm, ss) - offsetMin * 60_000;
  return { ok: true, utc: formatUtc(ms, frac ?? null) };
}
