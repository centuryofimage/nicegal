"""Few-shot noul and choice-type variants against the laya_eval labeled set."""

import sys
import time
from concurrent.futures import ThreadPoolExecutor

import laya_eval
from laya_eval import LABELED, ask

# Examples are disjoint from LABELED.
FEWSHOT = (
    "Decide if this is a good tag for photos: something you can see in a picture "
    "(object, animal, place, scene, activity) or its look, mood, style, or era.\n"
    "Examples of yes: rainy, skateboard, polaroid, gloomy, 1980s, kitchen, glitter, dramatic.\n"
    "Examples of no: notwithstanding, Heinrich Böll, thermodynamics, "
    "2014 Winter Olympics bid, Lepidoptera genus, rechargeable, Suomen kieli."
)

CRITERIA = {
    "thing": "an object, animal, food, place, or scene you can see in a photo",
    "vibe": "a look, mood, style, aesthetic, or era of a photo",
    "abstract": "an abstract idea, verb, or grammar word you cannot see",
    "name": "a specific person, event, title, organization, or species name",
    "foreign": "a phrase in a language other than English",
}
KEEP = {"thing", "vibe"}

VARIANTS = {
    "fewshot_bare": ("{t}", {"type": "noul", "instructions": FEWSHOT}),
    "fewshot_tag": ("Photo tag: {t}", {"type": "noul", "instructions": FEWSHOT}),
    "choice": ("{t}", {"type": "choice", "instructions": "What kind of term is this?",
                       "criteria": CRITERIA}),
    "choice_tag": ("Photo tag: {t}", {"type": "choice",
                                      "instructions": "What kind of photo tag is this?",
                                      "criteria": CRITERIA}),
}


def score(answer: dict) -> float:
    if answer["type"] == "noul":
        return answer["noul"]
    dist = answer["probabilities"]
    return sum(v for k, v in dist.items() if k in KEEP)


def main() -> None:
    raw = ask("scary", {"q": VARIANTS["choice"][1]})
    print("choice response shape:", raw, "\n")

    jobs = [(t, k) for t in LABELED for k in VARIANTS]

    def run(job):
        t, k = job
        state, q = VARIANTS[k]
        return ask(state.format(t=t), {"q": q})["q"]

    start = time.perf_counter()
    with ThreadPoolExecutor(8) as pool:
        flat = dict(zip(jobs, pool.map(run, jobs)))
    print(f"{len(jobs)} calls in {time.perf_counter() - start:.1f}s\n")

    for k in VARIANTS:
        s = {t: score(flat[(t, k)]) for t in LABELED}
        best = max((sum((s[t] >= th) == LABELED[t] for t in LABELED), th) for th in set(s.values()))
        pos = [s[t] for t in LABELED if LABELED[t]]
        neg = [s[t] for t in LABELED if not LABELED[t]]
        print(f"{k:14} acc {best[0]}/{len(LABELED)} @ {best[1]:.3f}  "
              f"yes-mean {sum(pos)/len(pos):.3f}  no-mean {sum(neg)/len(neg):.3f}")

    if "-v" in sys.argv:
        print()
        for t in LABELED:
            row = " ".join(f"{score(flat[(t, k)]):.2f}" for k in VARIANTS)
            top = max(flat[(t, "choice")]["probabilities"].items(), key=lambda x: x[1], default=("?", 0))
            print(f"{'Y' if LABELED[t] else 'n'} {row}  {top[0]:8} {t}")


if __name__ == "__main__":
    main()
