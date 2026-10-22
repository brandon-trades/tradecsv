// Public types for TradeCSV. See docs/format.md for the meaning of every field.

export const NORMALIZED_SCHEMA = "tradecsv.normalized/0.2";
export const REPORT_SCHEMA = "tradecsv.report/0.2";
export const MAPPING_SCHEMA = "tradecsv.mapping/0.1";

/** Canonical input fields (template column names). */
export const CANONICAL_FIELDS = [
  "trade_id",
  "order_id",
  "executed_at",
  "base_asset",
  "quote_asset",
  "side",
  "price",
  "quantity",
  "quote_amount",
  "fee_amount",
  "fee_currency",
] as const;
export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

export const REQUIRED_FIELDS: readonly CanonicalField[] = ["executed_at", "base_asset", "quote_asset", "side", "price", "quantity"];

export type Severity = "error" | "warning";

export type DiagnosticCode =
  | "EMPTY_FILE"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_ENCODING"
  | "INVALID_UTF8"
  | "MALFORMED_CSV"
  | "DUPLICATE_HEADER"
  | "MISSING_REQUIRED_COLUMN"
  | "UNKNOWN_FORMAT"
  | "INVALID_MAPPING"
  | "NO_RECORDS"
  | "ROW_FIELD_COUNT"
  | "MISSING_VALUE"
  | "INVALID_NUMBER"
  | "INVALID_PRICE"
  | "INVALID_QUANTITY"
  | "INVALID_SIDE"
  | "INVALID_ASSET"
  | "INVALID_ID"
  | "SAME_BASE_AND_QUOTE"
  | "INVALID_TIME"
  | "TIME_ZONE_MISSING"
  | "TIME_OUT_OF_RANGE"
  | "CONFLICTING_TRADE_ID"
  | "QUOTE_AMOUNT_MISMATCH"
  | "FEE_MISSING"
  | "FEE_CURRENCY_MISSING"
  | "FEE_SIGN_UNKNOWN"
  | "DUPLICATE_TRADE_ID"
  | "SUSPECTED_DUPLICATE"
  | "UNSUPPORTED_INSTRUMENT"
  | "UNSUPPORTED_ROW_TYPE"
  | "INVALID_UNIT"
  | "NON_FILL_RECORD"
  | "BALANCE_MISMATCH";

export interface Diagnostic {
  severity: Severity;
  code: DiagnosticCode;
  /** 1-based record number after the header (blank rows counted), or null for file-level issues. */
  record: number | null;
  /** Canonical field (template formats) or source column name (exchange formats), or null. */
  field: string | null;
  message: string;
  hint: string;
}

export interface NormalizedFill {
  format: string;
  account: string;
  sourceRecord: number;
  marketType: "spot" | "perpetual";
  /** Exchange instrument id for derivatives (e.g. "BTC-USDT-SWAP"); null for spot. */
  instrument: string | null;
  tradeId: string | null;
  orderId: string | null;
  /** UTC, ISO 8601 with Z. */
  executedAt: string;
  baseAsset: string;
  quoteAsset: string;
  side: "buy" | "sell";
  /** Derivatives only: which position the fill belongs to, and whether it opens or closes it. null for spot. */
  positionSide: "long" | "short" | null;
  positionEffect: "open" | "close" | null;
  /** Decimal strings. */
  price: string;
  quantity: string;
  /** "base" = base asset amount (spot); "contracts" = number of contracts as reported (not converted). */
  quantityUnit: "base" | "contracts";
  quoteAmount: string | null;
  /** Positive = fee paid, negative = rebate. null = unknown. */
  feeAmount: string | null;
  feeCurrency: string | null;
  /** Realized P&L of this fill as reported by the exchange (never computed by TradeCSV). null when not reported. */
  realizedPnl: string | null;
  realizedPnlCurrency: string | null;
  duplicateOf: number | null;
  suspectedDuplicateOf: number | null;
  /** Original text of the input fields used for this record (keys: canonical fields or source column names). */
  sourceValues: Record<string, string>;
}

export interface Summary {
  totalRecords: number | null;
  acceptedRecords: number | null;
  rejectedRecords: number | null;
  recordsWithWarnings: number;
  blankRecordsIgnored: number;
  /** Rows that are valid but are not trades (e.g. funding, transfers); excluded from the export. */
  nonFillRecords: number;
  duplicateCandidates: { identical: number; conflicting: number; suspected: number };
}

export type ReportStatus = "ok" | "ok_with_warnings" | "failed";
export type ExportKind = "complete" | "partial" | "none";

export interface InputInfo {
  sha256: string;
  bytes: number;
}

export interface Report {
  schemaVersion: typeof REPORT_SCHEMA;
  tool: { name: "tradecsv"; version: string };
  input: InputInfo;
  format: string | null;
  account: string;
  status: ReportStatus;
  export: ExportKind;
  summary: Summary;
  unmappedColumns: string[];
  diagnostics: Diagnostic[];
}

export interface TimeConfig {
  format: "iso" | "naive" | "epoch_seconds" | "epoch_milliseconds";
  /** "+HH:MM" / "-HH:MM"; only for format "naive". */
  utcOffset?: string;
}

export interface MappingConfig {
  schemaVersion: typeof MAPPING_SCHEMA;
  formatId: string;
  columns: Partial<Record<CanonicalField, string>>;
  fixed?: Partial<Record<"base_asset" | "quote_asset" | "fee_currency", string>>;
  time?: TimeConfig;
  side?: { buy: string[]; sell: string[] };
  fee?: { sign: "cost_positive" | "cost_negative" | "unknown" };
}

export type FormatChoice = "auto" | "spot-fills-template/0.1" | "okx-unified-bill-zh/v1";

export interface ProcessOptions {
  /** Input format. "auto" (default) recognizes the verified exchange formats by their exact header and otherwise uses the template. */
  format?: FormatChoice;
  /** Column mapping (spot only); omit to use the Spot Fills Template v0.1. Takes precedence over format detection. */
  mapping?: MappingConfig;
  /** Account label used to scope duplicate detection. Default "default". */
  account?: string;
  /** Maximum input size in bytes. Default 50 MiB. */
  maxBytes?: number;
  /** Allow exporting accepted records when some records were rejected. Default false. */
  allowPartial?: boolean;
}

export interface ProcessResult {
  report: Report;
  /** Accepted records, in input order. Empty when the export is "none". */
  records: NormalizedFill[];
  /** What may be exported: "complete", "partial" (explicitly allowed) or "none". */
  export: ExportKind;
}
