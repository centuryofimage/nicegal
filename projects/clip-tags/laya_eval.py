"""Score laya question phrasings against a small hand-labeled set of metadata entries."""

import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

URL = "http://localhost:8888/v1/systemone"

# True: worth running against a photo library as a tag. False: keep in the list, but not a tag.
LABELED: dict[str, bool] = {
    # moods, styles, eras
    "scary": True, "creepy": True, "crazy": True, "cozy": True, "spooky": True,
    "cursed": True, "aesthetic": True, "nostalgia": True, "vaporwave": True,
    "glitch": True, "2000s": True, "1990s": True, "y2k": True, "vintage": True,
    "minimalist": True, "blurry": True, "neon": True,
    # subjects and scenes
    "meme": True, "memes": True, "dog": True, "beach": True, "sunset": True,
    "selfie": True, "wedding": True, "graffiti": True, "snow": True,
    "crowd": True, "birthday cake": True, "abandoned building": True,
    "screenshot": True, "receipt": True, "cat": True,
    # abstract, grammatical, or too specific
    "dictated": False, "odious": False, "categorizing": False, "metathesis": False,
    "inter-colonial": False, "tuttle's": False, "neuwirth": False,
    "etymological dictionary": False, "Autoregressive model": False,
    "Fedosey Manukov": False, "2017 Congressional baseball shooting": False,
    "The Shrink Next Door": False, "10th South Indian International Movie Awards": False,
    "Dari (Persian)": False, "juokaamme likööri": False, "Mitravindo dwaham": False,
    "Största vindkraftverket": False, "winteraceae": False, "amaliada": False,
    "Zolpidem": False, "chatbots": False, "silting": False, "good-king-henry": False,
}

# (state template, question) pairs; {t} is the metadata entry.
VARIANTS: dict[str, tuple[str, str]] = {
    "bare_tag": ("{t}", "Would this make a useful tag for sorting a personal photo collection?"),
    "tumblr": ("A tumblr post of a photo is tagged #{t}",
               "Does the tag describe what the photo shows or how it looks or feels?"),
    "photo_tagged": ("A photo in someone's camera roll was tagged \"{t}\".",
                     "Is this tag something you could see or feel just by looking at the photo?"),
    "search": ("Someone searched their photo gallery for \"{t}\".",
               "Is this a normal thing to search for to find a picture by what it looks like?"),
    "insta": ("Instagram hashtag: #{t}",
              "Is this a hashtag people put on photos to describe the picture or its vibe?"),
}


HOSTED_URL = "https://openrouter.ai/api/alpha/decisions"
HOSTED_MODEL = "typesafe/jev-1.13"
# Set DECISIONS_HOSTED=1 and OPENROUTER_API_KEY to use the hosted model instead of local laya.
HOSTED = os.environ.get("DECISIONS_HOSTED") == "1"
cost = 0.0


def ask(state: str, questions: dict) -> dict:
    global cost
    headers = {"Content-Type": "application/json"}
    if HOSTED:
        headers["Authorization"] = f"Bearer {os.environ['OPENROUTER_API_KEY']}"
    model = HOSTED_MODEL if HOSTED else "laya"
    body = json.dumps({"model": model, "state": state, "questions": questions}).encode()
    req = urllib.request.Request(HOSTED_URL if HOSTED else URL, body, headers)
    with urllib.request.urlopen(req, timeout=120) as res:
        reply = json.load(res)
    cost += reply["usage"].get("cost", 0.0)
    return reply["answers"]


def main() -> None:
    jobs = [(t, k) for t in LABELED for k in VARIANTS]

    def run(job: tuple[str, str]) -> float:
        t, k = job
        state, question = VARIANTS[k]
        return ask(state.format(t=t), {"q": {"type": "noul", "instructions": question}})["q"]["noul"]

    start = time.perf_counter()
    with ThreadPoolExecutor(8) as pool:
        flat = dict(zip(jobs, pool.map(run, jobs)))
    elapsed = time.perf_counter() - start
    print(f"{len(jobs)} calls in {elapsed:.1f}s\n")
    answers = {t: {k: {"noul": flat[(t, k)]} for k in VARIANTS} for t in LABELED}

    for key in VARIANTS:
        scores = {t: answers[t][key]["noul"] for t in LABELED}
        # best single threshold accuracy
        best = max(
            (sum((scores[t] >= th) == LABELED[t] for t in LABELED), th)
            for th in sorted(set(scores.values()))
        )
        pos = [scores[t] for t in LABELED if LABELED[t]]
        neg = [scores[t] for t in LABELED if not LABELED[t]]
        print(f"{key:16} acc {best[0]}/{len(LABELED)} @ {best[1]:.3f}  "
              f"yes-mean {sum(pos)/len(pos):.3f}  no-mean {sum(neg)/len(neg):.3f}")

    if "-v" in sys.argv:
        print()
        for t in LABELED:
            row = " ".join(f"{answers[t][k]['noul']:.2f}" for k in VARIANTS)
            print(f"{'Y' if LABELED[t] else 'n'} {row}  {t}")


if __name__ == "__main__":
    main()
