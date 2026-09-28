import type { ImageQuery } from "../../../../shared/backend";

import { readSafetensors, type F32Tensor } from "./safetensors";
import { colorizeScores } from "./similar";

export interface MatchMap {
  /** Row-major opaque RGBA, one Turbo-colored pixel per patch; upscale it over `region`. */
  pixels: Uint8ClampedArray<ArrayBuffer>;
  rows: number;
  columns: number;
  /** `[x, y, width, height]` of the displayed image the grid covers, as fractions. */
  region: [number, number, number, number];
  /** Cosine similarity of the whole image to the query. */
  pooled: number | null;
  /** Patch similarity range that the colors span. */
  low: number;
  high: number;
  /** Unit-length `[rows, columns, dimensions]` patch vectors, kept for patch-to-patch views. */
  patches: F32Tensor;
}

export type MatchResult =
  | { status: "ready"; map: MatchMap }
  | { status: "failed"; message: string }
  | { status: "cancelled" };

/**
 * Where `assetId` matches `imageQuery`. Settles with a displayable result and never rejects; an
 * aborted request settles as `cancelled`.
 */
export async function loadMatchMap(
  assetId: string,
  imageQuery: ImageQuery | null,
  signal: AbortSignal,
): Promise<MatchResult> {
  try {
    const response = await fetch("api://server/v1/image-embeddings/patches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetId: Number(assetId), imageQuery }),
      signal,
    });
    if (response.status === 502 || response.status === 503) {
      return { status: "failed", message: "Backend is restarting" };
    }
    if (!response.ok) {
      const code = await errorCode(response);
      console.warn("Match map failed", response.status, code);
      return { status: "failed", message: failureMessage(code) };
    }
    const { metadata, tensors } = readSafetensors(await response.arrayBuffer());
    const { patches, query, embedding } = tensors;
    if (!patches || (imageQuery && (!query || !embedding)))
      throw new Error("Patch response is missing tensors.");
    const region = JSON.parse(metadata["region"] ?? "[0,0,1,1]") as MatchMap["region"];
    return {
      status: "ready",
      map:
        query && embedding
          ? scoreMatchMap(patches, query.data, embedding.data, region)
          : {
              pixels: new Uint8ClampedArray(patches.shape[0]! * patches.shape[1]! * 4),
              rows: patches.shape[0]!,
              columns: patches.shape[1]!,
              region,
              pooled: null,
              low: 0,
              high: 0,
              patches,
            },
    };
  } catch (error) {
    if (signal.aborted) return { status: "cancelled" };
    console.warn("Match map failed", error);
    return { status: "failed", message: failureMessage(null) };
  }
}

/** Score each patch against `query` and color the grid over this image's own score range. */
export function scoreMatchMap(
  patches: F32Tensor,
  query: Float32Array,
  embedding: Float32Array,
  region: MatchMap["region"],
): MatchMap {
  const [rows = 0, columns = 0, dimensions = 0] = patches.shape;
  if (query.length !== dimensions) throw new Error("Query and patch widths differ.");
  const scores = new Float32Array(rows * columns);
  for (let patch = 0; patch < scores.length; patch += 1) {
    let score = 0;
    const offset = patch * dimensions;
    for (let d = 0; d < dimensions; d += 1) score += patches.data[offset + d]! * query[d]!;
    scores[patch] = score;
  }
  let pooled = 0;
  for (let d = 0; d < dimensions; d += 1) pooled += embedding[d]! * query[d]!;

  const { pixels, low, high } = colorizeScores(scores);
  return { pixels, rows, columns, region, pooled, low, high, patches };
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: { code?: string } };
    return body.error?.code ?? null;
  } catch {
    // Non-JSON failures come from the protocol handler itself.
    return null;
  }
}

function failureMessage(code: string | null): string {
  if (code === "invalid_request") return "Not available for this image or model";
  if (code === "models_not_ready") return "Visual search model isn't ready";
  return "Couldn't map match areas";
}
