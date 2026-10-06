import type { ResolvedLayoutOptions } from "./options";
import type { GalleryPosition } from "./types";

import { aspectBounds, clampAspectRatio } from "./clamp";
import { createDividerTracker } from "./dividers";
import { emptyLayout, type GalleryItem, type GalleryLayout, type GalleryLayoutRow } from "./types";

/** The most a narrow row's target may grow. */
const NARROW_ROW_MAX_SCALE = 1.3;

/**
 * Flickr-style justified rows: fill a row with clamped aspect ratios until it overflows the
 * content width, then solve for the height that makes it fit exactly.
 */
export function buildJustifiedLayout(
  items: GalleryItem[],
  viewportWidth: number,
  options: ResolvedLayoutOptions,
): GalleryLayout {
  if (!viewportWidth || !items.length) return emptyLayout("justified");

  const { gap, padding, targetRowHeight, maxRowHeight, narrowRowGrowth, granularity, clamp } =
    options;
  /** The height a row of `count` tiles with these clamped aspect ratios aims for. Rows with a
   * mean aspect ratio of 1 or more keep the target. */
  const rowTarget = (count: number, totalAspectRatio: number): number => {
    const mean = totalAspectRatio / count;
    if (mean >= 1) return targetRowHeight;
    return targetRowHeight * Math.min(NARROW_ROW_MAX_SCALE, mean ** -narrowRowGrowth);
  };
  const rowWidth = Math.max(1, viewportWidth - padding * 2);
  // Tiles are drawn at a fixed height, so the panorama guard becomes a width cap. On a narrow
  // viewport one wide tile would otherwise fill most of a row and shrink the rest of it.
  const bounds = aspectBounds(
    { ...clamp, maxDisplayWidth: Math.min(clamp.maxDisplayWidth, rowWidth / 2) },
    { referenceHeight: targetRowHeight },
  );
  const tracker = createDividerTracker(items, granularity);
  const rows: GalleryLayoutRow[] = [];
  const positions: GalleryPosition[] = [];
  let index = 0;
  let y = padding;

  while (index < items.length) {
    const start = index;
    if (tracker.opensBucket(start)) y = tracker.open(start, y, gap);
    const startBucket = tracker.keyAt(start);

    let totalAspectRatio = 0;
    while (index < items.length) {
      if (tracker.enabled && tracker.keyAt(index) !== startBucket) break;
      const aspectRatio = clampAspectRatio(items[index].aspectRatio, bounds);
      totalAspectRatio += aspectRatio;
      index += 1;
      const count = index - start;
      const gaps = (count - 1) * gap;
      const target = rowTarget(count, totalAspectRatio);
      if (totalAspectRatio * target + gaps < rowWidth) continue;
      // The last item overflowed the row. On a narrow viewport one item is a large share of the
      // row, so keeping it can shrink the row far below the target. Leave it for the next row
      // when the row without it is closer to its target, by ratio, and still under its ceiling.
      if (count > 1) {
        const withoutAspectRatio = totalAspectRatio - aspectRatio;
        const withoutTarget = rowTarget(count - 1, withoutAspectRatio);
        const withoutHeight = (rowWidth - gaps + gap) / withoutAspectRatio;
        const withHeight = (rowWidth - gaps) / totalAspectRatio;
        if (
          withoutHeight <= maxRowHeight * (withoutTarget / targetRowHeight) &&
          withoutHeight / withoutTarget < target / withHeight
        ) {
          totalAspectRatio = withoutAspectRatio;
          index -= 1;
        }
      }
      break;
    }

    const count = index - start;
    const target = rowTarget(count, totalAspectRatio);
    const isLastRowOfGroup =
      index === items.length || (tracker.enabled && tracker.keyAt(index) !== startBucket);
    // Edge rows can have too little content to justify naturally. Cap their height instead
    // of making a lone wide or tall image fill the entire gallery width.
    const naturalHeight = Math.max(
      clamp.minDisplayHeight,
      (rowWidth - (count - 1) * gap) / totalAspectRatio,
    );
    const height = isLastRowOfGroup
      ? Math.min(target, naturalHeight)
      : Math.min(maxRowHeight * (target / targetRowHeight), naturalHeight);

    let x = padding;
    for (let itemIndex = start; itemIndex < index; itemIndex += 1) {
      const width = clampAspectRatio(items[itemIndex].aspectRatio, bounds) * height;
      positions.push({ index: itemIndex, x, y, width, height });
      x += width + gap;
    }
    rows.push({ start, end: index, y, height });
    y += height + gap;
  }

  return {
    mode: "justified",
    positions,
    rows,
    columns: [],
    dividers: tracker.dividers,
    unitHeight: targetRowHeight + gap,
    height: y - gap + padding,
  };
}
