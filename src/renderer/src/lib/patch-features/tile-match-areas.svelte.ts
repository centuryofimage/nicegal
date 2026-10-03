import { SvelteMap } from "svelte/reactivity";

import type { ImageQuery } from "../../../../shared/backend";

import { apiUrl } from "../platform";
import { colorizeScores } from "./similar";

export interface TileMatchMap {
  pixels: Uint8ClampedArray<ArrayBuffer>;
  rows: number;
  columns: number;
  region: [number, number, number, number];
}

/** An image, or one sampled frame of a video. */
export interface TileMatchTarget {
  assetId: string;
  timestampMs?: number;
}

type ScoreResult =
  | {
      assetId: number;
      timestampMs?: number;
      rows: number;
      columns: number;
      region: TileMatchMap["region"];
      scores: number[];
    }
  | { assetId: number; timestampMs?: number; error: string };

/** Visible tiles settle for this long before a request goes out. */
const REQUEST_DELAY_MS = 100;
const TARGETS_PER_REQUEST = 8;
const CACHE_BUDGET_BYTES = 32 * 1024 * 1024;

function targetKey(target: TileMatchTarget): string {
  return target.timestampMs === undefined
    ? target.assetId
    : `${target.assetId}@${target.timestampMs}`;
}

/**
 * Least-recently-used maps for every query, keyed by query signature and target. Shared across
 * gallery instances so returning to an earlier search reuses its maps. Reactive so tiles repaint
 * as maps arrive; recency is only refreshed by `configure`, never while rendering.
 */
const cache = new SvelteMap<string, TileMatchMap>();
let cacheBytes = 0;

function remember(key: string, map: TileMatchMap): void {
  const previous = cache.get(key);
  if (previous) cacheBytes -= previous.pixels.byteLength;
  cache.delete(key);
  cache.set(key, map);
  cacheBytes += map.pixels.byteLength;
  for (const [oldest, value] of cache) {
    if (cacheBytes <= CACHE_BUDGET_BYTES) break;
    cache.delete(oldest);
    cacheBytes -= value.pixels.byteLength;
  }
}

function touch(key: string): boolean {
  const map = cache.get(key);
  if (!map) return false;
  cache.delete(key);
  cache.set(key, map);
  return true;
}

/** Requests maps for tiles intersecting the viewport, one batch at a time, latest visibility first. */
export class TileMatchAreas {
  busy = $state(false);
  /** Model and query the cached maps belong to; empty without a query. */
  private signature = $state("");
  private query: ImageQuery | null = null;
  private visible: readonly TileMatchTarget[] = [];
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- request bookkeeping, never rendered
  private inFlight = new Set<string>();
  /** Targets the service could not score for the current query; not retried until it changes. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- request bookkeeping, never rendered
  private failed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: AbortController | null = null;

  get(target: TileMatchTarget): TileMatchMap | undefined {
    return this.signature ? cache.get(this.signature + targetKey(target)) : undefined;
  }

  configure(model: string, query: ImageQuery | null, visible: readonly TileMatchTarget[]): void {
    const signature = query ? `${model}|${JSON.stringify(query)}|` : "";
    if (signature !== this.signature) {
      this.cancelRequest();
      this.failed.clear();
      this.signature = signature;
      this.query = query;
    }
    this.visible = visible;
    for (const target of visible) touch(signature + targetKey(target));
    this.schedule();
    this.updateBusy();
  }

  dispose(): void {
    this.cancelRequest();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.busy = false;
  }

  private cancelRequest(): void {
    this.active?.abort();
    this.active = null;
    this.inFlight.clear();
  }

  private missing(): TileMatchTarget[] {
    if (!this.query) return [];
    return this.visible.filter((target) => {
      const key = targetKey(target);
      return !cache.has(this.signature + key) && !this.failed.has(key) && !this.inFlight.has(key);
    });
  }

  private updateBusy(): void {
    this.busy = Boolean(this.query && (this.active || this.missing().length));
  }

  private schedule(): void {
    if (this.timer || this.active || !this.missing().length) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, REQUEST_DELAY_MS);
  }

  private async flush(): Promise<void> {
    const targets = this.missing().slice(0, TARGETS_PER_REQUEST);
    if (this.active || !this.query || !targets.length) return;
    const keys = targets.map(targetKey);
    for (const key of keys) this.inFlight.add(key);
    const signature = this.signature;
    const controller = new AbortController();
    this.active = controller;
    try {
      const response = await fetch(apiUrl("/v1/image-embeddings/patch-scores"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targets: targets.map(({ assetId, timestampMs }) => ({
            assetId: Number(assetId),
            timestampMs,
          })),
          imageQuery: this.query,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Patch scores: ${response.status}`);
      const { results } = (await response.json()) as { results: ScoreResult[] };
      if (this.active !== controller) return;
      for (const result of results) {
        if ("error" in result || result.scores.length !== result.rows * result.columns) continue;
        const key = targetKey({ assetId: String(result.assetId), timestampMs: result.timestampMs });
        remember(signature + key, {
          pixels: colorizeScores(result.scores).pixels,
          rows: result.rows,
          columns: result.columns,
          region: result.region,
        });
      }
      // Errors, malformed scores, and omitted targets are not requested again for this query.
      for (const key of keys) if (!cache.has(signature + key)) this.failed.add(key);
    } catch (error) {
      if (this.active === controller) {
        console.warn("Tile match areas failed", error);
        for (const key of keys) this.failed.add(key);
      }
    } finally {
      if (this.active === controller) {
        this.active = null;
        for (const key of keys) this.inFlight.delete(key);
        this.schedule();
      }
      this.updateBusy();
    }
  }
}
