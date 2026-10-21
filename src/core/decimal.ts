// Decimal handling. Values stay strings; arithmetic uses big.js (arbitrary precision).
// JavaScript Number is never used for prices, quantities, amounts or fees.
import Big from "big.js";

const DECIMAL_RE = /^[+-]?[0-9]+(\.[0-9]+)?$/;
const MAX_LEN = 80;

/** True when `s` (already trimmed) is a plain decimal accepted by TradeCSV. */
export function isPlainDecimal(s: string): boolean {
  return s.length > 0 && s.length <= MAX_LEN && DECIMAL_RE.test(s);
}

/**
 * Normalize a plain decimal string without changing its value or precision:
 * drop a leading "+", drop redundant leading zeros of the integer part, keep fraction digits as given,
 * turn negative zero into zero. Caller must check isPlainDecimal first.
 */
export function normalizeDecimal(s: string): string {
  let sign = "";
  let body = s;
  if (body.startsWith("+")) body = body.slice(1);
  else if (body.startsWith("-")) {
    sign = "-";
    body = body.slice(1);
  }
  const dot = body.indexOf(".");
  let int = dot === -1 ? body : body.slice(0, dot);
  const frac = dot === -1 ? "" : body.slice(dot);
  int = int.replace(/^0+(?=\d)/, "");
  const out = int + frac;
  if (sign && /^[0.]+$/.test(out)) return out; // -0, -0.00 → 0, 0.00
  return sign + out;
}

/** Compare two plain decimal strings by value: -1, 0, 1. */
export function compareDecimal(a: string, b: string): number {
  return new Big(a).cmp(new Big(b));
}

export function isPositive(s: string): boolean {
  return new Big(s).gt(0);
}

export function negateDecimal(s: string): string {
  if (/^-/.test(s)) return s.slice(1);
  if (/^[0.]+$/.test(s)) return s;
  return "-" + s;
}

/** Number of digits after the decimal point. */
export function fractionDigits(s: string): number {
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** Exact product as a plain decimal string. */
export function multiply(a: string, b: string): string {
  return new Big(a).times(new Big(b)).toFixed();
}

/**
 * True when `reported` is consistent with `exact` at the reported precision:
 * |exact - reported| <= one unit in the last decimal place of `reported`.
 */
export function withinLastPlace(exact: string, reported: string): boolean {
  const unit = new Big(`1e-${fractionDigits(reported)}`); // exact; no division (big.js division is limited to Big.DP places)
  return new Big(exact).minus(new Big(reported)).abs().lte(unit);
}

/** Canonical key for numeric equality (1.0 and 1.00 give the same key). */
export function decimalKey(s: string): string {
  return new Big(s).toFixed();
}
