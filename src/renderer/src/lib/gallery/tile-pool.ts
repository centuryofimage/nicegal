import { segmentFilename, segmentSnippet, type SnippetSegment } from "./snippet-highlight";
import {
  originalUrlOf,
  thumbnailUrlOf,
  type GalleryItem,
  type GalleryLayout,
  type GalleryPosition,
} from "./types";

const EMPTY_SNIPPET_TERMS: readonly string[] = [];

export type { SnippetSegment };

/** A pooled media tile: a stable DOM slot plus its geometry and source. */
export type PoolTile = GalleryPosition & {
  slot: number;
  itemId: string;
  src: string;
  defaultSrc: string;
  matchTimestampMs?: number;
  alt: string;
  /** Source pixel size, carried through so the renderer can spot images it would upscale. */
  naturalWidth: number;
  naturalHeight: number;
  mediaKind: "image" | "video";
  durationMs: number | null;
  animated: boolean;
  /** Filename or OCR/vector snippet for the active search, looked up while assigning a slot. */
  snippet?: string;
  /** Precomputed once at assignment, so caption markup does no per-render text work. */
  snippetSegments?: readonly SnippetSegment[];
  /** Identifies the literal terms used to produce `snippetSegments`. */
  snippetTermsKey?: string;
  /** Byte size as a decimal string, carried through for the media-promotion policy's size gate. */
  sourceSize: string;
  /** Restricted original-media URL — full animated GIF or video bytes. Only requested for tiles
   * the media-promotion policy actually promotes; see `lib/gallery/media-policy.ts`. */
  originalSrc: string;
};

export interface PoolRequest {
  tiles: PoolTile[];
  layout: GalleryLayout;
  items: GalleryItem[];
  /** Item range to cover, from the virtualizer. */
  start: number;
  end: number;
  /** Hard ceiling on live `<img>` elements. */
  poolSize: number;
  devicePixelRatio: number;
  /** Search snippets by item id; tiles in range get their caption attached here. */
  snippets?: ReadonlyMap<string, string>;
  /** Winning indexed frame for visual-search video hits, by asset id. */
  matchTimes?: ReadonlyMap<string, number>;
  /** Literal content-search terms used to mark matching portions of a snippet. */
  snippetTerms?: readonly string[];
  /** Stable identity of `snippetTerms`, so marks are recomputed only when terms change. */
  snippetTermsKey?: string;
  /** Filename matching is literal substring matching, not FTS syntax (e.g. "OR" or "a_b"). */
  filenameQuery?: string;
}

/**
 * Maps an item range onto a fixed pool of DOM slots. Tiles already showing an item that is still
 * in range keep their slot (so no `src` churn and no decode); slots that fell out of range are
 * recycled for newly visible items. Shared by every layout mode — only the range differs.
 */
export function recyclePool({
  tiles,
  layout,
  items,
  start,
  end,
  poolSize,
  devicePixelRatio,
  snippets,
  matchTimes,
  snippetTerms = EMPTY_SNIPPET_TERMS,
  snippetTermsKey = "",
  filenameQuery = "",
}: PoolRequest): PoolTile[] {
  if (!layout.positions.length || end <= start) return [];

  const limit = start + Math.min(poolSize, end - start);
  const retainedByIndex = new Map<number, PoolTile>();
  const freeSlots: number[] = [];
  let nextSlot = tiles.reduce((highest, tile) => Math.max(highest, tile.slot), -1) + 1;
  const marksEnabled = snippetTerms.length > 0 || filenameQuery.length > 0;

  for (const tile of tiles) {
    // Retention is by identity, not just position: when `items` changes under a filter, an index
    // still in range can now refer to a different image, and keeping that slot would leave the
    // previous image showing at the new tile's geometry.
    const occupant = tile.index >= start && tile.index < limit ? items[tile.index] : undefined;
    const position = layout.positions[tile.index];
    const desiredSnippet = occupant ? snippets?.get(occupant.id) || undefined : undefined;
    const matchTimestampMs =
      occupant?.mediaKind === "video" ? matchTimes?.get(occupant.id) : undefined;
    const desiredSource =
      occupant && position
        ? thumbnailUrlOf(
            occupant,
            position.width,
            position.height,
            devicePixelRatio,
            matchTimestampMs,
          )
        : null;
    if (
      occupant &&
      occupant.id === tile.itemId &&
      desiredSource === tile.src &&
      desiredSnippet === tile.snippet &&
      (!desiredSnippet ||
        (marksEnabled
          ? snippetTermsKey === tile.snippetTermsKey
          : tile.snippetSegments === undefined))
    ) {
      retainedByIndex.set(tile.index, tile);
    } else freeSlots.push(tile.slot);
  }

  const next: PoolTile[] = [];
  for (let index = start; index < limit; index += 1) {
    const position = layout.positions[index];
    if (!position) continue;
    const retained = retainedByIndex.get(index);
    if (retained) {
      // Keep the DOM slot, but never keep geometry from the previous layout pass.
      next.push({ ...retained, ...position });
      continue;
    }
    const item = items[index];
    const matchTimestampMs = item.mediaKind === "video" ? matchTimes?.get(item.id) : undefined;
    const snippet = snippets?.get(item.id) || undefined;
    const isFilename = Boolean(filenameQuery && snippet === item.displayName);
    next.push({
      slot: freeSlots.pop() ?? nextSlot++,
      ...position,
      itemId: item.id,
      ...(snippet
        ? {
            snippet,
            ...(marksEnabled
              ? {
                  snippetSegments: isFilename
                    ? segmentFilename(snippet, filenameQuery)
                    : segmentSnippet(snippet, snippetTerms),
                  snippetTermsKey,
                }
              : {}),
          }
        : {}),
      src: thumbnailUrlOf(
        item,
        position.width,
        position.height,
        devicePixelRatio,
        matchTimestampMs,
      ),
      defaultSrc: thumbnailUrlOf(item, position.width, position.height, devicePixelRatio),
      matchTimestampMs,
      alt: item.displayName,
      naturalWidth: item.sourceWidth ?? 0,
      naturalHeight: item.sourceHeight ?? 0,
      mediaKind: item.mediaKind,
      durationMs: item.durationMs,
      animated: item.animated,
      sourceSize: item.sourceSize,
      originalSrc: originalUrlOf(item),
    });
  }

  return next.sort((left, right) => left.slot - right.slot);
}
