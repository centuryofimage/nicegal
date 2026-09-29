"""Embed every metadata entry with the MetaCLIP2 L/14 text tower into data/terms_l14.npy."""

import json
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MODEL = Path.home() / (
    ".cache/huggingface/hub/models--bep256--metaclip-2-worldwide-l14-ONNX/"
    "snapshots/c7193980d96e63812a6f70f8ef3feb934549326f"
)
DATA = Path(__file__).parent / "data"
TEMPLATES = ["a photo of {t}.", "{t}"]
BATCH = 256


def main() -> None:
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else None
    terms: list[str] = json.loads((DATA / "metaclip1_metadata.json").read_text("utf-8"))[:limit]

    tok = Tokenizer.from_file(str(MODEL / "tokenizer.json"))
    session = ort.InferenceSession(
        str(MODEL / "text.onnx"), providers=["DmlExecutionProvider", "CPUExecutionProvider"]
    )

    out = np.zeros((len(terms), 768), np.float32)
    start = time.perf_counter()
    for i in range(0, len(terms), BATCH):
        chunk = terms[i : i + BATCH]
        acc = np.zeros((len(chunk), 768), np.float32)
        for template in TEMPLATES:
            enc = tok.encode_batch([template.format(t=t) for t in chunk])
            ids = np.array([e.ids for e in enc], np.int64)
            mask = np.array([e.attention_mask for e in enc], np.int64)
            acc += session.run(None, {"input_ids": ids, "attention_mask": mask})[0]
        out[i : i + len(chunk)] = acc / np.linalg.norm(acc, axis=1, keepdims=True)
        if (i // BATCH) % 100 == 0:
            done = i + len(chunk)
            rate = done / (time.perf_counter() - start)
            print(f"{done}/{len(terms)}  {rate:.0f} terms/s", flush=True)

    name = "terms_l14.npy" if limit is None else f"terms_l14_{limit}.npy"
    np.save(DATA / name, out.astype(np.float16))
    print(f"done in {time.perf_counter() - start:.0f}s -> {name}")


if __name__ == "__main__":
    main()
