# Golden-set evaluation

Objective, **labelled** measurement of the claim-verification pipeline — the one thing
that was missing (the evaluator in `src/eval/` was complete, but `golden_set_claim`
had no way to be populated, so every run was a no-op). This is the measurement loop
that the self-tuning machinery (calibration, drift, finetune) needs in order to be
judged: without it, those loops only validate the pipeline against itself.

## The loop

```bash
# 1. Edit the labelled corpus (the source of truth)
$EDITOR eval/golden-set.json

# 2. Load it into golden_set_claim (idempotent upsert; rows absent from the
#    file are deactivated, never deleted, so old runs stay interpretable)
bun run eval:load            # → eval/golden-set.json
#   bun run eval:load path/to/other.json

# 3. Run the REAL verify pipeline against the labels
bun run eval:golden
```

`eval:golden` (`src/eval/cli.ts`) creates a temp draft entry+claim per labelled row,
runs the real `verifyClaim` (db-cross-ref → KG → source-NLI → CoVe → web search →
escalation), compares the predicted verdict to the label, and persists one
`golden_set_run` row with **macro-averaged precision / recall / F1 per verdict class**
plus a per-claim-type breakdown and the full confusion list. It also computes
regression vs the most recent prior run.

## Where it runs

The evaluator drives the **real** verify pipeline, so it needs a real knoldr
environment — Postgres **and** the generative LLM (Ollama) **and** the ONNX models.
It is therefore **not** part of the mocked unit / db-tests CI (those stub the LLM, so
the verdicts would be meaningless). Run it:

- locally against your `docker compose` stack, or
- on a scheduled job / self-hosted runner that has the models, gated with the env
  below.

```bash
EVAL_FAIL_ON_REGRESSION=1 bun run eval:golden   # exit 1 if macro-F1 regressed
```

Exit codes: `0` ran (or empty corpus, no-op) without regression · `1` regressed
(only when `EVAL_FAIL_ON_REGRESSION=1`) · `2` the evaluator threw. Keep the gate
**off** until the corpus is large enough that macro-F1 is stable.

## Fixture schema (`eval/golden-set.json`)

Array of objects:

| field                           | required | notes                                                                                                                               |
| ------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `id`                            | ✓        | stable unique key (used to upsert)                                                                                                  |
| `statement`                     | ✓        | the claim text (≤2000 chars)                                                                                                        |
| `claimType`                     | ✓        | `factual` \| `subjective` \| `predictive` \| `normative`                                                                            |
| `expectedVerdict`               | ✓        | `verified` \| `disputed` \| `unverified` \| `not-applicable`                                                                        |
| `sourceUrls`                    | —        | injected as `entry_source` rows so the **source-grounded NLI** path fires (the dominant production path); omit and only KG/CoVe run |
| `domain`, `sourceHint`, `notes` | —        | metadata                                                                                                                            |
| `labeledBy`                     | ✓        | who/what labelled it                                                                                                                |
| `active`                        | —        | `false` to keep a row but exclude it from runs                                                                                      |

Only `factual` claims are verified; non-factual ship as `not-applicable` (mirroring
production), so label them accordingly.

## ⚠️ The shipped corpus is a seed, not a gold set

`eval/golden-set.json` is a small illustrative starter (`labeledBy: knoldr-seed`).
**Curate and expand it with real, expert-labelled claims** — ideally drawn from your
own domains and from past misclassifications — before trusting the F1 numbers or
turning on the regression gate.
