import type { GalleryLayout } from "./types";

import { visibleIndexRange } from "./visible-range";

/** A rectangle in gallery canvas coordinates, so it stays put while the viewport scrolls. */
export interface ContentRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Background presses that travel at most this far (Manhattan) are clicks and clear selection. */
export const CLICK_SLOP_PX = 4;
/** A background drag becomes a marquee only past this distance; shorter drags change nothing. */
export const MARQUEE_START_PX = 8;
/** Pointer distance inside the viewport edge where auto-scroll begins. */
export const AUTO_SCROLL_EDGE_PX = 16;
/** Auto-scroll speed in px/s per px of distance past the edge zone. */
const AUTO_SCROLL_GAIN = 12;
const AUTO_SCROLL_MAX_PX_PER_S = 4000;

export type PressTravel = "click" | "none" | "marquee";

export function classifyPressTravel(dx: number, dy: number): PressTravel {
  if (Math.abs(dx) + Math.abs(dy) <= CLICK_SLOP_PX) return "click";
  return Math.hypot(dx, dy) >= MARQUEE_START_PX ? "marquee" : "none";
}

export function rectFromPoints(
  a: { x: number; y: number },
  b: { x: number; y: number },
): ContentRect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

/** Ids of every laid-out item touching `rect`, in item order, whether or not it is rendered. */
export function marqueeHitIds(
  layout: GalleryLayout,
  items: readonly { id: string }[],
  rect: ContentRect,
): string[] {
  const { start, end } = visibleIndexRange(layout, rect.top, rect.bottom);
  const ids: string[] = [];
  for (let index = start; index < end; index += 1) {
    const position = layout.positions[index];
    const item = items[index];
    if (
      item &&
      position.x <= rect.right &&
      position.x + position.width >= rect.left &&
      position.y <= rect.bottom &&
      position.y + position.height >= rect.top
    )
      ids.push(item.id);
  }
  return ids;
}

/** Signed scroll velocity in px/s for a pointer at `y` against a viewport spanning `top..bottom`. */
export function autoScrollVelocity(y: number, top: number, bottom: number): number {
  const above = top + AUTO_SCROLL_EDGE_PX - y;
  const below = y - (bottom - AUTO_SCROLL_EDGE_PX);
  const distance = above > 0 ? -above : below > 0 ? below : 0;
  const speed = Math.min(AUTO_SCROLL_MAX_PX_PER_S, Math.abs(distance) * AUTO_SCROLL_GAIN);
  return Math.sign(distance) * speed;
}
