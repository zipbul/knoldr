// Single source of truth for the claim_feedback evidence strength
// heuristic, shared by the claim_feedback tool's insert + update paths.
//
// All fields are reporter-supplied (direct). Empty input lands at 0.1
// base; fully-substantiated input lands near 1.0. Re-weight manually
// once a labelled corpus exists.

interface StrengthInputs {
  counterSourceUrl?: string | null;
  counterNliScore?: number | null;
  failureDimension?: string | null;
  contextDomain?: string | null;
  contextScope?: Record<string, unknown> | null;
  partialTruth?: number | null;
}

/** Score in [0,1]. */
export function computeFeedbackEvidenceStrength(row: StrengthInputs): number {
  let s = 0.1;

  if (row.counterSourceUrl) {
    s += 0.3;
  }
  if (row.counterNliScore !== undefined && row.counterNliScore !== null && row.counterNliScore >= 0.7) {
    s += 0.2;
  }
  if (row.failureDimension) {
    s += 0.2;
  }
  if (row.contextDomain || row.contextScope) {
    s += 0.1;
  }
  if (row.partialTruth !== undefined && row.partialTruth !== null) {
    s += 0.1;
  }

  if (s > 1) {
    s = 1;
  }
  return Number(s.toFixed(3));
}
