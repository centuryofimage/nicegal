"""Audit or trim the two guide screenshots to their existing solid border.

uvx --with pillow python scripts/guide-image-borders.py --audit
uvx --with pillow python scripts/guide-image-borders.py --trim
"""

import argparse
from collections import Counter
from pathlib import Path

from PIL import Image


def colors(image: Image.Image, box: tuple[int, int, int, int]) -> Counter:
    return Counter(image.crop(box).get_flattened_data())


def trim_border(image: Image.Image) -> Image.Image:
    width, height = image.size
    # The solid border is the darkest nearly uniform row within each outer ten pixels.
    def horizontal(rows: range) -> tuple[int, tuple[int, int, int]]:
        candidates = []
        for y in rows:
            color, count = colors(image, (0, y, width, y + 1)).most_common(1)[0]
            if count / width >= 0.9:
                candidates.append((sum(color), y, color))
        assert candidates, "No solid horizontal border found; inspect the capture."
        _, y, color = min(candidates)
        return y, color

    top, top_border = horizontal(range(10))
    bottom, bottom_border = horizontal(range(height - 10, height))

    def vertical(columns: range) -> tuple[int, tuple[int, int, int]]:
        candidates = []
        for x in columns:
            color, count = colors(image, (x, 0, x + 1, height)).most_common(1)[0]
            if count / height >= 0.9:
                candidates.append((sum(color), x, color))
        assert candidates, "No solid vertical border found; inspect the capture."
        _, x, color = min(candidates)
        return x, color

    left, left_border = vertical(range(10))
    right, right_border = vertical(range(width - 1, width - 11, -1))
    cropped = image.crop((left, top, right + 1, bottom + 1))
    w, h = cropped.size
    for edge, border, length in [
        ((0, 0, w, 1), top_border, w),
        ((0, h - 1, w, h), bottom_border, w),
        ((0, 0, 1, h), left_border, h),
        ((w - 1, 0, w, h), right_border, h),
    ]:
        assert colors(cropped, edge)[border] / length >= 0.95, "Crop does not have four complete borders."
    return cropped


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--audit", action="store_true", help="Print colors for the top and bottom ten rows")
parser.add_argument("--trim", action="store_true", help="Crop away pixels outside the existing border")
args = parser.parse_args()
folder = Path(__file__).resolve().parents[1] / "src/renderer/src/assets/guide"
for name in ("search-menu.png", "visual-search.png"):
    path = folder / name
    with Image.open(path) as source:
        image = source.convert("RGB")
    if args.trim:
        cropped = trim_border(image)
        cropped.save(path)
        print(f"{name}: {image.size} -> {cropped.size}; all four borders verified")
        image = cropped
    if args.audit or not args.trim:
        print(f"\n{name}: {image.size}")
        for y in [*range(10), *range(image.height - 10, image.height)]:
            print(f"row {y}: {colors(image, (0, y, image.width, y + 1)).most_common(5)}")
