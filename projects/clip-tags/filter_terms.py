"""Loose junk flags for every label. Nothing is dropped; each row gets a reason or none.

Labels come from MetaCLIP's metadata list, plus concrete WordNet nouns MetaCLIP lacks.
A label in a concrete WordNet category (animal, food, artifact, ...) is kept however rare it is.

Writes data/terms.parquet:
  term       label text
  source     "metaclip" or "wordnet"
  zipf       English word frequency, 0 to ~8
  wordnet    concrete WordNet category, or null
  junk       reason the label is filtered, or null
  canonical  the kept spelling for case and possessive duplicates
"""

import json
import re
import sys
from pathlib import Path

import nltk
import pyarrow as pa
import pyarrow.parquet as pq
from wordfreq import zipf_frequency

DATA = Path(__file__).parent / "data"
nltk.data.path.insert(0, str(DATA / "nltk"))
from nltk.corpus import wordnet as wn  # noqa: E402

# Lowest-frequency tag we want to keep without WordNet's help is "vaporwave" at 2.06.
MIN_ZIPF = 2.0

YEAR = re.compile(r"\b(1[5-9]|20)\d\d\b(?!s)")  # 1995, 2020–21; not decades like 1990s
PAREN = re.compile(r"\(.*\)")

# Concrete categories, most specific first. Instance hyponyms (named individuals) are excluded.
ROOTS = {
    "animal": ["animal.n.01"],
    "plant": ["plant.n.02"],
    "food": ["food.n.01", "food.n.02"],
    "body_part": ["body_part.n.01"],
    "landform": ["geological_formation.n.01"],
    "natural_object": ["natural_object.n.01"],
    "person": ["person.n.01"],
    "artifact": ["artifact.n.01"],
}


def category_index() -> dict[str, str]:
    """Map every synset under a concrete root to its category."""
    index: dict[str, str] = {}
    for category, roots in ROOTS.items():
        for root in map(wn.synset, roots):
            for s in [root, *root.closure(lambda s: s.hyponyms())]:
                index.setdefault(s.name(), category)
    return index


def key(term: str) -> str:
    return term.strip().lower().removesuffix("'s")


def wordnet_category(term: str, index: dict[str, str]) -> str | None:
    for s in wn.synsets(key(term).replace(" ", "_"), pos="n"):
        if s.name() in index:
            return index[s.name()]
    return None


def junk_reason(term: str, zipf: float, category: str | None) -> str | None:
    if term.startswith(("List of", "Lists of")) or PAREN.search(term) or YEAR.search(term):
        return "title"
    if len(term.split()) >= 3 and (term[:1].isupper() or term[:1].isdigit()):
        return "title"
    if category:
        return None
    if len(term.strip()) <= 2:
        return "short"
    if zipf < MIN_ZIPF:
        return "rare"
    return None


def main() -> None:
    index = category_index()
    metaclip: list[str] = json.loads((DATA / "metaclip1_metadata.json").read_text("utf-8"))
    seen = {key(t) for t in metaclip}
    extra = sorted({
        lemma.name().replace("_", " ")
        for name in index
        for lemma in wn.synset(name).lemmas()
    }, key=str.lower)
    extra = [t for t in extra if key(t) not in seen and not seen.add(key(t))]

    terms = metaclip + extra
    source = ["metaclip"] * len(metaclip) + ["wordnet"] * len(extra)
    zipf = [zipf_frequency(t, "en") for t in terms]
    category = [wordnet_category(t, index) for t in terms]
    junk = [junk_reason(t, z, c) for t, z, c in zip(terms, zipf, category)]

    # Case and possessive variants share one canonical row: the most frequent kept spelling.
    groups: dict[str, list[int]] = {}
    for i, t in enumerate(terms):
        groups.setdefault(key(t), []).append(i)
    canonical = list(terms)
    for members in groups.values():
        if len(members) == 1:
            continue
        best = max(members, key=lambda i: (junk[i] is None, not terms[i].endswith("'s"),
                                           terms[i].islower(), zipf[i]))
        for i in members:
            canonical[i] = terms[best]
            if i != best and junk[i] is None:
                junk[i] = "duplicate"

    pq.write_table(pa.table({
        "term": terms, "source": source, "zipf": zipf, "wordnet": category,
        "junk": junk, "canonical": canonical,
    }), DATA / "terms.parquet")

    kept = [i for i, j in enumerate(junk) if j is None]
    print(f"{len(terms):,} labels ({len(metaclip):,} metaclip, {len(extra):,} wordnet), "
          f"{len(kept):,} kept")
    for reason in ("rare", "title", "short", "duplicate"):
        print(f"  {reason}: {junk.count(reason):,}")
    rescued = sum(1 for i in kept if source[i] == "metaclip" and zipf[i] < MIN_ZIPF)
    print(f"  metaclip labels kept below the floor by WordNet: {rescued:,}")
    by_cat: dict[str, int] = {}
    for i in kept:
        if category[i]:
            by_cat[category[i]] = by_cat.get(category[i], 0) + 1
    print("  kept by WordNet category:", ", ".join(f"{k} {v:,}" for k, v in by_cat.items()))

    if "--labeled" in sys.argv:
        from laya_eval import LABELED

        for t, good in LABELED.items():
            c = wordnet_category(t, index)
            r = junk_reason(t, zipf_frequency(t, "en"), c)
            if (r is None) != good:
                print(f"miss {'Y' if good else 'n'} {r or '-':6} {c or '-':10} {t}")


if __name__ == "__main__":
    main()
