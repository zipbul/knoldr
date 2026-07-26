# knoldr — Handoff

_Last updated: 2026-07-24 · branch `fix/restructure-audit` → merged to `main`_

## What knoldr is (one paragraph)

A **verified-fact warehouse for AI agents**, exposed as an MCP Streamable-HTTP
server. Agents are the ONLY data inlet: they web-search themselves and `ingest`
findings **with cited source URLs**; knoldr splits the text into atomic claims,
**verifies each claim against its own cited live sources** (citation checking —
NLI entailment, not web search), builds a knowledge graph, and serves instant
`find` results carrying verdicts + provenance + contradictions. Consumer
feedback is a secondary signal (authority adjustment + re-verification);
`drift` re-checks verified claims every 14 days against their sources.

```
agent A: web-search → ingest(content + cited URLs)
knoldr:  extract claims → fetch cited URLs → NLI verdict → KG → instant find
agent B: find → verified factBundles (+ feedback if it proved wrong)
```

## Surface

- **MCP tools (7)**: `find`, `ingest`, `feedback`, `claim_feedback`,
  `neighbors`, `provenance`, `contradictions` — registered at `POST /mcp`
  (no auth; identity = optional self-declared `agentId` input, attribution only).
- **CLI**: `store · query · explore · feedback · audit · serve`.
- Unauthenticated `/health`, `/metrics` (Prometheus).
- Consumers register `http://<host>:5100/mcp` in their own MCP config; knoldr
  ships as one `docker compose up -d` (db = pgvector+pgroonga PG17,
  auto-migrated at boot; app = Bun + in-process ONNX models).

## Verification semantics (STRICT GROUNDING — the core contract)

`Verified ⇔ ≥1 cited-live-source NLI grounding pass AND no KG functional
conflict`. Cited-but-inconclusive retries 3× → `exhausted-pipeline` Unverified.
**Sourceless factual claims finalize single-pass as `no-cited-sources`
Unverified — nothing can ever verify an uncited claim.** Cross-claim
embedding neighbors NEVER touch verdicts (no Disputed contagion); they only
feed **NLI-classified** SUPPORTS/CONTRADICTS edges (local-only NLI, weight =
classification probability, SUPPORTS written neighbor→claim, factBundle
surfaces SUPPORTS incoming-only). NLI thresholds are a fixed 0.7 — retune
manually from golden-set F1, never from the pipeline's own verdicts.

## Model stack (all local, zero subscription APIs)

| Job | Backend |
|---|---|
| Verdict judging (entailment) | NLI DeBERTa-FEVER + mDeBERTa — **ONNX, in-process** |
| Chunk rerank / DocQA / embeddings | bge-reranker / distilbert-squad / MiniLM — ONNX, in-process |
| Text→structure (claim extract, KG triples, CoVe, decompose, classify, QA-gen) + bespoke-minicheck | **Ollama** (`OLLAMA_HOST`, default model `gemma4:e4b`) |
| Cited-source fetching | plain `fetch` to the open web (the one external dependency) |

**OPEN DECISION**: the owner intends to move OFF Ollama for the
text→structure jobs. The NLI/ONNX verdict path is unaffected by that swap.
All Ollama calls funnel through `src/llm/cli.ts` (`callLlm`) + 
`src/llm/bespoke-check.ts` — replacing the backend is contained there.

## What was removed this cycle (deliberate owner decisions — do NOT re-add)

1. **All external search services** (LangSearch, SearXNG, GitHub/arXiv
   retrieval, find's inline auto-research). find is instant, stored-data only.
   Plan + 7-round triple review: `docs/no-search-restructure-plan.md`.
2. **All security features** (bearer auth/token registry, origin check, body
   cap, SSRF guard, prompt-injection sanitizer). Trusted single-tenant agent
   ecosystem; no attacker boundary. Identity is self-declared.
3. **The unproven self-improvement layer**: FQA enrichment, auto-calibration
   (circular), reporter authority-learning, smoke-eval, weekly LoRA finetune
   sidecar + knoldr-judge auto-swap. Schema cleanup in migration
   `0003_drop_self_improvement`.
4. **The Claude Code plugin** (`.claude-plugin/`, `hooks/`, `monitors/`) —
   consumers just register the URL.

## Fixed this cycle (all TDD, tests name the defect)

- sanitize regex `u`-flag bug that redacted ALL source text (nothing could
  ever verify) — found because the Verified path had zero tests; it now has
  real ones (`tests/integration/defects.test.ts` D5 runs a live HTTP source).
- tags filter SQL (`ANY(tuple)` → `text[]`), model-loader poisoning
  (`src/llm/load-once.ts`), Dockerfile missing `COPY drizzle/`.
- D1/D2 pagination (explore raw-key keyset + sortBy-order presentation; query
  depth-aware pool + deterministic tiebreak + no phantom cursor), D3 graph CTE
  visited guards, D4 claim_feedback rate limit (1/agent/claim/hr, 10/claim/hr),
  D5 KG-prefix grounding contamination (premise = source text alone;
  `kg/expand.ts` deleted), D6 worker livelock stamps, SIGTERM drain.

## Current state

- Gates: tsc, `oxlint --type-aware` 0/0, oxfmt, knip, dpdm — clean.
- Tests: 131 unit + 84 integration/e2e vs real Postgres — green.
- src: 72 files / ~9.8k LOC. Migrations `0000`–`0003` (journal in
  `drizzle/meta/_journal.json`; migrate runs at container boot).
- CI note: workflow triggers on `main` push + PRs only — feature-branch pushes
  alone do not run it.

## Remaining work (honest list)

1. **Real-model F1 has never run.** `bun run eval:load && bun run eval:golden`
   against a full stack (Postgres + Ollama + ONNX). The 22-row
   `eval/golden-set.json` is a seed — curate before trusting numbers or
   enabling `EVAL_FAIL_ON_REGRESSION=1`.
2. **LLM backend swap** (Ollama → owner's choice) — contained in
   `src/llm/cli.ts` / `bespoke-check.ts`. Also fix the suspicious default
   model tag `gemma4:e4b` when touching this.
3. **Post-surgery full re-review was skipped** — the final 72-file commit
   (`09f1167`) was not triple-reviewed (Codex/Grok/Fable), unlike every
   earlier change in this cycle.
4. Naming leftover: `src/collect/` contains only hygiene workers (retry,
   batch-dedup, classify, reclassify) — the "collect" name is a research-era
   relic; rename when convenient.

## Env vars actually read (many are undocumented elsewhere)

`KNOLDR_HOST` `KNOLDR_PORT` `KNOLDR_LOG_LEVEL` `DATABASE_URL` ·
`OLLAMA_HOST` `KNOLDR_OLLAMA_FAST_MODEL` `KNOLDR_OLLAMA_TIMEOUT_MS` ·
`KNOLDR_INFERENCE_DEVICE` `KNOLDR_ONNX_THREADS` (+OMP/OPENBLAS/MKL/ORT caps) ·
`KNOLDR_NLI_MODEL(_MULTI)` `KNOLDR_QA_MODEL` `KNOLDR_BESPOKE_MODEL` ·
`KNOLDR_EMBEDDING_BASE_URL` `KNOLDR_EMBEDDING_API_KEY` (HTTP embedding
fallback; local MiniLM otherwise) · `KNOLDR_EXTRACT_NLI_GATE=off`
`KNOLDR_EXTRACT_NLI_THRESHOLD` · `KNOLDR_KG_MIN_CERTAINTY` (KG admits
unverified ≥0.5 at half weight) · `KNOLDR_FETCH_USER_AGENT` ·
`EVAL_FAIL_ON_REGRESSION`.

## Key files

- `src/claim/verify.ts` — the verification pipeline (read this first).
- `src/mcp/tools.ts` — tool surface + contracts (descriptions ARE the API docs).
- `docs/no-search-restructure-plan.md` — the reviewed restructure decision log.
- `tests/integration/{defects,restructure}.test.ts` — the behavioral contracts.
