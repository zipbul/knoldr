// Back-compat shim. The single source of truth lives in
// src/score/enums.ts now (PascalCase members + kebab-case values).
// These arrays are derived from the enum at module load so the
// existing zod-style `z.enum([...])` callers keep working.

import {
  ApplicationMethod,
  FailureDimension,
  Outcome,
  enumValues,
} from "./enums";

export const APPLICATION_METHODS = enumValues(ApplicationMethod) as readonly [
  ApplicationMethod,
  ...ApplicationMethod[],
];
export const OUTCOMES = enumValues(Outcome) as readonly [
  Outcome,
  ...Outcome[],
];
export const FAILURE_DIMENSIONS = enumValues(FailureDimension) as readonly [
  FailureDimension,
  ...FailureDimension[],
];

export type {
  ApplicationMethod,
  FailureDimension,
  Outcome,
};
