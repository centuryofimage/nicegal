"""Classify every kept label with the hosted decisions model, resumably.

Appends one JSON line per label to data/decisions.jsonl, then writes the kind and probabilities
back into data/terms.parquet. Rerunning skips labels that already have a decision.
Needs OPENROUTER_API_KEY; uses the compact batched prompt from decide_batch.py.
"""

import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

os.environ["DECISIONS_COMPACT"] = "1"
from decide_batch import CRITERIA, classify  # noqa: E402

DATA = Path(__file__).parent / "data"
LOG = DATA / "decisions.jsonl"
BATCH = 55
WORKERS = 8


def attempt(terms: list[str]) -> tuple[list[str], list[dict], dict]:
    for tries in range(5):
        try:
            answers, usage = classify(terms)
            return terms, answers, usage
        except Exception as e:  # noqa: BLE001
            if tries == 4:
                raise
            print(f"retry {tries + 1} after {e!r}", flush=True)
            time.sleep(2 ** tries)
    raise AssertionError


def run() -> None:
    table = pq.read_table(DATA / "terms.parquet").to_pylist()
    done: set[str] = set()
    if LOG.exists():
        done = {json.loads(line)["term"] for line in LOG.open(encoding="utf-8")}
    todo = [r["term"] for r in table if r["junk"] is None and r["term"] not in done]
    limit = next((int(a) for a in sys.argv[1:] if a.isdigit()), None)
    todo = todo[:limit]
    batches = [todo[i : i + BATCH] for i in range(0, len(todo), BATCH)]
    print(f"{len(done):,} done, {len(todo):,} to classify in {len(batches):,} requests", flush=True)

    cost, count, start = 0.0, 0, time.perf_counter()
    with LOG.open("a", encoding="utf-8") as log, ThreadPoolExecutor(WORKERS) as pool:
        for future in as_completed(pool.submit(attempt, b) for b in batches):
            terms, answers, usage = future.result()
            for t, a in zip(terms, answers):
                log.write(json.dumps({"term": t, "kind": a["choice"],
                                      "p": a["probabilities"]}, ensure_ascii=False) + "\n")
            log.flush()
            cost += usage.get("cost", 0.0)
            count += len(terms)
            if count // BATCH % 100 == 0 or count == len(todo):
                rate = count / (time.perf_counter() - start)
                print(f"{count:,}/{len(todo):,}  ${cost:.4f}  {rate:.0f}/s", flush=True)
    print(f"spent ${cost:.4f} this run")


def merge() -> None:
    decisions = {}
    for line in LOG.open(encoding="utf-8"):
        d = json.loads(line)
        decisions[d["term"]] = d
    table = pq.read_table(DATA / "terms.parquet")
    terms = table.column("term").to_pylist()
    cols = {"kind": [decisions.get(t, {}).get("kind") for t in terms]}
    for k in CRITERIA:
        cols[f"p_{k}"] = [decisions[t]["p"].get(k) if t in decisions else None for t in terms]
    for name, values in cols.items():
        if name in table.column_names:
            table = table.drop_columns([name])
        table = table.append_column(name, pa.array(values, pa.string() if name == "kind" else pa.float32()))
    pq.write_table(table, DATA / "terms.parquet")
    kinds: dict[str, int] = {}
    for k in cols["kind"]:
        if k:
            kinds[k] = kinds.get(k, 0) + 1
    print("kinds:", ", ".join(f"{k} {v:,}" for k, v in sorted(kinds.items(), key=lambda x: -x[1])))


if __name__ == "__main__":
    if "--merge-only" not in sys.argv:
        run()
    merge()
