"""
Knoldr fact-verifier multi-task fine-tune (continuous loop).

Pulls accumulated pseudo-gold from the live pipeline across FIVE
task formats and trains a single Gemma 4 E4B LoRA adapter on the
mixture. Specializing one model on every prompt the verify pipeline
issues lets each pass through the loop reinforce the others — a
better KG extractor produces better contradiction signals, which
become better verdict labels for the next training cycle.

Tasks (all multiplexed via task-prefix in the prompt):
  1. verdict        — claim + source → verified | disputed
  2. triples        — claim → list of (subject, predicate, object)
  3. subclaims      — complex claim → atomic sub-claims (CoVe)
  4. counter_query  — verified claim → search query that would refute it
  5. citation       — claim + source → exact supporting / refuting sentence

The data sources are the live tables — verdict comes from claims
where source_check + KG agreed, triples from kg_relation linked to
verified claims, subclaims from CoVe evidence, counter_query and
citation from accumulated counter-search and source_check evidence
respectively. All pseudo-gold; no human labels required.

Runs forever as a sleep loop:
  every KNOLDR_FT_INTERVAL_HOURS (default 168 = 1 week),
    if at least KNOLDR_FT_MIN_SAMPLES rows total are available,
      unload Ollama models to free VRAM,
      LoRA-train Gemma 4 E4B on the mixed task dataset,
      export GGUF + register knoldr-judge:vYYYYMMDD-HHMM in Ollama,
    then sleep until next interval.
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

import psycopg

DATABASE_URL = os.environ["DATABASE_URL"]
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://host.docker.internal:11434")
BASE_MODEL = os.environ.get("KNOLDR_FT_BASE", "unsloth/gemma-4-e4b-it-unsloth-bnb-4bit")
ADAPTER_OUT = Path(os.environ.get("KNOLDR_FT_ADAPTER_OUT", "/adapters"))
GGUF_OUT_DIR = Path(os.environ.get("KNOLDR_FT_GGUF_OUT", "/ollama-models/knoldr"))
MIN_SAMPLES = int(os.environ.get("KNOLDR_FT_MIN_SAMPLES", "200"))
MAX_STEPS = int(os.environ.get("KNOLDR_FT_MAX_STEPS", "600"))
INTERVAL_HOURS = int(os.environ.get("KNOLDR_FT_INTERVAL_HOURS", "168"))  # 1 week
SLEEP_BETWEEN_CHECKS_S = int(os.environ.get("KNOLDR_FT_RECHECK_SECONDS", "3600"))

# Per-task SQL. Each query returns rows that the corresponding
# format_* function turns into a single SFT example. Caps prevent
# any one task from dominating the mixture (verdict claims accumulate
# faster than CoVe ones, etc.).
SQL = {
    "verdict": """
        SELECT statement, verdict, evidence
        FROM claim
        WHERE verdict IN ('verified', 'disputed')
          AND evidence->>'source' IN ('source_check', 'cove', 'kg_contradiction')
          AND created_at > now() - interval '90 days'
        LIMIT 3000
    """,
    "triples": """
        SELECT c.statement,
               json_agg(json_build_object(
                   'subject', src.name,
                   'predicate', r.relation_type,
                   'object', tgt.name)) AS triples
        FROM claim c
        JOIN kg_relation r ON r.claim_id = c.id
        JOIN entity src ON src.id = r.source_entity_id
        JOIN entity tgt ON tgt.id = r.target_entity_id
        WHERE c.verdict = 'verified'
          AND c.created_at > now() - interval '90 days'
        GROUP BY c.id, c.statement
        LIMIT 1500
    """,
    "subclaims": """
        SELECT statement, evidence->'subClaims' AS sub
        FROM claim
        WHERE evidence->>'source' = 'cove'
          AND verdict IN ('verified', 'disputed')
          AND created_at > now() - interval '90 days'
        LIMIT 1500
    """,
    "citation": """
        SELECT statement,
               evidence->'sourceChecks'->0->>'citation' AS citation,
               verdict
        FROM claim
        WHERE evidence->>'source' = 'source_check'
          AND evidence->'sourceChecks'->0->>'citation' IS NOT NULL
          AND verdict IN ('verified', 'disputed')
          AND created_at > now() - interval '90 days'
        LIMIT 1500
    """,
}


def _format_verdict(row) -> str | None:
    statement, verdict, evidence = row
    if not evidence:
        return None
    checks = evidence.get("sourceChecks") or []
    chunk = None
    for c in checks:
        if c.get("citation"):
            chunk = c["citation"]
            break
        scores = c.get("scores") or {}
        if max(scores.get("entailment", 0), scores.get("contradiction", 0)) >= 0.7:
            chunk = (c.get("url") or "") + "\n" + json.dumps(scores)
            break
    if not chunk:
        return None
    label = "verified" if verdict == "verified" else "disputed"
    return (
        f"[task: verdict]\nClaim: {statement}\nSource: {chunk}\n"
        f"Answer with one word (verified | disputed).\n\n{label}"
    )


def _format_triples(row) -> str | None:
    statement, triples = row
    if not triples:
        return None
    out = json.dumps({"triples": triples}, ensure_ascii=False)
    return (
        f"[task: triples]\nExtract (subject, predicate, object) triples from the claim. "
        f"Respond with JSON only.\n\nClaim: {statement}\n\n{out}"
    )


def _format_subclaims(row) -> str | None:
    statement, sub = row
    if not sub:
        return None
    subs = [s.get("statement") for s in sub if s.get("statement")]
    if not subs:
        return None
    out = json.dumps({"subclaims": subs}, ensure_ascii=False)
    return (
        f"[task: subclaims]\nDecompose the claim into atomic sub-claims. "
        f"Respond with JSON only.\n\nClaim: {statement}\n\n{out}"
    )


def _format_citation(row) -> str | None:
    statement, citation, verdict = row
    if not citation:
        return None
    return (
        f"[task: citation]\nExtract the sentence from the source that best "
        f"{'supports' if verdict == 'verified' else 'refutes'} the claim.\n\n"
        f"Claim: {statement}\n\n{citation}"
    )


FORMATTERS = {
    "verdict": _format_verdict,
    "triples": _format_triples,
    "subclaims": _format_subclaims,
    "citation": _format_citation,
}


def pull_dataset(conn) -> tuple[list[str], dict[str, int]]:
    """Pull all task datasets, format, return mixed example list and
    per-task counts for logging."""
    examples: list[str] = []
    counts: dict[str, int] = {}
    for task, query in SQL.items():
        with conn.cursor() as cur:
            cur.execute(query)
            rows = cur.fetchall()
        n = 0
        for row in rows:
            text = FORMATTERS[task](row)
            if text:
                examples.append(text)
                n += 1
        counts[task] = n
    return examples, counts


def unload_ollama_models() -> None:
    """Free GPU memory before training. Lists running models and
    POSTs generate with keep_alive=0 to each — Ollama interprets
    that as "unload immediately"."""
    try:
        with urllib.request.urlopen(f"{OLLAMA_HOST}/api/ps", timeout=5) as resp:
            data = json.loads(resp.read())
        for m in data.get("models", []):
            name = m.get("name")
            if not name:
                continue
            req = urllib.request.Request(
                f"{OLLAMA_HOST}/api/generate",
                data=json.dumps({"model": name, "prompt": "", "keep_alive": 0}).encode(),
                headers={"content-type": "application/json"},
            )
            urllib.request.urlopen(req, timeout=10).read()
            print(f"unloaded ollama model {name}")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"ollama unload skipped: {e}")


def train_once() -> int:
    print(f"[{datetime.now(timezone.utc).isoformat()}] knoldr-finetune cycle start")
    with psycopg.connect(DATABASE_URL) as conn:
        examples, counts = pull_dataset(conn)
    total = len(examples)
    print(f"pulled {total} examples across tasks: {counts}")

    if total < MIN_SAMPLES:
        print(f"insufficient samples ({total} < {MIN_SAMPLES}); skipping")
        return 0

    # Free GPU before allocating ~6GB for 4-bit Gemma + LoRA. Ollama
    # auto-reloads on next inference request after training finishes.
    unload_ollama_models()

    # Lazy-import unsloth so the container can boot for inspection
    # even on hosts without GPU drivers exposed.
    from unsloth import FastLanguageModel
    from datasets import Dataset
    from trl import SFTTrainer
    from transformers import TrainingArguments

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=BASE_MODEL,
        max_seq_length=2048,
        load_in_4bit=True,
    )
    model = FastLanguageModel.get_peft_model(
        model,
        r=16,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
        lora_alpha=16,
        lora_dropout=0.0,
        bias="none",
    )

    ds = Dataset.from_list([{"text": e} for e in examples])
    ADAPTER_OUT.mkdir(parents=True, exist_ok=True)

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=ds,
        dataset_text_field="text",
        max_seq_length=2048,
        args=TrainingArguments(
            output_dir=str(ADAPTER_OUT),
            per_device_train_batch_size=2,
            gradient_accumulation_steps=4,
            warmup_steps=10,
            max_steps=MAX_STEPS,
            learning_rate=2e-4,
            fp16=False,
            bf16=True,
            logging_steps=20,
            save_strategy="no",
            optim="adamw_8bit",
        ),
    )
    trainer.train()

    GGUF_OUT_DIR.mkdir(parents=True, exist_ok=True)
    version_tag = datetime.now(timezone.utc).strftime("v%Y%m%d-%H%M")
    gguf_path = GGUF_OUT_DIR / f"knoldr-judge-{version_tag}.gguf"
    model.save_pretrained_gguf(
        str(GGUF_OUT_DIR),
        tokenizer,
        quantization_method="q4_k_m",
    )
    print(f"saved gguf at {gguf_path}")

    os.system(
        f"curl -s -X POST {OLLAMA_HOST}/api/create "
        f"-d '{{\"name\":\"knoldr-judge:{version_tag}\",\"modelfile\":\"FROM {gguf_path}\"}}'"
    )
    print(f"registered ollama model knoldr-judge:{version_tag}")
    return 0


def main() -> int:
    print(
        f"knoldr-finetune started: interval={INTERVAL_HOURS}h, "
        f"min_samples={MIN_SAMPLES}, recheck={SLEEP_BETWEEN_CHECKS_S}s"
    )
    last_train = 0.0
    while True:
        now = time.time()
        if now - last_train >= INTERVAL_HOURS * 3600:
            try:
                train_once()
                last_train = now
            except Exception as e:
                print(f"train_once failed: {type(e).__name__}: {e}")
        time.sleep(SLEEP_BETWEEN_CHECKS_S)


if __name__ == "__main__":
    sys.exit(main())
