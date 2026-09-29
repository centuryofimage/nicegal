"""Classify many terms per decisions request: one numbered state, one choice question per term."""

import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from laya_eval import HOSTED_MODEL, HOSTED_URL, LABELED

CRITERIA = {
    "thing": "an object, animal, food, place, or scene you can see in a photo",
    "vibe": "a look, mood, style, aesthetic, or era of a photo",
    "abstract": "an abstract idea, verb, or grammar word you cannot see",
    "name": "a specific person, event, title, organization, or species name",
    "foreign": "a phrase in a language other than English",
}
KEEP = {"thing", "vibe"}


# Compact mode states the definitions once and gives each question bare labels.
COMPACT = os.environ.get("DECISIONS_COMPACT") == "1"
DEFINITIONS = "Kinds of photo tag:\n" + "\n".join(f"- {k}: {v}" for k, v in CRITERIA.items())


def classify(terms: list[str]) -> tuple[list[dict], dict]:
    listing = "Photo tags:\n" + "\n".join(f"{i + 1}. {t}" for i, t in enumerate(terms))
    state = f"{DEFINITIONS}\n\n{listing}" if COMPACT else listing
    questions = {
        f"t{i + 1}": {
            "type": "choice",
            "instructions": f"Kind of #{i + 1} ({t})?" if COMPACT
            else f"What kind of photo tag is #{i + 1} ({t})?",
            "criteria": {k: k for k in CRITERIA} if COMPACT else CRITERIA,
        }
        for i, t in enumerate(terms)
    }
    body = json.dumps({"model": HOSTED_MODEL, "state": state, "questions": questions}).encode()
    req = urllib.request.Request(HOSTED_URL, body, {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}",
    })
    with urllib.request.urlopen(req, timeout=300) as res:
        reply = json.load(res)
    return [reply["answers"][f"t{i + 1}"] for i in range(len(terms))], reply["usage"]


def evaluate(size: int) -> None:
    names = list(LABELED)
    batches = [names[i : i + size] for i in range(0, len(names), size)]
    start = time.perf_counter()
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(classify, batches))
    answers = [a for r in results for a in r[0]]
    usage = [r[1] for r in results]
    cost = sum(u.get("cost", 0) for u in usage)
    tokens = sum(u["input_tokens"] for u in usage)
    keep = [sum(v for k, v in a["probabilities"].items() if k in KEEP) for a in answers]
    best = max((sum((s >= th) == LABELED[t] for s, t in zip(keep, names)), th) for th in keep)
    at_half = sum((s >= 0.5) == LABELED[t] for s, t in zip(keep, names))
    print(f"batch {size:3}: acc {best[0]}/55 @ {best[1]:.2f} (at 0.5: {at_half})  "
          f"{len(batches)} calls  {tokens} in-tokens  ${cost:.6f}  "
          f"${cost / len(names) * 1e6:.2f}/M terms  {time.perf_counter() - start:.1f}s")
    if "-v" in sys.argv:
        for s, t, a in zip(keep, names, answers):
            if (s >= 0.5) != LABELED[t]:
                print(f"    miss {'Y' if LABELED[t] else 'n'} {s:.2f} {a['choice']:8} {t}")


if __name__ == "__main__":
    for size in map(int, [a for a in sys.argv[1:] if a.isdigit()] or ["1", "10", "25", "55"]):
        if size > 0:
            evaluate(size)
