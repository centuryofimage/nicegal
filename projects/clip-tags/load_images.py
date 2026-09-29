"""Copy one L/14 embedding per asset from the nicegal-server database into data/images_l14.npy.

Reads only numeric ids and vectors; paths and file metadata are never selected.
"""

import os
import sqlite3
from pathlib import Path

import numpy as np
import sqlite_vec

DB = Path(os.environ["APPDATA"]) / "nicegal/nicegal-server/facebook-metaclip-2-worldwide-l14.db"
DATA = Path(__file__).parent / "data"


def main() -> None:
    con = sqlite3.connect(f"file:{DB.as_posix()}?mode=ro", uri=True)
    con.enable_load_extension(True)
    sqlite_vec.load(con)
    # Videos have several sampled frames; keep the first so they weigh the same as photos.
    rows = con.execute(
        """
        SELECT e.embedding FROM image_embeddings e
        JOIN (SELECT MIN(embedding_id) AS id FROM image_embedding_samples GROUP BY asset_id) f
          ON e.embedding_id = f.id
        """
    ).fetchall()
    vectors = np.frombuffer(b"".join(r[0] for r in rows), np.float32).reshape(-1, 768)
    norms = np.linalg.norm(vectors, axis=1)
    print(f"{len(vectors)} assets, norm range {norms.min():.4f}..{norms.max():.4f}")
    np.save(DATA / "images_l14.npy", (vectors / norms[:, None]).astype(np.float16))


if __name__ == "__main__":
    main()
