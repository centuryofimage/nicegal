import type { ResolvedLayoutOptions } from "./options";

import { createDividerTracker } from "./dividers";
import {
  emptyLayout,
  type GalleryItem,
  type GalleryLayout,
  type GalleryLayoutRow,
  type GalleryPosition,
} from "./types";

/**
 * Uniform cells in a fixed column count. Every tile is packed to the same box regardless of its
 * true ratio — the renderer crops with `object-fit: cover` — so this mode's aspect clamp *is* the
 * cell ratio. The column count is either pinned by the caller or derived from a target cell width.
 */
export function buildGridLayout(
  items: GalleryItem[],
  viewportWidth: number,
  options: ResolvedLayoutOptions,
): GalleryLayout {
  if (!viewportWidth || !items.length) return emptyLayout("grid");

  const { gap, padding, columns, cellWidth, cellAspectRatio, granularity, clamp, fillRows } =
    options;
  const contentWidth = Math.max(1, viewportWidth - padding * 2);
  const columnCount =
    columns > 0
      ? columns
      : Math.max(1, Math.floor((contentWidth + gap) / (Math.max(1, cellWidth) + gap)));
  const exact = !fillRows && columns === 0;
  const width = exact
    ? Math.min(contentWidth, Math.max(1, cellWidth))
    : Math.max(1, (contentWidth - (columnCount - 1) * gap) / columnCount);
  const left =
    padding + (exact ? (contentWidth - columnCount * width - (columnCount - 1) * gap) / 2 : 0);
  const height = Math.max(clamp.minDisplayHeight, width / Math.max(0.05, cellAspectRatio));
  const tracker = createDividerTracker(items, granularity);
  const positions: GalleryPosition[] = [];
  const rows: GalleryLayoutRow[] = [];
  let index = 0;
  let y = padding;

  while (index < items.length) {
    const start = index;
    if (tracker.opensBucket(start)) y = tracker.open(start, y, gap);
    const startBucket = tracker.keyAt(start);

    let column = 0;
    while (index < items.length && column < columnCount) {
      if (tracker.enabled && tracker.keyAt(index) !== startBucket) break;
      positions.push({ index, x: left + column * (width + gap), y, width, height });
      index += 1;
      column += 1;
    }

    rows.push({ start, end: index, y, height });
    y += height + gap;
  }

  return {
    mode: "grid",
    positions,
    rows,
    columns: [],
    dividers: tracker.dividers,
    unitHeight: height + gap,
    height: y - gap + padding,
  };
}
