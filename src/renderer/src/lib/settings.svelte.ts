import { derived, writable, type Readable, type Writable } from "svelte/store";

import type { Timeline } from "../../../shared/backend";
import type { LayoutOptions } from "./gallery/options";
import type { DividerGranularity, LayoutMode } from "./gallery/types";

import { SETTINGS_STORAGE_KEY } from "./constants";
import { rootKey } from "./library-root";

export type GalleryTheme = "seven-a" | "seven-b";

/**
 * User preferences for how the gallery is arranged and grouped. Persisted to localStorage and
 * exposed as a classic Svelte store (`settings`), matching the rest of the app's store-based
 * settings convention.
 *
 * Parameters the layout engine needs but that aren't a preference the user chose and expects
 * remembered — `imagePoolSize`, layout padding — live outside this interface; see
 * `galleryLayoutState` and `gallery/options.ts` below.
 */
export interface GallerySettings {
  /** Visual treatment for the compact Win32 gallery chrome. */
  theme: GalleryTheme;
  /** Which timestamp field drives ordering and date-header grouping: file mtime or EXIF capture time. */
  sortField: Timeline;
  /** Whether date headers form no groups, per-day groups, or per-month groups. */
  dateHeaders: DividerGranularity;
  /** Which packing algorithm the gallery uses. */
  layoutMode: LayoutMode;
  /** Justified: height rows aim for before justification stretches/shrinks them. */
  targetRowHeight: number;
  /** Masonry: target column width; the real width is snapped to fill the viewport evenly. */
  masonryColumnWidth: number;
  /** Grid: 0 means "derive the column count from gridCellWidth", otherwise a fixed count. */
  gridColumns: number;
  /** Grid: target cell width used when gridColumns is 0. */
  gridCellWidth: number;
  /** Grid: cell width / cell height. 1 is square. */
  gridCellAspectRatio: number;
  /** Space between tiles, in pixels. */
  gap: number;
  /** Whether eligible animated GIF/video tiles are allowed to play in the grid. Combined at
   * runtime with the OS `prefers-reduced-motion` setting, which always wins when set — this
   * only controls the case where the OS has no motion preference expressed. */
  playAnimatedPreviews: boolean;
  /** Development-only cap for each indexing phase. Zero indexes the complete library. */
  debugIndexLimit: number;
  /** Per-root search types from before the backend owned libraries. Read only by the one-time
   * v2 import; the backend stores each library's `ocr`/`image` choice now. */
  libraryIndexing: Record<string, { ocr: boolean; image: boolean }>;
  /** Search types a newly created library starts with. */
  indexOcr: boolean;
  indexImage: boolean;
  /** Include video frames in image search indexing. Videos remain in the catalog. */
  indexVideos: boolean;
  /** Whether the left libraries pane is shown. */
  librariesPaneOpen: boolean;
}

const defaults: GallerySettings = {
  theme: "seven-a",
  sortField: "modified",
  dateHeaders: "day",
  layoutMode: "justified",
  targetRowHeight: 148,
  masonryColumnWidth: 200,
  gridColumns: 0,
  gridCellWidth: 160,
  gridCellAspectRatio: 1,
  gap: 10,
  playAnimatedPreviews: true,
  debugIndexLimit: 0,
  libraryIndexing: {},
  indexOcr: false,
  indexImage: true,
  indexVideos: true,
  librariesPaneOpen: false,
};

export const settingsDefaults: Readonly<GallerySettings> = defaults;

/** Bounds for the numeric knobs, shared by the settings UI and the load-time sanitizer. */
export const settingsLimits = {
  targetRowHeight: { min: 60, max: 400, step: 4 },
  masonryColumnWidth: { min: 80, max: 480, step: 10 },
  gridColumns: { min: 0, max: 24, step: 1 },
  gridCellWidth: { min: 60, max: 400, step: 10 },
  gap: { min: 0, max: 40, step: 1 },
  debugIndexLimit: { min: 0, max: Number.MAX_SAFE_INTEGER, step: 1 },
} as const satisfies Record<string, { min: number; max: number; step: number }>;

function clampNumbers(value: GallerySettings): GallerySettings {
  const result = { ...value };
  for (const [key, limit] of Object.entries(settingsLimits) as [
    keyof typeof settingsLimits,
    { min: number; max: number },
  ][]) {
    const current = Number(result[key]);
    const bounded = Number.isFinite(current)
      ? Math.min(limit.max, Math.max(limit.min, current))
      : defaults[key];
    result[key] = key === "debugIndexLimit" ? Math.floor(bounded) : bounded;
  }
  return result;
}

// Derived from `defaults` rather than hand-written: `defaults` is checked against the
// `GallerySettings` type (excess/missing properties are compile errors), so this list can never
// drift out of sync with the interface — add a field to `GallerySettings` and `defaults` must
// grow to match, which automatically extends the allowlist too.
const knownSettingsKeys = Object.keys(defaults) as (keyof GallerySettings)[];

/**
 * Keeps only keys that are still part of `GallerySettings`, dropping anything else (retired
 * fields like the old `timeline`/`padding`/`imagePoolSize`, or garbage from hand-edited storage)
 * so it never gets spread back into the live settings object or re-persisted.
 */
function pickKnownSettings(parsed: unknown): Partial<GallerySettings> {
  const result: Partial<GallerySettings> = {};
  if (typeof parsed !== "object" || parsed === null) return result;
  const source = parsed as Record<string, unknown>;
  for (const key of knownSettingsKeys) {
    if (key in source) {
      result[key] = source[key] as never;
    }
  }
  return result;
}

function loadInitial(): GallerySettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return defaults;
    // v1 persisted the sort field under the old, ambiguous `timeline` key and had no notion of
    // sort direction (it was ascending, unintentionally) — migrate the field name forward and let
    // the caller apply today's always-descending order regardless of what's on disk. `timeline` is
    // read here, straight off the parsed JSON, before it's dropped as an unknown key below.
    const parsed = JSON.parse(raw) as Partial<GallerySettings> & {
      timeline?: Timeline;
      showDateDividers?: boolean;
      dividerGranularity?: DividerGranularity;
    };
    const sortField: Timeline =
      parsed.sortField === "capture" || parsed.sortField === "modified"
        ? parsed.sortField
        : parsed.timeline === "capture"
          ? "capture"
          : "modified";
    const theme: GalleryTheme = parsed.theme === "seven-b" ? "seven-b" : "seven-a";
    // Older releases modeled date headers as a checkbox plus an independent granularity. Fold
    // that dependent pair into the one explicit outcome before unknown legacy keys are removed.
    const dateHeaders: DividerGranularity =
      parsed.dateHeaders === "none" ||
      parsed.dateHeaders === "day" ||
      parsed.dateHeaders === "month"
        ? parsed.dateHeaders
        : parsed.showDateDividers === false
          ? "none"
          : parsed.dividerGranularity === "month"
            ? "month"
            : "day";
    return clampNumbers({
      ...defaults,
      ...pickKnownSettings(parsed),
      sortField,
      theme,
      dateHeaders,
      libraryIndexing: Object.fromEntries(
        Object.entries(parsed.libraryIndexing ?? {}).filter(
          ([, value]) =>
            value && typeof value.ocr === "boolean" && typeof value.image === "boolean",
        ),
      ),
      indexOcr: typeof parsed.indexOcr === "boolean" ? parsed.indexOcr : true,
      indexImage: typeof parsed.indexImage === "boolean" ? parsed.indexImage : true,
      indexVideos: typeof parsed.indexVideos === "boolean" ? parsed.indexVideos : true,
      librariesPaneOpen:
        typeof parsed.librariesPaneOpen === "boolean" ? parsed.librariesPaneOpen : false,
    });
  } catch {
    return defaults;
  }
}

function createSettingsStore(): Writable<GallerySettings> {
  const store = writable<GallerySettings>(loadInitial());
  store.subscribe((value) => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(value));
    } catch {
      // Best-effort persistence only; ignore storage failures (e.g. quota, private mode).
    }
  });
  return store;
}

export const settings = createSettingsStore();

/** The search types a v2 root used, for its one-time import into a backend library. */
export function libraryIndexing(
  value: GallerySettings,
  root: string,
): { ocr: boolean; image: boolean } {
  return value.libraryIndexing[rootKey(root)] ?? { ocr: value.indexOcr, image: value.indexImage };
}

/** Maps the user-facing knobs onto the layout engine's options. */
export function toLayoutOptions(value: GallerySettings): LayoutOptions {
  return {
    mode: value.layoutMode,
    gap: value.gap,
    granularity: value.dateHeaders,
    targetRowHeight: value.targetRowHeight,
    columnWidth: value.masonryColumnWidth,
    columns: value.gridColumns,
    cellWidth: value.gridCellWidth,
    cellAspectRatio: value.gridCellAspectRatio,
  };
}

let previousLayoutOptions: LayoutOptions | undefined;
export const layoutOptions: Readable<LayoutOptions> = derived(settings, (value, set) => {
  const next = toLayoutOptions(value);
  if (
    previousLayoutOptions &&
    Object.entries(next).every(
      ([key, value]) => previousLayoutOptions![key as keyof LayoutOptions] === value,
    )
  )
    return;
  previousLayoutOptions = next;
  set(next);
});

/**
 * Transient gallery-layout parameters: derived from the runtime environment rather than chosen
 * by the user, so they live in `$state` instead of the persisted `settings` store.
 */
class GalleryLayoutState {
  /**
   * Number of `<img>` elements the virtualizer keeps pooled and recycles. Not user-configurable
   * (there is no undo for "I set this too high and now the app is slow") — sized once from a
   * rough device-capability heuristic so low-end machines don't pay for thousands of live
   * elements while capable ones get smoother fast-scroll recycling.
   */
  imagePoolSize = $state(autoImagePoolSize());
}

export const galleryLayoutState = new GalleryLayoutState();

function autoImagePoolSize(): number {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const cores = nav?.hardwareConcurrency || 4;
  const memoryGb = (nav as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory || 4;
  // Rough device-capability score; a 4-core/4GB machine (score 16) lands near the old UI slider's
  // low end, a 16-core/8GB+ machine (score 128+) climbs toward its high end.
  const score = cores * memoryGb;
  return Math.round(Math.min(2000, Math.max(120, 160 + score * 8)));
}
