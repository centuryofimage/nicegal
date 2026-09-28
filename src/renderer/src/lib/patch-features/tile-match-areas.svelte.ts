/* eslint-disable svelte/prefer-svelte-reactivity -- Cache, queue, and failures are imperative bookkeeping; only entries drive rendering. */
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

type ScoreResult =
  | {
      assetId: number;
      timestampMs?: number;
      rows: number;
      columns: number;
      region: TileMatchMap["region"];
      scores: number[];
      pooled: number;
    }
  | { assetId: number; timestampMs?: number; error: string };

export function matchAreaKey(assetId: string, timestampMs?: number): string {
  return timestampMs === undefined ? assetId : `${assetId}@${timestampMs}`;
}

function targetFromKey(key: string): { assetId: number; timestampMs?: number } {
  const [assetId, timestampMs] = key.split("@");
  return timestampMs === undefined
    ? { assetId: Number(assetId) }
    : { assetId: Number(assetId), timestampMs: Number(timestampMs) };
}

const CACHE_LIMIT = 3000;
const cache = new Map<string, TileMatchMap>();

function cached(key: string): TileMatchMap | undefined {
  const value = cache.get(key);
  if (value) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

function remember(key: string, value: TileMatchMap): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

/** Request maps for tiles intersecting the viewport, with latest visibility taking priority. */
export class TileMatchAreas {
  readonly entries = new SvelteMap<string, TileMatchMap>();
  busy = $state(false);
  private query: ImageQuery | null = null;
  private prefix = "";
  private visible: string[] = [];
  private pending = new Set<string>();
  private inFlight = new Set<string>();
  private failed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: AbortController | null = null;
  private generation = 0;

  configure(model: string, query: ImageQuery | null, visible: string[]): void {
    const prefix = query ? `${model}|${JSON.stringify(query)}|` : "";
    if (prefix !== this.prefix) {
      this.generation += 1;
      this.active?.abort();
      this.active = null;
      this.pending.clear();
      this.inFlight.clear();
      this.failed.clear();
      this.entries.clear();
      this.prefix = prefix;
      this.query = query;
    }
    this.visible = visible;
    const visibleSet = new Set(visible);
    for (const id of this.pending) if (!visibleSet.has(id)) this.pending.delete(id);
    if (!query) {
      this.updateBusy();
      return;
    }
    for (const id of visible) {
      if (this.entries.has(id) || this.failed.has(id) || this.inFlight.has(id)) continue;
      const hit = cached(prefix + id);
      if (hit) this.entries.set(id, hit);
      else this.pending.add(id);
    }
    this.schedule();
    this.updateBusy();
  }

  dispose(): void {
    this.generation += 1;
    this.active?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.busy = false;
  }

  private updateBusy(): void {
    this.busy = Boolean(this.query && (this.pending.size || this.active));
  }

  private schedule(): void {
    if (this.timer || this.active || !this.pending.size || !this.query) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 100);
  }

  private async flush(): Promise<void> {
    if (this.active || !this.query || !this.pending.size) return;
    const ids = this.visible.filter((id) => this.pending.has(id)).slice(0, 8);
    if (!ids.length) return;
    for (const id of ids) this.pending.delete(id);
    for (const id of ids) this.inFlight.add(id);
    const generation = this.generation;
    const prefix = this.prefix;
    const controller = new AbortController();
    this.active = controller;
    try {
      const response = await fetch(apiUrl("/v1/image-embeddings/patch-scores"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targets: ids.map(targetFromKey), imageQuery: this.query }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Patch scores: ${response.status}`);
      const body = (await response.json()) as { model: string; results: ScoreResult[] };
      if (generation !== this.generation || controller.signal.aborted) return;
      for (const result of body.results) {
        const id = matchAreaKey(String(result.assetId), result.timestampMs);
        if ("error" in result) {
          this.failed.add(id);
          continue;
        }
        if (result.scores.length !== result.rows * result.columns) continue;
        const map: TileMatchMap = {
          pixels: colorizeScores(result.scores).pixels,
          rows: result.rows,
          columns: result.columns,
          region: result.region,
        };
        remember(prefix + id, map);
        this.entries.set(id, map);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn("Tile match areas failed", error);
        for (const id of ids) this.failed.add(id);
      }
    } finally {
      if (generation === this.generation) for (const id of ids) this.inFlight.delete(id);
      if (this.active === controller) this.active = null;
      if (generation === this.generation) this.schedule();
      this.updateBusy();
    }
  }
}
