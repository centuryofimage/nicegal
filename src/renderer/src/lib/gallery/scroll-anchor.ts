import type { GalleryItem, GalleryLayout } from "./types";

import { firstVisibleIndex } from "./visible-range";

/** Scroll positions closer than this are the same position; browsers report fractional pixels. */
export const SCROLL_EPSILON_PX = 0.5;

/**
 * What sits under the top of the viewport, by id rather than index or pixel offset, so the same
 * content can be found again after any relayout: a mode switch, a size change, a resize, or a
 * filter that removes items above it.
 */
export type ScrollAnchor =
  | { kind: "top" }
  /** Inside a search section header, `offset` pixels below its top. */
  | { kind: "section"; key: string; offset: number }
  /** `progress` is how far down the item the viewport top is, from 0 to 1. */
  | { kind: "item"; id: string; progress: number };

/** The anchor for `scrollTop`, or undefined when the layout has nothing to anchor to. */
export function captureAnchor(
  layout: GalleryLayout,
  items: readonly GalleryItem[],
  scrollTop: number,
): ScrollAnchor | undefined {
  // Zero is a position in its own right, not the top of the first tile, which sits below the
  // padding and possibly a section header. Anchoring to the tile would scroll past the header.
  if (scrollTop <= SCROLL_EPSILON_PX) return { kind: "top" };
  const section = layout.dividers.find(
    (divider) => divider.key && divider.y <= scrollTop && scrollTop < divider.y + divider.height,
  );
  if (section?.key) return { kind: "section", key: section.key, offset: scrollTop - section.y };
  if (!layout.positions.length) return undefined;
  const index = firstVisibleIndex(layout, scrollTop);
  const position = layout.positions[index];
  const item = items[index];
  if (!position || !item) return undefined;
  return {
    kind: "item",
    id: item.id,
    progress: Math.min(1, (scrollTop - position.y) / position.height),
  };
}

/** Where `anchor` is in `layout`, or undefined when its section or item is no longer there. */
export function anchorScrollTop(
  layout: GalleryLayout,
  items: readonly GalleryItem[],
  anchor: ScrollAnchor | undefined,
): number | undefined {
  if (!anchor) return undefined;
  if (anchor.kind === "top") return 0;
  if (anchor.kind === "section") {
    const section = layout.dividers.find((divider) => divider.key === anchor.key);
    return section ? section.y + anchor.offset : undefined;
  }
  const index = items.findIndex((item) => item.id === anchor.id);
  const position = layout.positions[index];
  return position ? Math.max(0, position.y + position.height * anchor.progress) : undefined;
}
