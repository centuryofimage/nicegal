"""Embed a public reference image set into data/<name>_<model>.npy.

    embed_reference.py <model> <name> <folder under data/> [limit]

Images are squashed to the model's square input like nicegal-server does, so reference statistics
match the vectors stored in a library.
"""

import random
import sys
import tarfile
import time
import zipfile
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

from models import MODELS, ImageEncoder

DATA = Path(__file__).parent / "data"
BATCH = 32


def images(folder: Path, limit: int | None) -> Iterator[bytes]:
    """Encoded images from parquet files with an `image` column, webdataset tar shards, or zip
    archives. A zip is sampled to `limit` images with a fixed seed instead of being extracted."""
    for path in sorted(folder.glob("*.parquet")):
        for record in pq.ParquetFile(path).iter_batches(batch_size=256, columns=["image"]):
            for image in record.column("image").to_pylist():
                yield image["bytes"]
    for path in sorted(folder.glob("*.tar")):
        with tarfile.open(path) as tar:
            for member in tar:
                if member.name.endswith(".jpg"):
                    yield tar.extractfile(member).read()
    for path in sorted(folder.glob("*.zip")):
        with zipfile.ZipFile(path) as archive:
            names = [n for n in archive.namelist() if n.lower().endswith((".png", ".jpg", ".jpeg"))]
            if limit is not None and limit < len(names):
                names = random.Random(0).sample(names, limit)
            print(f"{path.name}: {len(names):,} images", flush=True)
            for name in names:
                yield archive.read(name)


def main() -> None:
    model, name, folder = MODELS[sys.argv[1]], sys.argv[2], DATA / sys.argv[3]
    limit = int(sys.argv[4]) if len(sys.argv) > 4 else None
    encoder = ImageEncoder(model)
    batch_size = encoder.fixed_batch or BATCH
    vectors, batch, skipped = [], [], 0
    start = time.perf_counter()
    for data in images(folder, limit):
        try:
            batch.append(encoder.tensor(data))
        except (OSError, ValueError):
            skipped += 1
            continue
        if len(batch) == batch_size:
            vectors.append(encoder(batch))
            batch = []
            done = sum(len(v) for v in vectors)
            if done % 1024 == 0:
                print(f"{done} images, {done / (time.perf_counter() - start):.0f}/s", flush=True)
    if batch:
        vectors.append(encoder(batch))
    out = np.concatenate(vectors)
    path = DATA / f"{name}_{model.short}.npy"
    np.save(path, out.astype(np.float16))
    print(f"{len(out)} images ({skipped} unreadable) in {time.perf_counter() - start:.0f}s -> {path.name}")


if __name__ == "__main__":
    main()
