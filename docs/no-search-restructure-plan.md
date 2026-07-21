# Plan v8: knoldr restructure — pure verified warehouse, ZERO external search services

# r1: Codex(6)/Grok(10)/Fable(6) → v2. r2: Codex(1)/Grok(4)/Fable(4) → v3.

# r3: Fable EMPTY, Codex(3), Grok(5) → v4. r4: Codex(3)/Grok(5)/Fable(4) → v5.

# r5: Grok approve(EMPTY); Codex(2) + Fable(3) → v6 (SUPPORTS direction,

# per-target weights, KG-vs-crossref merge, weight/direction tests).

# r6: Codex EMPTY (after test-block fix), Grok(1) + Fable(4) → v7 (read-path

# fix, direction option, legacy-supports migration — premise verified sound in

# r7: the promotion branch is the ONLY supports writer). r7: Codex EMPTY,

# Grok EMPTY, Fable(1) → this v8: SUPPORTS is INCOMING-ONLY in factBundle

# bucketing (prevents the inverted duplicate on the neighbor's bundle).

## Decision (owner-made)

knoldr = **verified-fact warehouse only**. Consumers (agents) are the ONLY data
inlet (`ingest` with cited source URLs); knoldr never searches the web.

```
agents: web-search themselves → ingest(content + cited source URLs)
knoldr: receive → extract claims → verify (grounding) → KG → find (instant, always)
```

"External search SERVICES" ≠ "fetching cited sources":

- REMOVED: LangSearch acquisition, SearXNG web/counter search, GitHub/arXiv
  retrieval, find's auto-research.
- KEPT: SSRF-guarded live-fetch of the ingester's cited URLs (source-fetch) +
  NLI grounding — citation checking, the only check that does not trust the
  submitter.

## Verdict semantics — STRICT GROUNDING (ONE outcome per trigger; code change)

`Verified` ⇔ **at least one successful cited-live-source grounding**
(source_check NLI pass, possibly via CoVe sub-claims over the same cited URLs)
**AND no KG functional-predicate conflict** (the content-precise contradiction
check, which already short-circuits to Disputed with kgConflict.confidence
BEFORE source-check — it is the one and only internal-contradiction veto).

- **db_cross_ref = EDGE EMISSION ONLY.** Its Disputed-similarity signal
  (cos≥0.8 neighbors whose verdict is Disputed, verify.ts:643,661-663) means
  "a similar claim is contested", NOT "this claim is contradicted" — embeddings
  score even negations as similar, so using it as a veto would false-demote and
  set off a transitive Disputed contagion (each demotion becomes a
  "contradiction" for its own neighbors). Therefore: NO promotion (the early
  Verified return at verify.ts:151-165 is deleted), NO demotion, NO certainty
  boost (role dropped — no new magic constants). It only supplies CANDIDATE
  neighbors for NLI-classified SUPPORTS/CONTRADICTS edge emission (see
  Implementer contract item 2) — graph context, never verdicts.
- **ONE outcome per trigger**:
  | trigger | outcome |
  |---|---|
  | KG functional conflict | Disputed (certainty = kgConflict.confidence) — unchanged stage-2 short-circuit; the only INTERNAL contradiction veto |
  | cited-source grounding pass | Verified (aggregated certainty, calibration-gated — unchanged) |
  | **cited-source refutation** (aggregated contradiction past DISPUTED_THRESHOLD (aggregator.ts:35, applied :100); committed via runSourceCheck) | **Disputed** — retained behavior; this is EXTERNAL grounding evidence, not the internal veto |
  | **CoVe: any cited sub-claim disputed** | **Disputed** (existing CoVe rule, retained) |
  | cited but inconclusive/fetch-failed | `null` → existing bumpAttempt retry (3 attempts) → ExhaustedPipeline Unverified |
  | **no cited sources** | single-pass: KG conflict → Disputed; else **Unverified FINAL, evidence source = new enum member `no-cited-sources`** — a concrete VerifyResult, NEVER `null` (null means retry). No backoff: nothing can ever verify a sourceless claim; re-ingestion with sources creates new claims |
- New `EvidenceSource.NoCitedSources = 'no-cited-sources'` (enums.ts) so
  verdict_log + metrics distinguish it from ExhaustedPipeline ("all paths
  returned null" no longer describes this case). Check for any DB CHECK
  constraint on evidence_source at implementation (lockstep covers).
- Independence damping = URL/domain/title/simhash fingerprints ONLY (NOT agent
  identity). `agent_feedback_authority` is NOT an aggregation input.
- Documented meaning: `verified` = "cited sources actually support it and the
  KG holds no functional conflict" — NOT open-web truth, NOT
  survived-counter-search. Cross-claim NLI runs at EDGE level only (Implementer
  contract item 2): claim-vs-claim disputes surface as NLI-classified
  CONTRADICTS edges + the contradictions tool, never as verdict changes —
  verdict-level cross-claim demotion remains explicitly FUTURE WORK.

New verify stage list (precise):
`db_cross_ref (edges only) → KG contradiction (short-circuit Disputed) →
[if cited URLs] source_check (± DocQA/Bespoke escalation) → [if inconclusive]
CoVe (same cited URLs) → finalize (sourceless: no-cited-sources / cited:
retry→exhausted)` — no counter-search, no specialized retrieval, no SearXNG.

### Implementer contract (verify.ts — exact wiring, r2/r3)

1. Delete the early Verified return (:151-165) and the now-dead
   `CROSS_REF_MIN_CORROBORATIONS` constant (:75).
2. **Edge emission is NLI-CLASSIFIED, LOCAL-ONLY, DIRECTIONAL (r3 Codex +
   r4 all three)**:
   - `dbCrossRef` returns ≤20 CANDIDATES `{ id, statement }` — its SELECT adds
     `statement` (today it selects id/verdict/similarity only, :639) and KEEPS
     the `verdict IN (verified, disputed)` filter (candidates are decided
     claims only); verdict-based id labeling is dropped.
   - Direction (NLI is asymmetric): **premise = neighbor.statement,
     hypothesis = claim.statement** — "does the neighbor support this claim",
     matching source-grounding semantics and the corroboratingClaimIds meaning.
   - Classification uses a **local-only NLI path** (a `rawNliScore`/
     skip-translation option on nli.ts): the standard `nliScore` escalates
     hedging multilingual results to an Ollama TRANSLATION call
     (nli.ts:191-204) — for non-Latin claim pairs that would be up to 20 LLM
     calls per claim (~100 per batch of 6). Edge classification never calls
     Ollama. Honest cost bound: ≤20 candidates × 1-2 local ONNX forwards, only
     on claims that reach a non-null commit.
   - entailment ≥ support threshold → SUPPORTS candidate `{ id, score:
entailment }`; contradiction ≥ refute threshold → CONTRADICTS candidate
     `{ id, score: contradiction }`; otherwise NO edge. Thresholds =
     getCurrentThresholds() (calibration reuse; threshold fit for claim-pairs
     is a deferrable tuning concern — edges carry no verdict effect).
3. **withCrossRef rewrite — async, scored (r3 Grok + r4)**: `withCrossRef`
   becomes async (all call sites `return await withCrossRef(...)`; `null`
   short-circuits with NO NLI work). On every non-null VerifyResult it merges
   SCORED edge candidates — `contradicting` (cap 8) and `corroborating`
   (cap 5) as `{ id, score }` (KG-conflict ids merged as
   `{id, score: kgConflict.confidence}`, KG-wins dedupe — see item 4) —
   REMOVING the early-return when there are zero
   contradictions (exactly where SUPPORTS would die); never touches
   verdict/certainty. The sourceless result flows through the same helper:
   `return await withCrossRef({ verdict: Unverified, certainty: 0,
evidence: { source: EvidenceSource.NoCitedSources, rationale: 'no cited sources' } })`.
4. **Edge WEIGHT + DIRECTION + writer mechanics (r4 + r5 Codex/Fable)**:
   - The committer today writes `weight: result.certainty` (:835,:842) — claim
     verdict, not relationship strength; sourceless certainty 0 would mint
     weight-0 edges. Cross-ref edges use each candidate's NLI score.
   - **Direction**: with premise=neighbor / hypothesis=claim, entailment means
     the NEIGHBOR supports THIS claim → SUPPORTS edges are written
     **neighbor(source) → claim(target)** (the committer today writes
     claim→neighbor — reversed; fix it). CONTRADICTS keeps claim→neighbor
     (the contradictions tool already queries both directions, so direction
     is non-semantic there; pinned for determinism).
   - **SUPPORTS read-path consumer fix (r6 Grok — the write fix alone breaks
     the product surface)**: factBundles in src/claim/query.ts fetch all
     OUTGOING edges for the pivot claim but INCOMING only for `contradicts`
     (:243-260) — a neighbor→claim SUPPORTS edge would never surface in
     `factBundles[].supports`. Extend the incoming-edge fetch to include
     `supports` (and revise the "incoming is scoped to contradicts" comment).
     **SUPPORTS becomes INCOMING-ONLY in the bundle bucketing (r7 Fable)**: the
     outgoing fetch has no type filter and FactRelationLink carries no
     direction, so without this an edge would surface twice — correctly on the
     target and INVERTED on the neighbor's supports[] (entailment
     neighbor⊨claim presented as claim-supports-neighbor). Skip outgoing
     supports rows in the bucket switch. `neighbors` (entity/kg_relation) and
     the `contradictions` tool are unaffected. Tests: a SUPPORTS edge written
     neighbor→claim appears in the TARGET claim's factBundle supports[] AND
     does NOT appear in the SOURCE claim's supports[].
   - **writeClaimEdges signature change** (relation-writer.ts:22-33 accepts ONE
     weight per call today): extend to per-target weights AND direction —
     `writeClaimEdges(pivotId, others: Array<{id, weight}>, type,
{ direction: 'outgoing' | 'incoming', ...opts })`. `outgoing` builds rows
     (pivot→other) as today; **`incoming` builds (other→pivot)** — required
     because flipped SUPPORTS is many-sources→one-target, which the
     one-source→many-targets shape cannot express (r6 Fable). One call per
     relation type, caps/dedupe/self-loop logic reused. All callers updated.
   - **Merge shape + precedence**: cross-ref candidates arrive as
     `{id, score: NLI prob}`; KG-conflict ids enter the same merged collection
     as `{id, score: kgConflict.confidence}`. On collision (same neighbor from
     both) **KG wins** (content-precise beats similarity+NLI). Dedupe happens
     BEFORE the write, so `ON CONFLICT DO NOTHING` never arbitrates between
     the two provenances.
5. **Edge scope narrowed (r3, option A)**: edges attach to non-null returns
   only. The ExhaustedPipeline synthesis in processVerifyQueueInner (:777-781)
   commits WITHOUT cross-ref edges — `withCrossRef(null)` discards candidates
   by design; documented narrowing (future backfill possible), not a bug.
6. Sourceless branch: after the KG stage, `if (sourceUrls.length === 0)`
   return the concrete Unverified result (fields pinned in item 3) so
   processVerifyQueue commits + writes verdict_log + deletes the queue row in
   the normal non-null path (:784-817). Confirmed compatible: factuality
   recompute is verdict-count-based; calibration.collectSamples filters
   source-check evidence (shape intact, volume shrinks); smoke-eval anchors
   are source-check-only — none depend on db_cross_ref verdicts.

## Changes

### 1. find — pure instant DB search (contract-breaking, intentional)

- Delete the search→research→re-search flow (find.ts); single stored search.
- **REMOVE `researched` and `research` from the response shape entirely**
  (not always-false — remove for honesty). Update agent-card: top-level
  description (:9 "auto-collects…"), find skill text, `research` tag (:22),
  output schema text (:57-58), examples.
- Progress events `research_started`/`research_completed`/`search_rerun`
  removed — breaking for streaming consumers, documented.
- Thin-results contract text: "thin results = the warehouse doesn't know this
  yet — search the web yourself and ingest findings WITH source URLs; re-query
  later for verified facts."

### 2. verify.ts surgery

- Delete imports/stages: web-search (:32), specialized-retrieval (:30),
  counter-search (:18); the verified-path counter-search guard (~213-226); the
  external-retrieval stage (~242-267).
- Implement strict grounding per the Implementer contract above: dbCrossRef →
  edges only (no promotion/demotion/boost); sourceless single-pass finalize
  with `no-cited-sources`; KG short-circuit unchanged.
- CoVe stays (verified web-free: cove.ts imports only llm/cli + logger).

### 3. Deletions (import-graph closed, per review)

- Modules + their tests: collect/{research,query-decompose,search-scraper},
  claim/{web-search,counter-search,specialized-retrieval},
  tests/unit/{research-helpers,query-decompose}.test.ts.
- **text-split: goes with research** (the v1 claim "used by ingest" was FALSE —
  research.ts is its only consumer; delete + its test unless tsc/knip reveal
  another importer at implementation time).
- **scripts/probe-langsearch.ts — explicit** (knip-blind: scripts/\*.ts are knip
  entries).
- **searxng/ config dir + Dockerfile.searxng + compose searxng service + app
  env SEARXNG_URL** (compose ~:54).
- env/docs: .env.example LangSearch "Required" block + :10 comment
  (query-decompose/counter-search references), KNOLDR_HOST_ALLOWLIST/BLOCKLIST
  (research-only), **docker-compose.yml:30 `LANGSEARCH_API_KEY` app env**
  (r2 all three). KEEP KNOLDR_ALLOWED_INTERNAL_HOSTS (source-fetch SSRF).

### 4. feedback-router — Outdated semantics redefined

The documented "follow-up worker triggers fresh LangSearch re-research" can
never exist now. Outdated → metadata stamp + re-queue claims for verification
against their CITED sources only (existing reverifyEntryClaims). Update
comments (:27,81,90) and any docs.

### 5. Stale-comment/doc sweep (explicit list)

verify.ts:84-96 (strategy docstring still documents cross-ref promotion + the
removed jury), verify.ts:455 ("fall through to CoVe / web search"),
verify.ts:761 ("SearXNG"), ingest/engine.ts:94 (stale research.ts reference),
a2a/handlers/feedback.ts:42 (stale "re-research" routing comment),
server.ts:44-47 (idleTimeout 255 was justified by inline research — re-size to
cover the remaining long NON-streaming call, ingest with LLM decompose: keep
idleTimeout ≥ KNOLDR_OLLAMA_TIMEOUT_MS/1000 (default 120s), comment rewritten;
NOT 30s — that would sever long ingest requests), server.ts:221,235,
extract-queue.ts:13,
independence.ts:9, smoke-eval.ts:10-13 (describes counter-search confirmation),
eval/README.md:25 (stage list includes "web search"), FUTURE.md:7 (inlet
language), finetune header, text-split references.

### 6. Workers

All remaining workers stay (claim-extract, verify, kg-extract, reclassify,
retry, dedup, partition, calibration, drift, invariants, smoke-eval). Drift
re-verification re-fetches cited sources — still valuable. classify-batch +
reclassify-queue kept (classify stored entries, no web). batch-dedup,
retry-runner kept (no web).

## What this supersedes

The find-latency plan v7 in its entirety: research_log, admission SQL, owner
tokens, generation slots, watchdogs, rate caps, researchQueued — all dead. The
instant-find goal is achieved by deletion.

## Tests

- Update: a2a.test.ts:182,192 (asserted `researched` — field no longer exists).
- New: find cold-miss → instant, response has NO researched/research fields, no
  research side-effects/network; verify sourceless → single-pass finalize
  (Disputed if contradicted fixture, else Unverified), never touches deleted
  modules; verify with cited sources → source-fetch path runs (mock fetch);
  **edge tests (NLI-classified)**: an NLI-entailed neighbor → SUPPORTS edge;
  an NLI-contradicted neighbor → CONTRADICTS edge; a topically-similar but
  NLI-neutral neighbor → NO edge (the graph-contamination case); edges attach
  on non-null commits, and ExhaustedPipeline commits carry none (documented
  narrowing); **no-contagion test**: a Disputed embedding-neighbor does NOT
  change a source-grounded Verified verdict; **refutation test**: cited source
  that contradicts the claim → Disputed; sourceless finalize carries evidence
  source `no-cited-sources` + certainty 0 in claim + verdict_log; CoVe path
  with no search modules loaded; unfetchable/neutral cited sources →
  Unverified (via retry→exhausted); **weight/direction tests (r5/r6)**:
  SUPPORTS edge row asserts source=neighbor, target=claim; CONTRADICTS row
  asserts source=claim, target=neighbor; cross-ref SUPPORTS weight == the
  classifying entailment prob and CONTRADICTS weight == the contradiction prob
  (NOT result.certainty — an implementer leaving the old committer line must
  FAIL these); KG-conflict edge weight == kgConflict.confidence; same neighbor
  from both KG and cross-ref → single edge with the KG score (KG-wins dedupe
  before write).
- **Golden-set loader lint (r2 Fable)**: load-golden.ts errors when
  expectedVerdict='verified' AND sourceUrls is empty/missing — such rows are
  permanently unwinnable under strict grounding.
- Golden eval: unchanged mechanics (it injects cited sourceUrls — the kept
  backbone). NOTE (corrected claim): it still live-fetches cited URLs, so it
  remains network-dependent; only web-SEARCH variance disappears.

## Verification gate (not just knip)

tsc --noEmit, full unit+integration suites, `docker compose config` validation,
repo-wide grep for LANGSEARCH/SEARXNG/researched/auto-research terminology,
knip (with the caveat that scripts/\* are entries — probe-langsearch is deleted
explicitly, not via knip).

## Rollout

One PR, base current main; coordinate with #37 (MCP) — whichever lands second
rebases (file moves only).
Migration: no schema change, but ONE data migration (r6 Fable): DELETE all
legacy `claim_relation` rows with relation_type='supports' — every existing
SUPPORTS row was written exclusively by the deleted cross-ref promotion branch
(wrong direction claim→neighbor, wrong weight=certainty, similarity+verdict
provenance this redesign condemns); regenerable graph context that would
surface in the WRONG factBundle bucket after the read-path fix. Per
drizzle/README the data migration ships with a migrate.test regression
(seed legacy supports rows → migrate → assert gone; contradicts rows remain).
Legacy CONTRADICTS rows mix KG-conflict (sound) and cross-ref similarity
(contaminated) provenance that cannot be reliably separated — retained,
documented as accepted legacy imperfection.

## Residual risks (accepted, documented honestly)

- **Counter-search demotion is lost**: previously a Verified claim could be
  demoted by adversarial web search; now nothing external brakes a
  cherry-picked-but-internally-consistent source. Mitigations that remain:
  source-authority table, independence damping, KG functional-conflict veto,
  claim_feedback-driven authority decay. Accepted as the cost of zero search
  services.
- **Cross-claim contradiction is edges-only**: claim-pair NLI classification
  IS in scope at the edge level (Implementer contract item 2) — but it has NO
  verdict effect by design; verdict-level cross-claim demotion remains future
  work. Two mutually contradicting source-grounded claims can both stand as
  Verified, surfaced via NLI-classified CONTRADICTS edges and the
  contradictions tool. Honest and stated.
- Cold start: warehouse fills only as fast as agents ingest (by design).
- Uncited factual claims stay Unverified forever (feature: sources are what
  make claims verifiable; ingest contract pushes citing).
- Verification recall drops for claims with thin cited sources (no rescue
  search) → they stay Unverified; honest.
