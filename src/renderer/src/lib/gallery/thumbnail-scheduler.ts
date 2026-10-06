import type { EnsureThumbnailsRequest, EnsureThumbnailsResponse } from "../../../../shared/backend";

export interface ThumbnailMiss {
  assetId: string;
  width: number;
  height: number;
}

export interface ThumbnailFailure {
  assetId: string;
  attempts: number;
  error: unknown;
}

interface ThumbnailSchedulerOptions {
  concurrency: number;
  batchSize: number;
  maxAttempts: number;
  /**
   * Returns every currently useful pending id in launch order. It is called again before every
   * request, so a viewport change replaces the old ordering instead of appending to a FIFO.
   */
  selectCandidates: (pending: ReadonlyMap<string, ThumbnailMiss>) => readonly string[];
  requiredSize: (miss: ThumbnailMiss) => number;
  ensure: (request: EnsureThumbnailsRequest) => Promise<EnsureThumbnailsResponse>;
  onReady: (assetIds: readonly string[]) => void;
  onRetry: (assetId: string) => void;
  onFailed: (failure: ThumbnailFailure) => void;
}

export interface ThumbnailScheduler {
  /** Queues a miss unless that asset is already pending, in flight, or terminally failed. */
  enqueue(miss: ThumbnailMiss): boolean;
  /** Only a decoded poster confirms recovery; an ensure response alone does not. */
  loaded(assetId: string): void;
  /** Explicit user retry grants a fresh bounded attempt budget. */
  retry(assetIds: readonly string[]): void;
  /** Allows new requests and immediately fills every free request slot. */
  resume(): void;
  /** Prevents new requests; requests already in progress are deliberately not cancelled. */
  pause(): void;
  dispose(): void;
}

/** A tile's vertical extent in canvas pixels. */
export interface TileSpan {
  itemId: string;
  y: number;
  height: number;
}

/**
 * Orders pending thumbnails for launch: tiles on screen first, then tiles ahead in the scroll
 * direction, then tiles behind it, each group nearest first. `direction` is 1 when scrolling
 * down and -1 when scrolling up. Tiles with no pending miss are left out.
 */
export function orderThumbnailCandidates(
  pending: ReadonlyMap<string, ThumbnailMiss>,
  tiles: readonly TileSpan[],
  viewport: { top: number; bottom: number },
  direction: 1 | -1,
): string[] {
  const visible: Array<{ id: string; distance: number }> = [];
  const ahead: Array<{ id: string; distance: number }> = [];
  const behind: Array<{ id: string; distance: number }> = [];
  for (const tile of tiles) {
    if (!pending.has(tile.itemId)) continue;
    const bottom = tile.y + tile.height;
    if (bottom >= viewport.top && tile.y <= viewport.bottom) {
      visible.push({ id: tile.itemId, distance: Math.abs(tile.y - viewport.top) });
      continue;
    }
    const isAhead = direction > 0 ? tile.y > viewport.bottom : bottom < viewport.top;
    const distance =
      direction > 0 ? Math.abs(tile.y - viewport.bottom) : Math.abs(viewport.top - bottom);
    (isAhead ? ahead : behind).push({ id: tile.itemId, distance });
  }
  const byDistance = (left: { distance: number }, right: { distance: number }): number =>
    left.distance - right.distance;
  return [visible, ahead, behind].flatMap((group) =>
    group.sort(byDistance).map((candidate) => candidate.id),
  );
}

export function createThumbnailScheduler(options: ThumbnailSchedulerOptions): ThumbnailScheduler {
  const pending = new Map<string, ThumbnailMiss>();
  const inFlight = new Set<string>();
  const attempts = new Map<string, number>();
  const giveUp = new Set<string>();
  let activeRequests = 0;
  let paused = true;
  let disposed = false;
  let pumpFrame: number | undefined;

  function fail(assetId: string, error: unknown): void {
    if (giveUp.has(assetId) || disposed) return;
    giveUp.add(assetId);
    const failure = { assetId, attempts: attempts.get(assetId) ?? 0, error };
    console.error("[nicegal:thumbnails] giving up on asset", failure);
    options.onFailed(failure);
  }

  function schedulePump(): void {
    if (paused || disposed || pumpFrame !== undefined) return;
    // Collect the poster errors delivered in this paint into actual pairs instead of launching a
    // one-asset request for the first error before the second image reports its miss.
    pumpFrame = requestAnimationFrame(() => {
      pumpFrame = undefined;
      pump();
    });
  }

  function pump(): void {
    if (paused || disposed) return;

    while (activeRequests < options.concurrency && pending.size > 0) {
      // The selector returns the complete current working set, not merely the next batch. Anything
      // omitted has left the pool and is discarded so erratic scrolling cannot create a backlog.
      const orderedIds = options.selectCandidates(pending);
      const eligibleIds = new Set(orderedIds);
      for (const id of pending.keys()) {
        if (!eligibleIds.has(id)) pending.delete(id);
      }

      const batch: ThumbnailMiss[] = [];
      for (const id of orderedIds) {
        const miss = pending.get(id);
        if (!miss) continue;
        batch.push(miss);
        pending.delete(id);
        if (batch.length === options.batchSize) break;
      }
      if (batch.length === 0) break;

      for (const miss of batch) {
        inFlight.add(miss.assetId);
        attempts.set(miss.assetId, (attempts.get(miss.assetId) ?? 0) + 1);
      }
      activeRequests += 1;
      void launch(batch);
      // Do not await: fill the remaining slots from a freshly selected current working set.
    }
  }

  async function launch(batch: readonly ThumbnailMiss[]): Promise<void> {
    const assetIds = batch.map((miss) => miss.assetId);
    const requiredSize = batch.reduce(
      (largest, miss) => Math.max(largest, options.requiredSize(miss)),
      1,
    );
    console.info("[nicegal:thumbnails] ensuring batch", { assetIds, requiredSize });
    const startedAt = performance.now();

    try {
      const result = await options.ensure({ assetIds, requiredSize });
      if (disposed) return;
      console.info("[nicegal:thumbnails] ensured", {
        assetIds: result.assetIds,
        sizeBucket: result.sizeBucket,
        generatorVersion: result.generatorVersion,
        ms: Math.round(performance.now() - startedAt),
      });
      options.onReady(assetIds);
    } catch (error) {
      if (disposed) return;
      console.warn("[nicegal:thumbnails] ensure failed for batch", { assetIds, error });
      for (const id of assetIds) {
        if ((attempts.get(id) ?? 0) >= options.maxAttempts) {
          fail(id, error);
        } else {
          options.onRetry(id);
        }
      }
    } finally {
      for (const id of assetIds) inFlight.delete(id);
      activeRequests -= 1;
      pump();
    }
  }

  return {
    enqueue(miss: ThumbnailMiss): boolean {
      if (
        disposed ||
        giveUp.has(miss.assetId) ||
        inFlight.has(miss.assetId) ||
        pending.has(miss.assetId)
      ) {
        return false;
      }
      if ((attempts.get(miss.assetId) ?? 0) >= options.maxAttempts) {
        fail(
          miss.assetId,
          new Error(
            "Thumbnail could not be loaded after generation. The poster may be missing or unreadable.",
          ),
        );
        return false;
      }
      pending.set(miss.assetId, miss);
      schedulePump();
      return true;
    },
    loaded(assetId): void {
      attempts.delete(assetId);
      giveUp.delete(assetId);
      pending.delete(assetId);
    },
    retry(assetIds): void {
      for (const id of assetIds) {
        if (!giveUp.delete(id)) continue;
        attempts.delete(id);
      }
    },
    resume(): void {
      if (disposed) return;
      paused = false;
      schedulePump();
    },
    pause(): void {
      paused = true;
    },
    dispose(): void {
      disposed = true;
      paused = true;
      if (pumpFrame !== undefined) cancelAnimationFrame(pumpFrame);
      pumpFrame = undefined;
      pending.clear();
    },
  };
}
