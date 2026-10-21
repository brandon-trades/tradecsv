// Spot Fills Template v0.1: the input format defined by this project (docs/format.md §3).
// It is not an exchange's official export format.
import { CANONICAL_FIELDS, MAPPING_SCHEMA, type MappingConfig } from "../core/types.js";

export const TEMPLATE_FORMAT_ID = "spot-fills-template/0.1";

/** Column names of the template, in the recommended order. */
export const TEMPLATE_COLUMNS = [...CANONICAL_FIELDS];

/** The template expressed as a mapping: every field maps to the column of the same name. */
export const TEMPLATE_MAPPING: MappingConfig = {
  schemaVersion: MAPPING_SCHEMA,
  formatId: TEMPLATE_FORMAT_ID,
  columns: Object.fromEntries(CANONICAL_FIELDS.map((f) => [f, f])),
  time: { format: "iso" },
  fee: { sign: "cost_positive" },
};
