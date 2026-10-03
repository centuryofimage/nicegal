export interface Point {
  x: number;
  y: number;
}

/** Two fingers reduced to the span between them and the point halfway. */
export interface Pinch {
  distance: number;
  mid: Point;
}

export const SWIPE_MIN_PX = 50;

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pinchOf(a: Point, b: Point): Pinch {
  return { distance: distance(a, b), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

/** What moving from one pinch to the next asks of the view: scale by `ratio` around the new
 * midpoint, then translate by `pan` so the content follows the fingers. */
export function pinchStep(prev: Pinch, next: Pinch): { ratio: number; pan: Point } {
  return {
    ratio: prev.distance > 0 ? next.distance / prev.distance : 1,
    pan: { x: next.mid.x - prev.mid.x, y: next.mid.y - prev.mid.y },
  };
}

/** Manhattan travel, the measure the long-press slop is judged by. */
export function travel(from: Point, to: Point): number {
  return Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
}

/** A swipe is a mostly horizontal drag of at least `SWIPE_MIN_PX`. Swiping left steps forward. */
export function swipeDirection(dx: number, dy: number): "next" | "prev" | null {
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < 2 * Math.abs(dy)) return null;
  return dx < 0 ? "next" : "prev";
}
