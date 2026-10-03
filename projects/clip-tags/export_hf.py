"""Assemble the Hugging Face tag repository in data/hf/ from the per-model tag exports.

    export_hf.py [model ...]     keys of models.MODELS; default: every model with a tag export

vocabulary                 the shared tag list, one tag per line in the same order everywhere,
                           UTF-8 with LF line endings and a header row:
                           term, kind (simple|subject|vibe), source (metaclip|wordnet),
                           sensitivity (ok|mature|blocked). Terms contain no tabs or newlines.
<model id, / as -->.safetensors
    embeddings       float16 [tags, dimensions]  unit text vectors, in vocabulary order
    reference_mean   float32 [dimensions]         mean image vector of the reference image set
    metadata         model id, vocabulary sha256, prompt templates, text lowercasing

README.md is copied from hf_card.md.
"""

import hashlib
import json
import shutil
import sys
from pathlib import Path

import numpy as np
from safetensors.numpy import save_file

from build_tags import REFERENCE
from models import MODELS, TEMPLATES

DATA = Path(__file__).parent / "data"
OUT = DATA / "hf"
KINDS = {"simple": "simple", "thing": "subject", "vibe": "vibe"}
COLUMNS = ["term", "kind", "source", "sensitivity"]


def write_vocabulary(tags: list[dict]) -> bytes:
    """Write the extensionless TSV vocabulary and return its bytes."""
    for t in tags:
        if any(c in t["term"] for c in "\t\r\n"):
            raise SystemExit(f"term cannot be written as TSV: {t['term']!r}")
    lines = ["\t".join(COLUMNS)] + ["\t".join(t[c] for c in COLUMNS) for t in tags]
    data = ("\n".join(lines) + "\n").encode("utf-8")
    (OUT / "vocabulary").write_bytes(data)
    return data


def main() -> None:
    keys = sys.argv[1:] or [
        k for k, m in MODELS.items() if (DATA / f"tags_{m.id.replace('/', '--')}.json").exists()
    ]
    OUT.mkdir(exist_ok=True)
    vocabulary: list[dict] | None = None
    vocabulary_bytes = b""
    for key in keys:
        model = MODELS[key]
        name = model.id.replace("/", "--")
        export = json.loads((DATA / f"tags_{name}.json").read_text("utf-8"))
        tags = [
            {"term": t["term"], "kind": KINDS[t["kind"]], "source": t["source"],
             "sensitivity": t["sensitivity"]}
            for t in export["tags"]
        ]
        if vocabulary is None:
            vocabulary = tags
            vocabulary_bytes = write_vocabulary(tags)
            for old in ("vocabulary.json", "vocabulary.safetensors", "vocabulary.tsv"):
                (OUT / old).unlink(missing_ok=True)
        elif tags != vocabulary:
            raise SystemExit(f"{model.id} was exported with a different tag list")

        vectors = np.fromfile(DATA / f"tags_{name}.f32", "<f4").reshape(len(tags), -1)
        reference = np.load(DATA / f"{REFERENCE}_{model.short}.npy").astype(np.float32).mean(0)
        save_file(
            {"embeddings": vectors.astype(np.float16), "reference_mean": reference},
            OUT / f"{name}.safetensors",
            metadata={
                "model": model.id,
                "vocabulary_sha256": hashlib.sha256(vocabulary_bytes).hexdigest(),
                "templates": json.dumps(TEMPLATES),
                "lowercase_text": str(model.lowercase).lower(),
                "reference": "8,000 random images from the Reddit Visual Context dataset (kaggle.com/datasets/hamzasibous/reddit-dataset)",
            },
        )
        size = (OUT / f"{name}.safetensors").stat().st_size / 1e6
        print(f"{name}.safetensors: {vectors.shape[0]:,} x {vectors.shape[1]}, {size:.0f} MB")
    shutil.copy(Path(__file__).parent / "hf_card.md", OUT / "README.md")
    (OUT / ".gitattributes").write_text(
        "*.safetensors filter=lfs diff=lfs merge=lfs -text\nvocabulary -text\n", encoding="utf-8")


if __name__ == "__main__":
    main()
