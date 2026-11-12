import { parseQuery, textWithoutScope } from "./search-query";

/** Recent searches offered by the search field's dropdown. */
export const RECENT_SEARCH_LIMIT = 20;

/** What a Back step compares: the query text and the visual examples it carried. */
export interface SearchStep {
  query: string;
  /** Visual example IDs, in order. */
  referenceIds: readonly string[];
  /** Recorded by the idle timer while the query was still being typed. A provisional step is
   * refined in place, so the partial queries typed on the way do not each become a Back step. */
  provisional: boolean;
}

/** A query with nothing to search for: empty, or only a scope prefix such as `ocr:`. */
export function isBlankQuery(query: string): boolean {
  return textWithoutScope(parseQuery(query).tokens).trim() === "";
}

function isBlank(step: Pick<SearchStep, "query" | "referenceIds">): boolean {
  return step.referenceIds.length === 0 && isBlankQuery(step.query);
}

function sameStep(
  a: Pick<SearchStep, "query" | "referenceIds">,
  b: Pick<SearchStep, "query" | "referenceIds">,
): boolean {
  return (
    a.query.trim() === b.query.trim() &&
    a.referenceIds.length === b.referenceIds.length &&
    a.referenceIds.every((id, index) => id === b.referenceIds[index])
  );
}

/**
 * How a newly settled search relates to the current history step:
 * - `same`: nothing changed.
 * - `replace`: the step is a blank field, or a provisional query being typed further or
 *   backspaced (`ca` → `cats`); update it in place.
 * - `push`: a new Back step.
 */
export function searchStepRelation(
  current: SearchStep,
  next: Pick<SearchStep, "query" | "referenceIds">,
): "same" | "replace" | "push" {
  if (sameStep(current, next)) return "same";
  if (isBlank(current)) return "replace";
  if (
    current.provisional &&
    !isBlank(next) &&
    current.referenceIds.length === 0 &&
    next.referenceIds.length === 0
  ) {
    const before = current.query.trim().toLowerCase();
    const after = next.query.trim().toLowerCase();
    if (after.startsWith(before) || before.startsWith(after)) return "replace";
  }
  return "push";
}

/** Whether a query belongs in the recent list: it has search text or filters beyond a scope or
 * folder, and needs no visual examples, which are session-only. */
export function isRememberable(query: string, referenceCount: number): boolean {
  if (referenceCount > 0) return false;
  const parsed = parseQuery(query);
  return parsed.tokens.some(
    (token) => token.kind !== "scope" && token.kind !== "folder" && token.raw.trim() !== "",
  );
}

/** `query` moved to the front of `recent`, without duplicates and within the limit. */
export function withRecent(recent: readonly string[], query: string): string[] {
  const text = query.trim();
  return [text, ...recent.filter((entry) => entry !== text)].slice(0, RECENT_SEARCH_LIMIT);
}

/** Recent entries matching typed `text`, case-insensitively, excluding `text` itself. */
export function matchingRecent(recent: readonly string[], text: string): string[] {
  const needle = text.trim().toLowerCase();
  if (!needle) return [...recent];
  return recent.filter((entry) => {
    const candidate = entry.toLowerCase();
    return candidate !== needle && candidate.includes(needle);
  });
}
