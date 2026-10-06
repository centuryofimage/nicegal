import type { DividerGranularity, LayoutMode } from "./types";

import { modeClamps, type DisplayClamp } from "./clamp";

/** Every knob the layout engine understands. Callers pass a partial; packers get the resolved form. */
export interface LayoutOptions {
  mode?: LayoutMode;
  gap?: number;
  padding?: number;
  /** When 'day' or 'month', a tile band never spans a bucket boundary. */
  granularity?: DividerGranularity;
  /** Justified: the height rows aim for before justification stretches or shrinks them. */
  targetRowHeight?: number;
  /** Justified: hard ceiling for a justified row. Defaults to 1.4x the target. */
  maxRowHeight?: number;
  /**
   * Justified: a row of narrow tiles grows by its mean aspect ratio to the power of minus this, so
   * tall images are not drawn at half the area of square ones. 0 keeps every row at the target.
   */
  narrowRowGrowth?: number;
  /** Masonry: target column width. The real width is snapped so columns fill the viewport. */
  columnWidth?: number;
  /** Grid: fixed column count. 0 derives the count from `cellWidth` instead. */
  columns?: number;
  /** Grid: target cell width, used when `columns` is 0. */
  cellWidth?: number;
  /** Grid: cell width / cell height. */
  cellAspectRatio?: number;
  /**
   * Grid and masonry: stretch the derived column count to fill the width, so the size setting is
   * a target. Off, tiles keep the exact size and the leftover width is centred, which lets a pinch
   * grow tiles continuously instead of stepping at each column count.
   */
  fillRows?: boolean;
  /** Overrides for the mode's display clamp. */
  clamp?: Partial<DisplayClamp>;
}

export type ResolvedLayoutOptions = Required<Omit<LayoutOptions, "clamp">> & {
  clamp: DisplayClamp;
};

export const layoutDefaults = {
  mode: "justified" as LayoutMode,
  gap: 10,
  padding: 14,
  granularity: "none" as DividerGranularity,
  targetRowHeight: 148,
  narrowRowGrowth: 0.5,
  columnWidth: 200,
  columns: 0,
  cellWidth: 160,
  cellAspectRatio: 1,
  fillRows: true,
};

export function resolveLayoutOptions(options: LayoutOptions = {}): ResolvedLayoutOptions {
  const merged = { ...layoutDefaults, ...stripUndefined(options) };
  return {
    ...merged,
    maxRowHeight: options.maxRowHeight ?? merged.targetRowHeight * 1.4,
    clamp: { ...modeClamps[merged.mode], ...stripUndefined(options.clamp ?? {}) },
  };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
