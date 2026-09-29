"""Compare tag ranking formulas for one image file: raw cosine, library-centered, and z-score."""

import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

from embed_terms import MODEL

DATA = Path(__file__).parent / "data"
MEAN = np.array([0.48145466, 0.4578275, 0.40821073], np.float32)
STD = np.array([0.26862954, 0.26130258, 0.27577711], np.float32)


def embed_image(path: str) -> np.ndarray:
    img = Image.open(path).convert("RGB")
    scale = 224 / min(img.size)
    img = img.resize((round(img.width * scale), round(img.height * scale)), Image.BICUBIC)
    left, top = (img.width - 224) // 2, (img.height - 224) // 2
    img = img.crop((left, top, left + 224, top + 224))
    x = ((np.asarray(img, np.float32) / 255 - MEAN) / STD).transpose(2, 0, 1)[None]
    session = ort.InferenceSession(str(MODEL / "image.onnx"), providers=["CPUExecutionProvider"])
    v = session.run(None, {session.get_inputs()[0].name: x})[0][0]
    return v / np.linalg.norm(v)


def main() -> None:
    meta = json.loads((DATA / "tags_l14.json").read_text("utf-8"))
    tags = meta["tags"]
    vectors = np.fromfile(DATA / "tags_l14.f32", "<f4").reshape(len(tags), 768)
    mean = np.array([t["mean"] for t in tags], np.float32)
    std = np.array([t["std"] for t in tags], np.float32)
    kinds = np.array([t["kind"] for t in tags])

    image = embed_image(sys.argv[1])
    cos = vectors @ image
    methods = {
        "raw cosine": cos,
        "cosine - library mean": cos - mean,
        "z-score (current)": (cos - mean) / std,
        "z, std floored at median": (cos - mean) / np.maximum(std, np.median(std)),
    }
    for name, score in methods.items():
        print(f"== {name}")
        for kind in ("thing", "vibe"):
            idx = np.where(kinds == kind)[0]
            top = idx[np.argsort(-score[idx])[:15]]
            print(f"  {kind}: " + ", ".join(tags[i]["term"] for i in top))


if __name__ == "__main__":
    main()
