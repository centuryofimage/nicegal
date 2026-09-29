"""Export the tag set for one model for nicegal-server's temporary tag route.

    build_tags.py [model]      model is a key of models.MODELS, default l14

tags_<model id with / as -->.{json,f32}  simple words, subjects (kind "thing") and vibes. Each carries
                         `baseline`, its cosine with the mean vector of a public reference image
                         set (an 8k sample of a Kaggle Reddit image dataset), so the server can
                         score "how much more than a typical image" without looking at the user's
                         library, and `sensitivity` (ok, mature, blocked).

Vectors are row-major little-endian float32, one unit row per tag, in list order.
"""

import json
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

from models import MODELS, Model, TextEncoder

DATA = Path(__file__).parent / "data"
REFERENCE = "reddit"


def select(table) -> list[dict]:
    """Subjects and vibes the LLM classified with probability at least 0.5, plus the simple words
    from classify_simple.py, which get their own kind and leave the other two lists."""
    simple = set(json.loads((DATA / "simple_words.json").read_text("utf-8")))
    rows = []
    for r in table.to_pylist():
        if r["term"] in simple:
            rows.append({**r, "kind": "simple"})
        elif r["junk"] is None and (
            (r["kind"] == "thing" and r["p_thing"] >= 0.5)
            or (r["kind"] == "vibe" and r["p_vibe"] >= 0.5)
        ):
            rows.append(r)
    return rows


def vectors_for(model: Model, terms: list[str]) -> np.ndarray:
    """Text vectors for `terms`, embedded once per model and cached by term."""
    cache_path = DATA / f"text_cache_{model.short}.npz"
    cache: dict[str, np.ndarray] = {}
    if cache_path.exists():
        saved = np.load(cache_path)
        cache = dict(zip(saved["terms"].tolist(), saved["vectors"]))
    new = [t for t in dict.fromkeys(terms) if t not in cache]
    if new:
        cache.update(zip(new, TextEncoder(model)(new)))
        np.savez(cache_path, terms=np.array(list(cache)), vectors=np.stack(list(cache.values())))
    print(f"  {len(new):,} labels embedded now")
    return np.stack([cache[t] for t in terms]).astype(np.float32)


def main() -> None:
    model = MODELS[sys.argv[1] if len(sys.argv) > 1 else "l14"]
    rows = select(pq.read_table(DATA / "terms.parquet"))
    print(f"{model.id}: {len(rows):,} tags")
    vectors = vectors_for(model, [r["term"] for r in rows])
    reference = f"{REFERENCE}_{model.short}.npy"
    baseline = vectors @ np.load(DATA / reference).astype(np.float32).mean(0)
    tags = [
        {"term": r["term"], "kind": r["kind"], "source": r["source"],
         "sensitivity": r["sensitivity"] or "ok", "baseline": round(float(b), 5)}
        for r, b in zip(rows, baseline)
    ]
    name = f"tags_{model.id.replace('/', '--')}"
    body = {"model": model.id, "dimensions": model.dimensions, "reference": reference, "tags": tags}
    (DATA / f"{name}.json").write_text(json.dumps(body, ensure_ascii=False), "utf-8")
    vectors.astype("<f4").tofile(DATA / f"{name}.f32")
    print(f"  wrote {name}: {len(tags):,} tags")


if __name__ == "__main__":
    main()
