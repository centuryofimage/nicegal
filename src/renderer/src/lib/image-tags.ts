/** Zero-shot subjects and vibes for one asset, from nicegal-server's `/v1/assets/tags`. */
import { apiUrl } from "./platform";

export interface ImageTag {
  term: string;
  source: "metaclip" | "wordnet";
  /** "mature" tags are descriptive adult terms; "blocked" ones only appear when not hidden. */
  sensitivity: "ok" | "mature" | "blocked";
  similarity: number;
  /** Similarity above the tag's average over a reference set of everyday images. */
  score: number;
}

export interface ImageTags {
  model: string;
  /** False when the active image model has no tags; every list is then empty. */
  supported: boolean;
  /** Common everyday words, like car or happy. */
  simple: ImageTag[];
  subjects: ImageTag[];
  vibes: ImageTag[];
}

export async function loadImageTags(assetId: string, hideOffensive: boolean): Promise<ImageTags> {
  const query = new URLSearchParams({
    assetId: String(Number(assetId)),
    hideOffensive: String(hideOffensive),
  });
  const response = await fetch(apiUrl(`/v1/assets/tags?${query}`));
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as ImageTags;
}
