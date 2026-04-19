"""
Knoldr fact-verifier fine-tune (continuous loop).

Pulls (claim, source_chunk, verdict) triples accumulated by the live
pipeline — those where source_check + KG (or source_check + jury)
agreed on a verdict become pseudo-gold labels — and runs a small
LoRA fine-tune on Gemma 4 E4B. The resulting GGUF is shipped to the
Ollama model dir and registered as a new tag (`knoldr-judge:vN`),
which the app can switch to via KNOLDR_OLLAMA_JURY_MODELS without
restarting.

Runs forever as a sleep loop:
  every KNOLDR_FT_INTERVAL_HOURS (default 168 = 1 week),
    if at least KNOLDR_FT_MIN_SAMPLES rows of pseudo-gold are
    available since the last successful train,
      unload Ollama models to free VRAM,
      LoRA-train Gemma 4 E4B on the new pseudo-gold,
      export GGUF + register knoldr-judge:vYYYYMMDD-HHMM in Ollama,
    then sleep until next interval.

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
import urllib.request
import urllib.error
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
INTERVAL_HOURS = int(os.environ.get("KNOLDR_FT_INTERVAL_HOURS", "168"))  # 1 week
SLEEP_BETWEEN_CHECKS_S = int(os.environ.get("KNOLDR_FT_RECHECK_SECONDS", "3600"))  # 1h


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


def unload_ollama_models() -> None:
    """Free GPU memory before training. Lists running models and
    POSTs a generate-with-keep_alive=0 to each, which Ollama
    interprets as "unload immediately"."""
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
        rows = pull_dataset(conn)
    print(f"pulled {len(rows)} pseudo-gold rows")

    if len(rows) < MIN_SAMPLES:
        print(f"insufficient samples ({len(rows)} < {MIN_SAMPLES}); skipping")
        return 0

    # Free GPU before allocating ~6GB for 4-bit Gemma + LoRA. Ollama
    # auto-reloads on the next inference request after training.
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


def main() -> int:
    """Sleep loop: re-check every hour, train every INTERVAL_HOURS
    when conditions are met. Errors are logged but don't kill the
    loop — a transient OOM or network blip should not stop the
    long-term improvement cycle."""
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
