export interface GalleryItem {
  id: string;
  path: string;
  displayName: string;
  /** File-system extension as written on disk, without its leading dot. */
  extension: string | null;
  modifiedNs: string;
  /** Source file creation time when the platform exposes one. */
  createdNs: string | null;
  captureNs: string | null;
  sourceSize: string;
  /** Renderer cache generation, advanced after a thumbnail-producing job completes. */
  thumbnailRevision: number;
  mediaKind: "image" | "video";
  mediaFormat: string;
  animated: boolean;
  frameCount: number | null;
  durationMs: number | null;
  /**
   * Source pixel dimensions, supplied by the indexer — never measured by loading the image.
   * When these come from a thumbnail rather than the original they may be rounded, which is
   * fine: layout only consumes the ratio.
   */
  width: number;
  height: number;
  /** Nullable dimensions exactly as stored by the catalog, retained for diagnostics. */
  sourceWidth: number | null;
  sourceHeight: number | null;
  /** `width / height`, precomputed. Layouts may clamp it; detail views must not. */
  aspectRatio: number;
  date: number;
}

/** Rounds a tile's physical edge up to a stored thumbnail size bucket. Stable URLs across small
 * layout changes let the browser retain the same decoded image while the window is resized. */
export function physicalThumbnailSize(
  renderedWidth: number,
  renderedHeight: number,
  devicePixelRatio: number,
): number {
  const physicalPixels = Math.max(renderedWidth, renderedHeight) * devicePixelRatio;
  if (physicalPixels <= 128) return 128;
  if (physicalPixels <= 256) return 256;
  if (physicalPixels <= 512) return 512;
  return 1024;
}

/** Builds a fingerprinted thumbnail URL sized for the tile's rendered physical-pixel edge. */
export function thumbnailUrlOf(
  item: GalleryItem,
  renderedWidth: number,
  renderedHeight: number,
  devicePixelRatio: number,
  sampleTimestampMs?: number,
): string {
  const physicalPixels = physicalThumbnailSize(renderedWidth, renderedHeight, devicePixelRatio);
  const query = new URLSearchParams({
    size: String(physicalPixels),
    v: "3",
    mtime: item.modifiedNs,
    bytes: item.sourceSize,
    refresh: String(item.thumbnailRevision),
  });
  if (item.mediaKind === "video" && sampleTimestampMs !== undefined)
    query.set("frame", String(sampleTimestampMs));
  return `thumb://asset/${encodeURIComponent(item.id)}?${query}`;
}

/**
 * Builds the restricted original-media URL for an item — full animated GIF bytes or a video
 * source, never a resized/re-encoded copy. Only used for eligible, promoted grid tiles and the
 * detail view; ordinary static-image tiles never request this.
 */
export function originalUrlOf(item: GalleryItem): string {
  const query = new URLSearchParams({ mtime: item.modifiedNs, bytes: item.sourceSize });
  return `original://asset/${encodeURIComponent(item.id)}?${query}`;
}

/** Derives the layout ratio from indexer-supplied dimensions, tolerating missing/degenerate data. */
export function aspectRatioOf(width: number, height: number): number {
  return width > 0 && height > 0 ? width / height : 1;
}

export type DividerGranularity = "none" | "day" | "month";

export type LayoutMode = "justified" | "masonry" | "grid";

export interface GalleryPosition {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GalleryLayoutRow {
  start: number;
  end: number;
  y: number;
  height: number;
}

/**
 * Per-column Y index for masonry. Tiles in a column are appended top to bottom, so `tops`
 * and `bottoms` are both ascending and binary-searchable for a viewport band.
 */
export interface GalleryLayoutColumn {
  /** Item indices in this column, in placement order. */
  indices: number[];
  /** `tops[n]` / `bottoms[n]` bound the tile of `indices[n]`. */
  tops: number[];
  bottoms: number[];
}

export interface GalleryDivider {
  collapsed?: boolean;
  key?: string;
  status?: string;
  count?: number;
  itemIndex: number;
  y: number;
  height: number;
  label: string;
  timestamp: number;
}

/** Consecutive search results sharing one heading; empty/pending sections still have a heading. */
export interface GallerySection {
  collapsed?: boolean;
  key: string;
  label: string;
  start: number;
  count: number;
  status?: string;
}

export interface GalleryLayout {
  mode: LayoutMode;
  /** Positions are parallel to the item array: `positions[n]` belongs to `items[n]`. */
  positions: GalleryPosition[];
  /** Row bands, for row-packed modes. Empty for masonry, which indexes by column instead. */
  rows: GalleryLayoutRow[];
  /** Column indices, for masonry. Empty for row-packed modes. */
  columns: GalleryLayoutColumn[];
  dividers: GalleryDivider[];
  /** Typical tile pitch (tile height + gap). Converts row-counted overscan into pixels. */
  unitHeight: number;
  height: number;
}

export function emptyLayout(mode: LayoutMode = "justified"): GalleryLayout {
  return { mode, positions: [], rows: [], columns: [], dividers: [], unitHeight: 0, height: 0 };
}
