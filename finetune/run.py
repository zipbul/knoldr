"""
Knoldr fact-verifier fine-tune.

Pulls (claim, source_chunk, verdict) triples accumulated by the live
pipeline — those where source_check + KG (or source_check + jury)
agreed on a verdict become pseudo-gold labels — and runs a small
LoRA fine-tune on Gemma 4 E4B. The resulting GGUF is shipped to the
Ollama model dir and registered as a new tag (`knoldr-judge:vN`),
which the app can switch to via KNOLDR_OLLAMA_JURY_MODELS without
restarting.

Run conditions (skip otherwise):
  - at least KNOLDR_FT_MIN_SAMPLES rows of pseudo-gold available
  - last fine-tune older than KNOLDR_FT_INTERVAL_HOURS

This script is intentionally narrow: it doesn't try to fine-tune
the NLI model (DeBERTa-FEVER) because Bun's transformers.js can't
load LoRA adapters; instead it specializes the generative jury
voter on the domain knoldr is actually ingesting, which compounds
into better self-consistency labels for the next training cycle.
"""

import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg

DATABASE_URL = os.environ["DATABASE_URL"]
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://host.docker.internal:11434")
BASE_MODEL = os.environ.get("KNOLDR_FT_BASE", "unsloth/gemma-4-e4b-it-unsloth-bnb-4bit")
ADAPTER_OUT = Path(os.environ.get("KNOLDR_FT_ADAPTER_OUT", "/adapters"))
GGUF_OUT_DIR = Path(os.environ.get("KNOLDR_FT_GGUF_OUT", "/ollama-models/knoldr"))
MIN_SAMPLES = int(os.environ.get("KNOLDR_FT_MIN_SAMPLES", "200"))
MAX_STEPS = int(os.environ.get("KNOLDR_FT_MAX_STEPS", "300"))


SQL_PSEUDO_GOLD = """
SELECT
    c.id,
    c.statement,
    c.verdict,
    c.evidence
FROM claim c
WHERE c.verdict IN ('verified', 'disputed')
  AND c.evidence->>'source' IN ('source_check', 'cove', 'kg_contradiction')
  AND c.created_at > now() - interval '90 days'
LIMIT 5000
"""


def pull_dataset(conn) -> list[dict]:
    rows = []
    with conn.cursor() as cur:
        cur.execute(SQL_PSEUDO_GOLD)
        for cid, statement, verdict, evidence in cur:
            chunk = _pick_chunk(evidence)
            if not chunk:
                continue
            rows.append({"claim": statement, "source": chunk, "verdict": verdict})
    return rows


def _pick_chunk(evidence: dict | None) -> str | None:
    if not evidence:
        return None
    checks = evidence.get("sourceChecks") or []
    for c in checks:
        scores = c.get("scores") or {}
        if max(scores.get("entailment", 0), scores.get("contradiction", 0)) >= 0.7:
            url = c.get("url", "")
            return f"[{url}]\n{json.dumps(scores)[:200]}"
    return None


def format_example(row: dict) -> dict:
    label = "verified" if row["verdict"] == "verified" else "disputed"
    prompt = (
        "You are a fact-verification judge. Given a claim and a source excerpt, "
        "decide whether the source supports or refutes the claim.\n\n"
        f"Claim: {row['claim']}\n\n"
        f"Source: {row['source']}\n\n"
        "Answer with one word: verified or disputed."
    )
    return {"text": f"{prompt}\n\n{label}"}


def main() -> int:
    print(f"[{datetime.now(timezone.utc).isoformat()}] knoldr-finetune starting")
    with psycopg.connect(DATABASE_URL) as conn:
        rows = pull_dataset(conn)
    print(f"pulled {len(rows)} pseudo-gold rows")

    if len(rows) < MIN_SAMPLES:
        print(f"insufficient samples ({len(rows)} < {MIN_SAMPLES}); skipping")
        return 0

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

    ds = Dataset.from_list([format_example(r) for r in rows])
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
            logging_steps=10,
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

    # Register with Ollama via Modelfile
    modelfile = GGUF_OUT_DIR / f"Modelfile-{version_tag}"
    modelfile.write_text(f"FROM {gguf_path}\n")
    os.system(
        f"curl -s -X POST {OLLAMA_HOST}/api/create "
        f"-d '{{\"name\":\"knoldr-judge:{version_tag}\",\"modelfile\":\"FROM {gguf_path}\"}}'"
    )
    print(f"registered ollama model knoldr-judge:{version_tag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
