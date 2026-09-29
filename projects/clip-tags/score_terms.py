"""Loose junk filter: how well does each term match its best images in the library?

Both sides are mean-centered to remove the text/image modality gap. Each image's similarities
are then standardized against a random background of terms, so images that match everything
(text-heavy screenshots, for example) stop dominating. A term's score is the mean of its top TOP
standardized similarities. The score is only trusted at the bottom: low means the model finds
nothing for it in this library.

Writes data/term_scores.parquet with every metadata entry, its score, and its percentile.
"""

import json
import sys
import time
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

DATA = Path(__file__).parent / "data"
TOP = 200
BACKGROUND = 5000
CHUNK = 1024


def unit(x: np.ndarray) -> np.ndarray:
    return x / np.linalg.norm(x, axis=1, keepdims=True)


class Scorer:
    def __init__(self, images: np.ndarray, all_terms: np.ndarray) -> None:
        rng = np.random.default_rng(0)
        background = all_terms[rng.choice(len(all_terms), BACKGROUND, replace=False)]
        self.text_mean = all_terms.mean(0)
        self.images = unit(images - images.mean(0))
        base = unit(background - self.text_mean) @ self.images.T
        self.image_mean = base.mean(0)
        self.image_std = base.std(0)

    def __call__(self, terms: np.ndarray) -> np.ndarray:
        out = np.zeros(len(terms), np.float32)
        for i in range(0, len(terms), CHUNK):
            sims = unit(terms[i : i + CHUNK] - self.text_mean) @ self.images.T
            sims = (sims - self.image_mean) / self.image_std
            out[i : i + CHUNK] = np.partition(sims, -TOP, axis=1)[:, -TOP:].mean(1)
        return out


def embed(names: list[str]) -> np.ndarray:
    from embed_terms import MODEL, TEMPLATES
    import onnxruntime as ort
    from tokenizers import Tokenizer

    tok = Tokenizer.from_file(str(MODEL / "tokenizer.json"))
    session = ort.InferenceSession(
        str(MODEL / "text.onnx"), providers=["CPUExecutionProvider"]
    )
    acc = np.zeros((len(names), 768), np.float32)
    for start in range(0, len(names), 256):
        chunk = names[start : start + 256]
        for template in TEMPLATES:
            enc = tok.encode_batch([template.format(t=t) for t in chunk])
            acc[start : start + len(chunk)] += session.run(None, {
                "input_ids": np.array([e.ids for e in enc], np.int64),
                "attention_mask": np.array([e.attention_mask for e in enc], np.int64),
            })[0]
    return unit(acc)


def main() -> None:
    images = np.load(DATA / "images_l14.npy").astype(np.float32)
    terms = np.load(DATA / "terms_l14.npy").astype(np.float32)
    names: list[str] = json.loads((DATA / "metaclip1_metadata.json").read_text("utf-8"))
    scorer = Scorer(images, terms)

    start = time.perf_counter()
    scores = np.zeros(len(terms), np.float32)
    for i in range(0, len(terms), 50_000):
        scores[i : i + 50_000] = scorer(terms[i : i + 50_000])
        print(f"{min(i + 50_000, len(terms))}/{len(terms)}  {time.perf_counter() - start:.0f}s", flush=True)
    order = scores.argsort()
    percentile = np.empty(len(scores), np.float32)
    percentile[order] = np.arange(len(scores)) / (len(scores) - 1) * 100
    pq.write_table(
        pa.table({"term": names, "score": scores, "percentile": percentile}),
        DATA / "term_scores.parquet",
    )

    if "--labeled" in sys.argv:
        from laya_eval import LABELED

        labeled = list(LABELED)
        s = scorer(embed(labeled))
        for t, v in sorted(zip(labeled, s), key=lambda x: x[1]):
            pct = (scores < v).mean() * 100
            print(f"{'Y' if LABELED[t] else 'n'} {v:6.3f}  p{pct:5.1f}  {t}")


if __name__ == "__main__":
    main()
