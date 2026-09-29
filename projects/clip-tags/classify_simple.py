"""Pick the simple tags: very common English words that describe a picture, like car or happy.

Candidates are wordfreq's most common English words that are not names, foreign words or title
fragments. The hosted decisions model answers one yes/no question for each, resumably, into
data/simple.jsonl. `--check` runs only the hand-labeled CHECK set. Needs OPENROUTER_API_KEY.

`--finalize` writes data/simple_words.json: answers at MIN_P or above that WordNet knows as a noun
or adjective, with plurals and comparatives folded into a kept base word.
"""

import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pyarrow.parquet as pq
from wordfreq import top_n_list

from laya_eval import HOSTED_MODEL, HOSTED_URL

DATA = Path(__file__).parent / "data"
LOG = DATA / "simple.jsonl"
CANDIDATES = 10_000
BATCH = 55
WORKERS = 8
MIN_P = 0.6

QUESTION = (
    "Is this a simple everyday word that could describe what a picture shows or how it looks or "
    "feels? Yes: car, art, person, happy, smile, tree, night, red, food, music, text, funny. "
    "No: however, provide, the, would, policy, although, january, percent."
)

CHECK = {
    "car": True, "art": True, "person": True, "happy": True, "smile": True, "cat": True,
    "beach": True, "sky": True, "cute": True, "dark": True, "phone": True, "game": True,
    "however": False, "provide": False, "would": False, "policy": False, "january": False,
    "percent": False, "therefore": False, "government": False, "said": False, "yes": False,
}


def candidates() -> list[str]:
    rows = {
        r["term"]: r
        for r in pq.read_table(DATA / "terms.parquet", columns=["term", "junk", "kind"]).to_pylist()
    }
    out = []
    for word in top_n_list("en", CANDIDATES):
        if len(word) < 3 or not word.replace("-", "").isalpha():
            continue
        row = rows.get(word)
        if row and (row["kind"] in ("name", "foreign") or row["junk"] == "title"):
            continue
        out.append(word)
    return out


def ask(words: list[str]) -> tuple[list[float], dict]:
    listing = "Words:\n" + "\n".join(f"{i + 1}. {w}" for i, w in enumerate(words))
    questions = {
        f"w{i + 1}": {"type": "noul", "instructions": f"#{i + 1} ({w}): {QUESTION}"}
        for i, w in enumerate(words)
    }
    body = json.dumps({"model": HOSTED_MODEL, "state": listing, "questions": questions}).encode()
    req = urllib.request.Request(HOSTED_URL, body, {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}",
    })
    for tries in range(5):
        try:
            with urllib.request.urlopen(req, timeout=300) as res:
                reply = json.load(res)
            return [reply["answers"][f"w{i + 1}"]["noul"] for i in range(len(words))], reply["usage"]
        except Exception as e:  # noqa: BLE001
            if tries == 4:
                raise
            print(f"retry {tries + 1} after {e!r}", flush=True)
            time.sleep(2 ** tries)
    raise AssertionError


def check() -> None:
    answers, usage = ask(list(CHECK))
    right = sum((p >= 0.5) == want for p, want in zip(answers, CHECK.values()))
    for (word, want), p in zip(CHECK.items(), answers):
        print(f"{'   ' if (p >= 0.5) == want else 'BAD'} {word:12} want {want!s:5} p {p:.2f}")
    print(f"{right}/{len(CHECK)} right, ${usage.get('cost', 0):.5f}")


def run() -> None:
    done: set[str] = set()
    if LOG.exists():
        done = {json.loads(line)["term"] for line in LOG.open(encoding="utf-8")}
    todo = [w for w in candidates() if w not in done]
    batches = [todo[i : i + BATCH] for i in range(0, len(todo), BATCH)]
    print(f"{len(done):,} done, {len(todo):,} to ask in {len(batches):,} requests", flush=True)
    cost = 0.0
    with LOG.open("a", encoding="utf-8") as log, ThreadPoolExecutor(WORKERS) as pool:
        futures = {pool.submit(ask, b): b for b in batches}
        for future in as_completed(futures):
            answers, usage = future.result()
            for word, p in zip(futures[future], answers):
                log.write(json.dumps({"term": word, "p": p}) + "\n")
            log.flush()
            cost += usage.get("cost", 0.0)
    kept = [json.loads(line) for line in LOG.open(encoding="utf-8")]
    print(f"spent ${cost:.4f}; {sum(k['p'] >= 0.5 for k in kept):,} of {len(kept):,} are simple")


def finalize() -> None:
    import nltk

    nltk.data.path.insert(0, str(DATA / "nltk"))
    from nltk.corpus import wordnet as wn

    answers = {
        d["term"]: d["p"] for d in map(json.loads, LOG.open(encoding="utf-8"))
    }

    def folded(word: str) -> bool:
        return any(
            (base := wn.morphy(word, pos)) and base != word and answers.get(base, 0) >= MIN_P
            for pos in ("n", "a")
        )

    words = [
        w for w, p in answers.items()
        if p >= MIN_P
        and any(wn.synsets(w, pos=pos) for pos in ("n", "a", "s"))
        and not folded(w)
    ]
    (DATA / "simple_words.json").write_text(json.dumps(words), "utf-8")
    print(f"{len(words):,} simple words")


if __name__ == "__main__":
    if "--check" in sys.argv:
        check()
    elif "--finalize" in sys.argv:
        finalize()
    else:
        run()
