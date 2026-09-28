import type { ResolvedLayoutOptions } from "./options";

import { aspectBounds, clampAspectRatio } from "./clamp";
import { createDividerTracker } from "./dividers";
import {
  emptyLayout,
  type GalleryItem,
  type GalleryLayout,
  type GalleryLayoutColumn,
  type GalleryPosition,
} from "./types";

/**
 * Fixed-width columns; each item lands in whichever column is currently shortest. Columns are
 * flushed to a common baseline at a date-bucket boundary so a divider never has tiles beside it.
 *
 * The returned per-column index (`tops`/`bottoms`, both ascending) is what the virtualizer scans
 * instead of row bands — masonry has no rows to binary-search.
 */
export function buildMasonryLayout(
  items: GalleryItem[],
  viewportWidth: number,
  options: ResolvedLayoutOptions,
): GalleryLayout {
  if (!viewportWidth || !items.length) return emptyLayout("masonry");

  const { gap, padding, columnWidth, granularity, clamp, fillRows } = options;
  const contentWidth = Math.max(1, viewportWidth - padding * 2);
  const fit = (contentWidth + gap) / (Math.max(1, columnWidth) + gap);
  const columnCount = Math.max(1, fillRows ? Math.round(fit) : Math.floor(fit));
  // Filling snaps to a width that spans the viewport exactly; the setting is then a target.
  const width = fillRows
    ? (contentWidth - (columnCount - 1) * gap) / columnCount
    : Math.min(contentWidth, Math.max(1, columnWidth));
  const left =
    padding + (fillRows ? 0 : (contentWidth - columnCount * width - (columnCount - 1) * gap) / 2);
  // Tiles are drawn at a fixed width, so the "tame the panorama" guard is a minimum height.
  const bounds = aspectBounds(clamp, { referenceWidth: width });
  const tracker = createDividerTracker(items, granularity);
  const positions: GalleryPosition[] = [];
  const columns: GalleryLayoutColumn[] = Array.from({ length: columnCount }, () => ({
    indices: [],
    tops: [],
    bottoms: [],
  }));
  /** Next free y in each column, gap included. */
  const cursors = new Array<number>(columnCount).fill(padding);
  let placed = 0;
  let heightSum = 0;

  for (let index = 0; index < items.length; index += 1) {
    if (tracker.opensBucket(index)) {
      const bottom = Math.max(...cursors) - (placed ? gap : 0);
      cursors.fill(tracker.open(index, bottom, gap));
    }

    let column = 0;
    for (let candidate = 1; candidate < columnCount; candidate += 1) {
      if (cursors[candidate] < cursors[column]) column = candidate;
    }

    const height = width / clampAspectRatio(items[index].aspectRatio, bounds);
    const x = left + column * (width + gap);
    const y = cursors[column];
    positions.push({ index, x, y, width, height });
    columns[column].indices.push(index);
    columns[column].tops.push(y);
    columns[column].bottoms.push(y + height);
    cursors[column] = y + height + gap;
    heightSum += height;
    placed += 1;
  }

  return {
    mode: "masonry",
    positions,
    rows: [],
    columns,
    dividers: tracker.dividers,
    unitHeight: heightSum / placed + gap,
    height: Math.max(...cursors) - gap + padding,
  };
}
