"""Benchmark file-name/path search on a private copy of Nicegal's asset catalog.

Install APSW in a scratch environment with ``uv venv`` and ``uv pip install``; then run
``<venv-python> scripts/benchmark_file_search.py --source <assets.db> --output <scratch.db>``.
The output contains aggregate timings only; it never prints indexed paths or terms.
"""

from __future__ import annotations

import argparse
import collections
import json
import random
import sqlite3
import statistics
import sys
import time
from pathlib import Path

import apsw
import apsw.bestpractice


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int((len(ordered) - 1) * fraction))]


def measure(connection: apsw.Connection, sql: str, parameter: str, repetitions: int = 30) -> dict[str, float | int]:
    samples: list[float] = []
    count = 0
    for _ in range(3):
        count = connection.execute(sql, (parameter,)).fetchone()[0]
    for _ in range(repetitions):
        start = time.perf_counter_ns()
        count = connection.execute(sql, (parameter,)).fetchone()[0]
        samples.append((time.perf_counter_ns() - start) / 1_000_000)
    return {"matches": count, "median_ms": round(statistics.median(samples), 3), "p95_ms": round(percentile(samples, 0.95), 3)}


def measure_page(connection: apsw.Connection, sql: str, parameter: str, repetitions: int = 30) -> dict[str, float | int]:
    samples: list[float] = []
    for _ in range(3):
        list(connection.execute(sql, (parameter,)))
    for _ in range(repetitions):
        start = time.perf_counter_ns()
        page = list(connection.execute(sql, (parameter,)))
        samples.append((time.perf_counter_ns() - start) / 1_000_000)
    return {"returned": len(page), "median_ms": round(statistics.median(samples), 3), "p95_ms": round(percentile(samples, 0.95), 3)}


def choose_terms(values: list[str], length: int, seed: int) -> list[tuple[str, str]]:
    rng = random.Random(seed)
    candidates: set[str] = set()
    for value in rng.sample(values, min(1500, len(values))):
        lower = value.lower()
        for _ in range(3):
            if len(lower) < length:
                continue
            offset = rng.randrange(len(lower) - length + 1)
            term = lower[offset : offset + length]
            if term.isascii() and term.isalpha():
                candidates.add(term)
        if len(candidates) >= 150:
            break
    counts = {term: sum(term in value for value in values) for term in candidates}
    if not counts:
        return []
    selected: list[tuple[str, str]] = []
    for label, target in (("rare", 5), ("medium", 500), ("common", 5000)):
        eligible = [term for term, count in counts.items() if count > 0 and term not in {item[1] for item in selected}]
        if eligible:
            term = min(eligible, key=lambda item: (abs(counts[item] - target), item))
            selected.append((label, term))
    return selected


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("output database already exists")

    source = sqlite3.connect(f"file:{args.source.as_posix()}?mode=ro", uri=True)
    destination = sqlite3.connect(args.output)
    with destination:
        source.backup(destination, pages=256)
    source.close()
    destination.close()

    apsw.bestpractice.apply(apsw.bestpractice.recommended)
    db = apsw.Connection(str(args.output))
    baseline_bytes = args.output.stat().st_size
    auto_vacuum = db.execute("PRAGMA auto_vacuum").fetchone()[0]
    rows = list(db.execute("SELECT asset_id, path FROM assets ORDER BY asset_id"))
    names = [path.replace("/", "\\").rsplit("\\", 1)[-1] for _, path in rows]
    paths = [path for _, path in rows]
    lowered_names = [name.lower() for name in names]
    lowered_paths = [path.lower() for path in paths]
    # Materialize basename without an index in TEMP storage. This gives the SQLite scan a fair
    # comparison without charging it for repeatedly extracting a name from the path.
    db.execute("CREATE TEMP TABLE file_names(asset_id INTEGER PRIMARY KEY, basename TEXT NOT NULL)")
    with db:
        db.executemany("INSERT INTO file_names(asset_id, basename) VALUES (?, ?)", ((asset_id, name) for (asset_id, _), name in zip(rows, names)))

    started = time.perf_counter()
    db.execute("CREATE VIRTUAL TABLE file_fts USING fts5(basename, path, tokenize='trigram', detail='none')")
    with db:
        db.executemany("INSERT INTO file_fts(rowid, basename, path) VALUES (?, ?, ?)", ((asset_id, name, path) for (asset_id, path), name in zip(rows, names)))
    db.wal_checkpoint(mode=apsw.SQLITE_CHECKPOINT_TRUNCATE)
    build_seconds = time.perf_counter() - started
    indexed_bytes = args.output.stat().st_size

    results: list[dict[str, object]] = []
    for field, values in (("basename", lowered_names), ("path", lowered_paths)):
        for length in (1, 2, 3, 5, 8):
            for frequency, term in choose_terms(values, length, 20260924 + length + (0 if field == "basename" else 100)):
                pattern = f"%{term}%"
                # The current catalog has no basename column. file_names models adding one
                # without adding a B-tree index, so this is a clean linear-scan baseline.
                scan_sql = (
                    "SELECT count(*) FROM file_names WHERE basename LIKE ?"
                    if field == "basename"
                    else "SELECT count(*) FROM assets WHERE path LIKE ?"
                )
                fts_sql = f"SELECT count(*) FROM file_fts WHERE {field} LIKE ?"
                scan_page_sql = scan_sql.replace("SELECT count(*)", "SELECT asset_id") + " LIMIT 100"
                fts_page_sql = f"SELECT rowid FROM file_fts WHERE {field} LIKE ? LIMIT 100"
                results.append({
                    "field": field,
                    "term_chars": length,
                    "frequency": frequency,
                    "scan": measure(db, scan_sql, pattern),
                    "fts": measure(db, fts_sql, pattern),
                    "scan_page": measure_page(db, scan_page_sql, pattern),
                    "fts_page": measure_page(db, fts_page_sql, pattern),
                })

    common_segments = collections.Counter(
        segment.lower()
        for path in paths
        for segment in path.replace("/", "\\").split("\\")[:-1]
        if len(segment) >= 5 and segment.isascii() and segment.isalpha()
    )
    common_segment = common_segments.most_common(1)[0][0]
    common_pattern = f"%{common_segment}%"
    common_path = {
        "scan": measure(db, "SELECT count(*) FROM assets WHERE path LIKE ?", common_pattern),
        "fts": measure(db, "SELECT count(*) FROM file_fts WHERE path LIKE ?", common_pattern),
        "scan_page": measure_page(db, "SELECT asset_id FROM assets WHERE path LIKE ? LIMIT 100", common_pattern),
        "fts_page": measure_page(db, "SELECT rowid FROM file_fts WHERE path LIKE ? LIMIT 100", common_pattern),
    }

    fts_bytes = db.execute("SELECT sum(pgsize) FROM dbstat WHERE name LIKE 'file_fts%'").fetchone()[0]

    print(json.dumps({
        "sqlite_version": apsw.sqlitelibversion(),
        "assets": len(rows),
        "baseline_bytes": baseline_bytes,
        "auto_vacuum": auto_vacuum,
        "indexed_bytes": indexed_bytes,
        "index_growth_bytes": indexed_bytes - baseline_bytes,
        "fts_pages_bytes": fts_bytes,
        "build_seconds": round(build_seconds, 3),
        "common_path_segment": common_path,
        "results": results,
    }, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # SQLite and Python exceptions can contain source paths or query text.
        print(f"benchmark failed: {type(error).__name__}", file=sys.stderr)
        raise SystemExit(1) from None
