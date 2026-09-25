/* eslint-disable svelte/prefer-svelte-reactivity -- Search collections are immutable snapshots; raw state tracks replacement without per-hit reactive bookkeeping. */

import type { LibraryId, Timeline, SearchResponse, SearchResult } from "../../../shared/backend";
import type { ExternalVisualReference } from "../../../shared/backend";
import type { CatalogController } from "./catalog.svelte";
import type { GallerySection } from "./gallery/types";

import { isQuerySyntaxError, searchErrorMessage } from "./errors";
import { localDateToExclusiveNs, localDateToNs } from "./job-params";
import { parseQuery, withScope, type DateFilter, type SearchScope } from "./search-query";
import {
  isVisualComposition,
  parseVisualTextTerms,
  type VisualReferenceTerm,
} from "./visual-query";

type CatalogItem = CatalogController["items"][number];
const EMPTY_FRAME_TIMES: ReadonlyMap<string, number> = new Map();

function frameTimes(hits: readonly SearchResult[]): ReadonlyMap<string, number> {
  return new Map(
    hits.flatMap((hit) =>
      hit.timestampMs === undefined ? [] : [[hit.assetId, hit.timestampMs] as const],
    ),
  );
}

/** Validate before queueing a publication: malformed IPC responses must not poison a section
 * or throw later when deferred results are applied after scrolling/selection ends. */
function validateSearchResponse(response: SearchResponse): SearchResponse {
  if (
    !response ||
    !Number.isSafeInteger(response.total) ||
    response.total < 0 ||
    !Array.isArray(response.results) ||
    response.results.some(
      (hit) =>
        !hit ||
        typeof hit.assetId !== "string" ||
        typeof hit.snippet !== "string" ||
        (hit.timestampMs !== undefined &&
          (!Number.isSafeInteger(hit.timestampMs) || hit.timestampMs < 0)) ||
        [hit.rank, hit.distance, hit.score].some(
          (value) => value !== undefined && !Number.isFinite(value),
        ),
    )
  )
    throw new Error("Invalid search response");
  return response;
}

/** Whether a query typed at this scope produces something a relevance order can be built from.
 * `name` is client-side substring matching — every hit is equally a hit, so there is nothing to
 * rank and the options strip stays hidden. */
export function isRankableScope(scope: SearchScope): scope is "all" | "ocr" | "meaning" | "like" {
  return scope === "all" || scope === "ocr" || scope === "meaning" || scope === "like";
}

export type SearchSortMode = "relevance" | "date";

/**
 * How long `schedule()` waits after the last keystroke before running filename matching and
 * firing the backend file/text/vector/image queries. Coalesce a typing burst so the backend
 * do not compute and transfer result sets that a later keystroke will immediately replace.
 */
const SEARCH_DEBOUNCE_MS = 200;

/** Backend API ceiling, not a relevance threshold. Report overflow rather than silently hiding
 * the tail. Relevance no longer has the frontend-only 500-result cutoff (2026-09-13). */
const SEARCH_RESULT_LIMIT = 250_000;
/** User follow-up 2026-09-13 supersedes the strongest-5% section: append at most ten
 * related-text hits to Names and text, independently of the CLIP slider. */
export const ALL_RELATED_RESULT_LIMIT = 10;
let nextSearchSession = Date.now();

/**
 * Five-point stops include the 95 related-text default. A step of ten makes the browser round
 * that default to 100, misrepresenting the actual filter (and changing it on first interaction).
 */
export const MATCH_QUALITY_STEP = 5;

/**
 * Related-text default. User review 2026-09-13 raises the previous midpoint to 95.
 * In meaning: the user can still broaden it in Date view. All uses its own ten-result cap.
 */
export const DEFAULT_MATCH_QUALITY = 95;

/**
 * CLIP ranks every indexed image, including weakly related ones. Its logarithmic cutoff maps the
 * midpoint to the best 10%, giving a useful conservative starting point without pushing the
 * control to its far end.
 */
export const DEFAULT_CLIP_MATCH_QUALITY = 50;

/**
 * What one `apply()` pass produced: the items to render, plus the two numbers the search options
 * strip needs but cannot recover from the array alone.
 */
export interface SearchView {
  items: CatalogItem[];
  sections?: GallerySection[];
  sources?: ReadonlyMap<string, string>;
  /** Distinct displayed results after the mode's explicit filtering rules. */
  matchTotal: number;
  /**
   * Whether the gallery is showing a search result rather than the whole library. True for any
   * non-empty query — including a date-only one, which filters with no search body at all.
   */
  filtering: boolean;
}

export class OcrSearchController {
  private queryValue = $state("");
  composerOpen = $state(false);
  /** Invalidates file reads/pickers when the user clears or leaves the visual search. */
  visualSessionRevision = 0;

  get query(): string {
    return this.queryValue;
  }

  set query(value: string) {
    if (parseQuery(value).scope !== "like") this.resetVisualSearch();
    this.queryValue = value;
  }

  resetVisualSearch(): void {
    this.composerOpen = false;
    this.visualSessionRevision += 1;
    if (this.visualReferences.length) this.setVisualReferences([]);
  }
  private literalPending = $state(false);
  private filePending = $state(false);
  private broadPending = $state({ meaning: false, visual: false });
  // Responses are immutable snapshots. Avoid proxying hundreds of thousands of hit objects.
  private broadResults = $state.raw<Record<"meaning" | "visual", SearchResponse>>({
    meaning: { results: [], total: 0 },
    visual: { results: [], total: 0 },
  });
  private broadErrors = $state({ meaning: "", visual: "" });
  private broadTimer: ReturnType<typeof setTimeout> | undefined;
  private interacting = false;
  private deferredResults: Array<() => void> = [];
  private interactionRelease: ReturnType<typeof setTimeout> | undefined;

  /** A completed lane must not recycle a tile between pointerdown and click, or during marquee
   * selection. Release after the click has dispatched; queued commits recheck the session. */
  setInteracting(active: boolean): void {
    if (this.interactionRelease) clearTimeout(this.interactionRelease);
    if (active) {
      this.interacting = true;
      return;
    }
    this.interactionRelease = setTimeout(() => {
      this.interacting = false;
      const results = this.deferredResults;
      this.deferredResults = [];
      for (const publish of results) publish();
    }, 0);
  }

  private publish(generation: number, update: () => void): void {
    const commit = (): void => {
      if (generation === this.generation) update();
    };
    if (this.interacting) this.deferredResults.push(commit);
    else commit();
  }
  get pending(): boolean {
    return (
      this.literalPending ||
      this.filePending ||
      this.broadPending.meaning ||
      this.broadPending.visual
    );
  }
  set pending(value: boolean) {
    this.literalPending = value;
  }
  get allMode(): boolean {
    return this.parsed.scope === "all" && Boolean(this.searchBody);
  }
  get sliderLabel(): string {
    return this.parsed.scope === "meaning" ? "Match quality" : "Visual similarity";
  }
  get allNotice(): string {
    return [
      this.error || this.indexNotice ? `Names and text: ${this.error || this.indexNotice}` : "",
      this.broadErrors.meaning ? `Related text: ${this.broadErrors.meaning}` : "",
      this.broadErrors.visual ? `Visual results: ${this.broadErrors.visual}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  error = $state("");
  indexNotice = $state("");
  textSetupRequired = $state(false);
  imageSetupRequired = $state(false);
  /** Set only after the current query's coverage check confirms a semantic search can run. */
  semanticAvailable = $state(false);
  total = $state(0);
  /** Indexed-search result IDs only; filename matches are tracked separately. */
  matches = $state.raw<ReadonlySet<string> | null>(null);
  snippets = $state.raw(new Map<string, string>());
  private filenameSnippets = $state.raw(new Map<string, string>());
  /** Use the same filename/excerpt tooltip and caption pipeline in every view. All also needs
   * excerpts from its admitted related-text lane. Literal OCR takes precedence when both match. */
  readonly displaySnippets = $derived.by(() => {
    const snippets = new Map<string, string>();
    if (this.allMode) {
      const related = this.broadResults.meaning.results;
      const count = ALL_RELATED_RESULT_LIMIT;
      for (const hit of related.slice(0, count)) snippets.set(hit.assetId, hit.snippet);
    }
    // Prefer the literal filename explanation over a related-text excerpt, but retain an OCR
    // excerpt when both filename and OCR matched. Build filenames in the existing debounced scan.
    for (const [id, name] of this.filenameSnippets) snippets.set(id, name);
    for (const [id, text] of this.snippets) if (text.trim()) snippets.set(id, text);
    return snippets;
  });
  /**
   * Result IDs in the backend's own rank order — already reranked server-side, so this array is
   * the relevance ordering, not something to re-sort. Empty until a rankable search lands.
   */
  rankedIds = $state.raw<string[]>([]);
  /** Per-hit relevance signal: cosine distance for `meaning`/`like`, FTS5 `bm25()` for `ocr`/`all`. */
  scores = $state.raw(new Map<string, number>());
  private dedicatedFrameTimes = $state.raw<ReadonlyMap<string, number>>(new Map());
  /** Winning video samples from the visual lane only; other search modes keep their posters. */
  readonly matchingFrameTimes = $derived.by(() =>
    this.parsed.scope === "like"
      ? this.dedicatedFrameTimes
      : this.parsed.scope === "all"
        ? frameTimes(this.broadResults.visual.results)
        : EMPTY_FRAME_TIMES,
  );
  /** Session-only image examples. External bytes are never persisted or added to the catalog. */
  visualReferences = $state<VisualReferenceTerm[]>([]);
  visualReferenceRevision = $state(0);
  /**
   * Session state, deliberately not in the persisted settings store: the layout mode is a
   * preference, but how a particular search is being read is a mode, and it resets with the
   * library it belongs to.
   */
  sortMode = $state<SearchSortMode>("relevance");
  /** Separate semantic-engine cutoffs keep a user-adjusted text search from changing how
   * conservative a visual search starts, and vice versa. */
  private meaningMinMatchPercentile = $state(DEFAULT_MATCH_QUALITY);
  private clipMatchQuality = $state(DEFAULT_CLIP_MATCH_QUALITY);

  private filenameMatches = $state.raw<ReadonlySet<string> | null>(null);
  private filenameOrderedIds = $state.raw<string[]>([]);
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastLibraryId: LibraryId | null = null;
  /** `id -> item` for `rankItems`, memoized by array identity. `filterItemsByDates` returns the
   * same array reference when no date filter is active — the common case at 100k+ items — so
   * this reuses one Map across every keystroke instead of rebuilding it each time. */
  private readonly idIndexCache = new WeakMap<CatalogItem[], Map<string, CatalogItem>>();

  /** The parse every getter below reads; `parseQuery` is pure, so one derived serves them all. */
  private readonly parsed = $derived(parseQuery(this.query));
  private readonly searchBody = $derived(normalizeSearchBody(this.parsed.scope, this.parsed.body));

  /** 0-100 cutoff control value; it is a percentile for text meaning and logarithmic for CLIP. */
  get minMatchPercentile(): number {
    return this.parsed.scope !== "meaning" ? this.clipMatchQuality : this.meaningMinMatchPercentile;
  }

  set minMatchPercentile(value: number) {
    if (this.parsed.scope !== "meaning") this.clipMatchQuality = value;
    else this.meaningMinMatchPercentile = value;
  }

  /** Whether the search options strip has anything to offer for the current query. */
  get rankable(): boolean {
    return (
      Boolean(this.searchBody || this.activeVisualReferences.length) &&
      isRankableScope(this.parsed.scope)
    );
  }

  private get activeVisualReferences(): VisualReferenceTerm[] {
    return this.parsed.scope === "like" ? this.visualReferences : [];
  }

  setVisualReferences(references: VisualReferenceTerm[]): void {
    this.visualReferences = references.slice(0, 16);
    this.visualReferenceRevision += 1;
  }

  addLibraryReferences(
    items: ReadonlyArray<{ id: string; displayName: string }>,
    replace = false,
  ): void {
    if (!items.length) return;
    if (replace) {
      this.resetVisualSearch();
      this.query = "like:";
    } else {
      this.query = withScope(this.query, "like");
    }
    const known = new Set(this.visualReferences.map((reference) => reference.id));
    this.setVisualReferences([
      ...this.visualReferences,
      ...items
        .filter((item) => !known.has(`library-${item.id}`))
        .map((item) => ({
          id: `library-${item.id}`,
          source: "library" as const,
          assetId: item.id,
          displayName: item.displayName,
          polarity: "more" as const,
          strength: 1,
        })),
    ]);
    this.composerOpen = true;
  }

  addExternalReferences(items: readonly ExternalVisualReference[]): void {
    if (!items.length) return;
    this.query = withScope(this.query, "like");
    this.setVisualReferences([
      ...this.visualReferences,
      ...items.map((item, index) => ({
        id: `external-${crypto.randomUUID()}-${index}`,
        source: "external" as const,
        displayName: item.displayName,
        bytesBase64: item.bytesBase64,
        polarity: "more" as const,
        strength: 1,
      })),
    ]);
    this.composerOpen = true;
  }

  /** Relevance keeps the visual ranking intact; Date exposes the similarity cutoff. All's
   * separate fixed related-text filter is applied in both views and never shares this slider. */
  get sliderApplicable(): boolean {
    return (
      (this.parsed.scope === "all" ||
        this.parsed.scope === "meaning" ||
        this.parsed.scope === "like") &&
      this.sortMode === "date" &&
      Boolean(this.searchBody || this.activeVisualReferences.length) &&
      (this.allMode || !this.indexNotice)
    );
  }

  /**
   * A result set whose scores are all equal (a tiny index, or one document repeated) has no
   * percentile structure. Disable the control rather than let it pretend to filter.
   *
   * Derived rather than a getter because it walks the whole result set, and `apply()` reads it on
   * every pass.
   */
  readonly sliderDisabled = $derived.by(() => {
    if (this.allMode) {
      const hits = this.broadResults.visual.results;
      return hits.length < 2 || hits.every((hit) => hit.distance === hits[0].distance);
    }
    const ids = this.rankedIds;
    if (ids.length < 2) return true;
    const first = this.scores.get(ids[0]);
    if (first === undefined) return true;
    return ids.every((id) => this.scores.get(id) === first);
  });

  /**
   * The match set narrowed by the match-quality slider. Rank-based rather than score-based:
   * text-meaning search keeps the top `100 - p` percent, while CLIP keeps a logarithmic
   * `10^(-2p / 100)` share. That spreads CLIP's useful one-to-ten-percent neighbourhood across
   * the control instead of cramming it against the strict end. Position 100 still keeps the
   * single best match rather than emptying the gallery.
   */
  private readonly admittedMatches = $derived.by(() => {
    const matches = this.matches;
    if (!matches || this.minMatchPercentile <= 0 || this.sliderDisabled) return matches;
    const ranked = this.rankedIds;
    if (!ranked.length) return matches;
    const retainedShare =
      this.parsed.scope === "like"
        ? 10 ** ((-2 * this.minMatchPercentile) / 100)
        : (100 - this.minMatchPercentile) / 100;
    const admitted = Math.max(1, Math.ceil(ranked.length * retainedShare));
    return new Set(ranked.slice(0, admitted));
  });

  get pendingLabel(): string {
    switch (this.parsed.scope) {
      case "all":
        if (this.parsed.path && !this.searchBody) return "Searching paths…";
        return this.literalPending
          ? "Searching names and text…"
          : this.broadPending.meaning && this.broadPending.visual
            ? "Searching related text and images…"
            : this.broadPending.meaning
              ? "Searching related text…"
              : "Searching images…";
      case "ocr":
        return "Searching text…";
      case "name":
        return "Searching file names…";
      case "meaning":
        return "Searching related text…";
      case "like":
        return "Searching images…";
      default:
        return "";
    }
  }

  get queryHint(): string {
    return this.parsed.dates.some((date) => !date.valid) ? "Unrecognized date" : "";
  }

  /** Offer the semantic engine only after the literal default search has a settled result. */
  get shouldSuggestSemantic(): boolean {
    return false; // All now searches related text itself.
  }

  schedule(
    libraryId: LibraryId | null,
    items: CatalogItem[],
    timeline: Timeline,
    supportsImageTextQueries = true,
    hasOcr = true,
    hasImages = true,
  ): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.broadTimer) clearTimeout(this.broadTimer);
    void window.nicegal.backend.cancelSearch?.().catch(() => {});
    const searchSession = ++nextSearchSession;
    this.deferredResults = [];
    this.broadPending = { meaning: false, visual: false };
    this.broadResults = { meaning: { results: [], total: 0 }, visual: { results: [], total: 0 } };
    this.broadErrors = { meaning: "", visual: "" };
    // Sort mode and the percentile cutoff describe one library's result set, so they reset with
    // the library and survive edits to the query within it.
    if (libraryId !== this.lastLibraryId) {
      this.lastLibraryId = libraryId;
      this.sortMode = "relevance";
      this.meaningMinMatchPercentile = DEFAULT_MATCH_QUALITY;
      this.clipMatchQuality = DEFAULT_CLIP_MATCH_QUALITY;
    }
    const generation = ++this.generation;
    const { scope, body: rawBody, dates, ocrMode, folder, path } = this.parsed;
    const body = normalizeSearchBody(scope, rawBody);
    const references = scope === "like" ? this.visualReferences : [];
    const composedVisual = scope === "like" && (isVisualComposition(body) || references.length > 0);
    const visualTerms = composedVisual ? parseVisualTextTerms(body) : [];
    this.error = "";
    this.indexNotice = "";
    this.textSetupRequired = false;
    this.imageSetupRequired = false;
    this.semanticAvailable = false;
    this.pending = false;
    this.filePending = false;
    this.snippets = new Map<string, string>();
    this.filenameSnippets = new Map<string, string>();
    this.rankedIds = [];
    this.scores = new Map<string, number>();
    this.dedicatedFrameTimes = EMPTY_FRAME_TIMES;
    this.filenameMatches = new Set<string>();
    this.filenameOrderedIds = [];
    this.matches = new Set<string>();

    if (scope === "like" && body && !supportsImageTextQueries) {
      this.total = 0;
      this.error =
        "This model supports image examples only. Remove text descriptions and add an image example.";
      return;
    }

    if (!body && !references.length && !path) {
      this.filenameMatches = null;
      this.matches = null;
      this.total = items.length;
      return;
    }

    if ((scope === "name" && !!body) || (!body && !!path && !references.length)) {
      const fileScope = body && scope === "name" ? "name" : "path";
      const time = timeRangeForDates(dates);
      if (time === null) {
        this.total = 0;
        return;
      }
      if (libraryId === null) {
        this.error = "No library selected.";
        return;
      }
      this.filePending = true;
      this.timer = setTimeout(() => {
        void window.nicegal.backend
          .searchOcr({
            query: body || path || "",
            type: fileScope,
            libraryId,
            ...(folder ? { folder } : {}),
            ...(body && path ? { pathContains: path } : {}),
            limit: SEARCH_RESULT_LIMIT,
            searchSession,
            searchLane: "files",
            timeline,
            ...time,
          })
          .then(validateSearchResponse)
          .then((response) =>
            this.publish(generation, () => {
              const ids = response.results.map((result) => result.assetId);
              if (fileScope === "name") {
                this.filenameMatches = new Set(ids);
                this.filenameOrderedIds = ids;
                this.filenameSnippets = new Map(
                  response.results.map((result) => [result.assetId, result.snippet] as const),
                );
              } else {
                this.matches = new Set(ids);
                this.snippets = new Map(
                  response.results.map((result) => [result.assetId, result.snippet] as const),
                );
              }
              this.total = response.total;
              if (response.total > response.results.length)
                this.indexNotice = "Result limit reached; narrow the search by date.";
            }),
          )
          .catch((error: unknown) =>
            this.publish(generation, () => {
              this.error = searchErrorMessage(error);
            }),
          )
          .finally(() =>
            this.publish(generation, () => {
              this.filePending = false;
            }),
          );
      }, SEARCH_DEBOUNCE_MS);
      return;
    }

    if (scope === "like" && !hasImages) {
      this.imageSetupRequired = true;
      this.indexNotice = "Visual search is not ready for this library yet.";
      this.total = 0;
      return;
    }

    this.pending = true;
    this.filePending = scope === "all" || scope === "meaning";
    const time = timeRangeForDates(dates);
    // Fast literal results need not wait for either embedder. Each lane owns its completion and
    // error state; one failed or unavailable engine must never discard successful sibling results.
    // The shared session cancels obsolete work; the renderer generation also guards late replies.
    if (scope === "all" && libraryId !== null && time !== null) {
      this.broadPending = { meaning: hasOcr, visual: supportsImageTextQueries && hasImages };
      this.broadTimer = setTimeout(() => {
        for (const lane of ["meaning", "visual"] as const) {
          if (lane === "meaning" && !hasOcr) continue;
          if (lane === "visual" && (!supportsImageTextQueries || !hasImages)) continue;
          void window.nicegal.backend
            .searchOcr({
              query: body,
              libraryId,
              ...(folder ? { folder } : {}),
              ...(path ? { pathContains: path } : {}),
              timeline,
              ...time,
              type: lane === "meaning" ? "vector" : "image",
              limit: lane === "meaning" ? ALL_RELATED_RESULT_LIMIT : SEARCH_RESULT_LIMIT,
              searchSession,
              searchLane: lane,
            })
            .then(validateSearchResponse)
            .then((response) =>
              this.publish(generation, () => {
                if (generation !== this.generation) return;
                this.broadResults = { ...this.broadResults, [lane]: response };
                if (lane === "visual" && response.total > response.results.length)
                  this.broadErrors[lane] = "Result limit reached; narrow the search by date.";
              }),
            )
            .catch((error: unknown) =>
              this.publish(generation, () => {
                if (generation !== this.generation) return;
                console.warn(`${lane} search failed`, error);
                this.broadErrors[lane] =
                  lane === "visual"
                    ? "Visual search unavailable. Try again."
                    : "Related text unavailable. Try again.";
              }),
            )
            .finally(() =>
              this.publish(generation, () => {
                if (generation === this.generation) this.broadPending[lane] = false;
              }),
            );
        }
      }, 400);
    }
    this.timer = setTimeout(
      () => {
        if ((scope === "all" || scope === "meaning") && libraryId !== null) {
          const fileTime = timeRangeForDates(dates);
          if (fileTime !== null) {
            void window.nicegal.backend
              .searchOcr({
                query: body,
                type: "name",
                libraryId,
                ...(folder ? { folder } : {}),
                ...(path ? { pathContains: path } : {}),
                limit: SEARCH_RESULT_LIMIT,
                searchSession,
                searchLane: "files",
                timeline,
                ...fileTime,
              })
              .then(validateSearchResponse)
              .then((response) =>
                this.publish(generation, () => {
                  this.filenameOrderedIds = response.results.map((result) => result.assetId);
                  this.filenameMatches = new Set(this.filenameOrderedIds);
                  this.filenameSnippets = new Map(
                    response.results.map((result) => [result.assetId, result.snippet] as const),
                  );
                  if (scope === "all" && !hasOcr) this.total = response.total;
                  if (response.total > response.results.length)
                    this.indexNotice = "Result limit reached; narrow the search by date.";
                }),
              )
              .catch((error: unknown) =>
                this.publish(generation, () => {
                  this.error = searchErrorMessage(error);
                }),
              )
              .finally(() =>
                this.publish(generation, () => {
                  this.filePending = false;
                }),
              );
          } else {
            this.filePending = false;
          }
        } else {
          this.filePending = false;
        }

        if (scope === "all" && !hasOcr) {
          this.pending = false;
          return;
        }

        const time = timeRangeForDates(dates);
        if (time === null) {
          this.matches = new Set<string>();
          this.total = 0;
          this.pending = false;
          return;
        }

        if (libraryId === null) {
          this.error = "No library selected.";
          this.pending = false;
          return;
        }

        // All's primary lane is literal OCR; its independent broader lanes were scheduled above.
        // Dedicated meaning: and like: searches use this single-lane path, including compositions.
        const searchType =
          scope === "meaning"
            ? "vector"
            : scope === "like"
              ? "image"
              : ocrMode === "glob"
                ? "ocrGlob"
                : "ocrMatch";
        // `terms` and `raw` share the `match` mode, so a `terms` body must be quoted on the way
        // out — unquoted, FTS5 would parse `12:30` as a column filter and reject it.
        const searchQuery =
          searchType === "ocrMatch" && ocrMode === "terms" ? quoteFtsTerms(body) : body;
        const runSearch = (): void => {
          const visualComponents = [
            ...visualTerms.map((term) => ({
              text: term.text,
              weight: term.polarity === "more" ? term.strength : -term.strength,
            })),
            ...references.map((reference) => {
              const weight =
                reference.polarity === "more" ? reference.strength : -reference.strength;
              if (reference.source === "library")
                return { assetId: Number(reference.assetId), weight };
              return { externalImage: { bytesBase64: reference.bytesBase64 ?? "" }, weight };
            }),
          ];
          void window.nicegal.backend
            .searchOcr({
              query: composedVisual ? "" : searchQuery,
              type: searchType,
              libraryId,
              ...(folder ? { folder } : {}),
              ...(path ? { pathContains: path } : {}),
              limit: SEARCH_RESULT_LIMIT,
              searchSession,
              searchLane: "literal",
              timeline,
              ...time,
              ...(composedVisual
                ? {
                    imageQuery: {
                      components: visualComponents,
                    },
                  }
                : {}),
            })
            .then(validateSearchResponse)
            .then((response) =>
              this.publish(generation, () => {
                if (generation !== this.generation) return;
                this.matches = new Set(response.results.map((result) => result.assetId));
                this.snippets = new Map(
                  response.results.map((result) => [result.assetId, result.snippet] as const),
                );
                // The response is already in the backend's final rank order (reranked server-side),
                // so relevance order is response order — nothing to re-sort. A server without `rank`
                // simply leaves that order as the only signal, which is the graceful degradation.
                this.rankedIds = response.results.map((result) => result.assetId);
                this.scores = new Map(
                  response.results.flatMap((result) => {
                    const score = result.distance ?? result.score;
                    return score === undefined ? [] : [[result.assetId, score] as const];
                  }),
                );
                if (scope === "like") this.dedicatedFrameTimes = frameTimes(response.results);
                this.total = response.total;
                if (response.total > response.results.length)
                  this.indexNotice = "Result limit reached; narrow the search by date.";
              }),
            )
            .catch((error: unknown) =>
              this.publish(generation, () => {
                if (generation !== this.generation) return;
                const message = searchErrorMessage(error);
                console.warn("Search failed", error);
                this.error =
                  scope === "like" &&
                  /model.*not ready|prepare.*search|prepar.*model/i.test(message)
                    ? "Visual search needs preparation. Open Library manager and rescan the library."
                    : scope === "all" && !isQuerySyntaxError(message)
                      ? "Text search unavailable. Try again."
                      : message;
              }),
            )
            .finally(() =>
              this.publish(generation, () => {
                if (generation === this.generation) this.pending = false;
              }),
            );
        };

        // Image availability is supplied from the selected library's coverage above.
        if (scope === "like") {
          runSearch();
          return;
        }

        const coverageRequest = window.nicegal.backend.getTextEmbeddingCoverage(libraryId);

        // `meaning` needs embeddings; `ocr` and `all` only need OCR text, so they gate on
        // `indexed` instead — an un-embedded-but-OCR'd library should still search fine.
        void coverageRequest
          .then((response) => {
            if (generation !== this.generation) return;
            this.semanticAvailable = response.embedded > 0;
            const notIndexed =
              scope === "meaning" ? response.embedded === 0 : response.indexed === 0;
            if (notIndexed) {
              this.textSetupRequired = true;
              this.indexNotice = "Text search hasn’t been set up for this library.";
              this.matches = new Set<string>();
              this.snippets = new Map<string, string>();
              this.total = this.filenameMatches?.size ?? 0;
              this.pending = false;
              return;
            }
            runSearch();
          })
          .catch(() => {
            if (generation === this.generation) runSearch();
          });
      },
      composedVisual ? 250 : SEARCH_DEBOUNCE_MS,
    );
  }

  /**
   * Turns the catalog into what the gallery should render for the current query.
   *
   * Two shapes come out of here. In date sort the result is a membership filter over the
   * date-ordered catalog, exactly as it always was — dividers and virtualization see the order
   * they expect. In relevance sort it is a re-ordered array, best match first, which
   * `VirtualGallery` renders as happily as any other order because layout consumes the array.
   */
  apply(items: CatalogItem[]): SearchView {
    const { scope, dates, media, folder, path } = this.parsed;
    const body = this.searchBody;
    const dated = filterItemsByDates(items, dates);
    const focused = folder ? dated.filter((item) => pathIsInFolder(item.path, folder)) : dated;
    const eligible = media ? focused.filter((item) => item.mediaKind === media) : focused;
    const filtering = this.query.length > 0;
    if (!body && !this.activeVisualReferences.length && path)
      return {
        items: filterItems(eligible, this.matches),
        matchTotal: filterItems(eligible, this.matches).length,
        filtering,
      };
    if (!body && !this.activeVisualReferences.length)
      return { items: eligible, matchTotal: eligible.length, filtering };

    if (scope === "all") return this.applyAll(eligible, filtering);

    if (this.sortMode === "relevance" && isRankableScope(scope)) {
      const ranked = this.rankItems(eligible, scope);
      return {
        items: ranked,
        matchTotal: ranked.length,
        filtering,
      };
    }

    const filtered = this.filterByScope(eligible, scope);
    return { items: filtered, matchTotal: filtered.length, filtering };
  }

  private applyAll(items: CatalogItem[], filtering: boolean): SearchView {
    const literal = this.rankItems(items, "all");
    const relatedHits = this.broadResults.meaning.results;
    const related = relatedHits.slice(0, ALL_RELATED_RESULT_LIMIT);
    const visualHits = this.broadResults.visual.results;
    const visualCount =
      this.sortMode === "date" && !this.sliderDisabled
        ? Math.max(1, Math.ceil(visualHits.length * 10 ** ((-2 * this.clipMatchQuality) / 100)))
        : visualHits.length;
    const visual = visualHits.slice(0, visualCount);
    const sources = new Map<string, string>();
    const groups: GallerySection[] = [];
    const combined: CatalogItem[] = [];
    // First source wins placement, not membership. Keep all contributing source labels, but one
    // image/selection target. Filtering CLIP before this union cannot remove an admitted text hit.
    const add = (key: string, label: string, ids: string[], status: string): void => {
      const start = combined.length;
      const byId = ids.length ? this.idIndex(items) : undefined;
      for (const id of ids) {
        const item = byId?.get(id);
        if (!item) continue;
        const existing = sources.get(id);
        if (!existing?.split(", ").includes(label))
          sources.set(id, existing ? `${existing}, ${label}` : label);
        if (!existing) combined.push(item);
      }
      const count = combined.length - start;
      if (count > 0) groups.push({ key, label, start, count, status });
    };
    add(
      "literal",
      "Names and text",
      [...literal.map((item) => item.id), ...related.map((hit) => hit.assetId)],
      [
        this.literalPending || this.broadPending.meaning ? "Searching…" : "",
        this.error || this.indexNotice,
        this.broadErrors.meaning,
      ]
        .filter(Boolean)
        .join(" · "),
    );
    add(
      "visual",
      "Visual results",
      visual.map((hit) => hit.assetId),
      this.broadPending.visual ? "Searching…" : this.broadErrors.visual,
    );
    return {
      items: this.sortMode === "date" ? items.filter((item) => sources.has(item.id)) : combined,
      sections: this.sortMode === "relevance" ? groups : undefined,
      sources,
      matchTotal: combined.length,
      filtering,
    };
  }

  /** Date sort: pure set membership, unchanged apart from the percentile cutoff on `meaning`. */
  private filterByScope(items: CatalogItem[], scope: SearchScope): CatalogItem[] {
    if (scope === "name") return filterItems(items, this.filenameMatches);
    if (scope === "ocr") return filterItems(items, this.matches);
    if (scope === "like") return filterItems(items, this.admittedMatches);
    if (scope === "meaning") {
      return this.indexNotice && !this.rankedIds.length
        ? filterItems(items, this.filenameMatches)
        : filterItems(items, this.admittedMatches);
    }
    const filenameMatches = this.filenameMatches;
    const ocrMatches = this.matches;
    return filenameMatches === null && ocrMatches === null
      ? items
      : items.filter((item) => filenameMatches?.has(item.id) || ocrMatches?.has(item.id));
  }

  private idIndex(items: CatalogItem[]): Map<string, CatalogItem> {
    let index = this.idIndexCache.get(items);
    if (!index) {
      index = new Map(items.map((item) => [item.id, item] as const));
      this.idIndexCache.set(items, index);
    }
    return index;
  }

  /**
   * Relevance sort: ranked hits in the backend's order, then — for scope `all` only — the
   * filename matches it never saw, appended alphabetically. Those have no ranking signal at all
   * (a substring either occurs or it doesn't), so interleaving them by a made-up score would be
   * worse than admitting they are a separate, exact kind of hit.
   */
  private rankItems(
    items: CatalogItem[],
    scope: "all" | "ocr" | "meaning" | "like",
  ): CatalogItem[] {
    if (!this.rankedIds.length && !this.filenameMatches?.size) return [];
    const byId = this.idIndex(items);
    const ranked: CatalogItem[] = [];
    // No index leaves rankedIds empty. A response-limit notice, however, must not discard the
    // usable partial ranking that did arrive.
    for (const id of this.rankedIds) {
      const item = byId.get(id);
      if (item) ranked.push(item);
    }
    if (scope === "ocr" || scope === "like") return ranked;

    const filenameMatches = this.filenameMatches;
    if (!filenameMatches?.size) return ranked;
    if (scope === "meaning" && (ranked.length || !this.indexNotice)) return ranked;

    const claimed = new Set(ranked.map((item) => item.id));
    // The backend already sorted filename hits, so only membership and catalog lookup remain here.
    const filenameOnly: CatalogItem[] = [];
    for (const id of this.filenameOrderedIds) {
      if (claimed.has(id)) continue;
      const item = byId.get(id);
      if (item) filenameOnly.push(item);
    }
    return [...ranked, ...filenameOnly];
  }

  dispose(): void {
    this.suspend();
  }

  /** Preserve the query while the service is unavailable, and ignore obsolete responses. */
  suspend(): void {
    this.generation += 1;
    this.deferredResults = [];
    if (this.interactionRelease) clearTimeout(this.interactionRelease);
    this.interacting = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.broadTimer) clearTimeout(this.broadTimer);
    void window.nicegal.backend.cancelSearch?.().catch(() => {});
    this.broadPending = { meaning: false, visual: false };
    this.timer = null;
    this.pending = false;
    this.filePending = false;
    this.error = "";
  }
}

function pathIsInFolder(path: string, folder: string): boolean {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(folder);
  const normalize = (value: string): string => {
    const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
    return windows ? normalized.toLowerCase() : normalized;
  };
  return normalize(path).startsWith(`${normalize(folder)}/`);
}

function normalizeSearchBody(scope: SearchScope, rawBody: string): string {
  const body = rawBody.trim();
  // A lone `ocr"` is a mistyped `ocr:` prefix, not a query: without the colon it stays in scope
  // "all", where the odd quote reads as raw FTS5 syntax and fires a broken query mid-typing.
  // Treat it as empty.
  if (!body || (scope === "all" && /^ocr"\s*$/i.test(body))) return "";
  // Half-typed weights such as `like: 2:` have no searchable component yet.
  if (scope === "like" && isVisualComposition(body) && !parseVisualTextTerms(body).length)
    return "";
  return scope === "name" || hasSearchText(body) ? body : "";
}

/** Wraps each whitespace-separated word of a `terms` body in FTS5 string literals (doubling any
 * embedded quote), so characters FTS5 treats as syntax — a colon, a leading hyphen — are matched
 * literally instead of parsed. Quoted words still AND together, which is what `terms` means. */
function quoteFtsTerms(body: string): string {
  return body
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" ");
}

function hasSearchText(body: string): boolean {
  let inQuotes = false;
  let unquoted = "";
  for (const char of body) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (inQuotes && /[\p{L}\p{N}]/u.test(char)) {
      return true;
    } else if (!inQuotes) {
      unquoted += char;
    }
  }
  return /[\p{L}\p{N}]/u.test(unquoted.replace(/\b(?:AND|OR|NOT|NEAR)(?:\/\d+)?\b/g, ""));
}

function filterItems(items: CatalogItem[], matches: ReadonlySet<string> | null): CatalogItem[] {
  return matches === null ? items : items.filter((item) => matches.has(item.id));
}

function filterItemsByDate(items: CatalogItem[], from: string, to: string): CatalogItem[] {
  const fromMs = Date.parse(`${from}T00:00:00`);
  const toMs = Date.parse(`${to}T23:59:59.999`);
  return items.filter((item) => item.date >= fromMs && item.date <= toMs);
}

type DateIntersection = { from: string; to: string; hasValidDate: boolean };

/**
 * Intersects every valid date filter down to a single `[from, to]` range, using the
 * "0000-01-01"/"9999-12-31" sentinels to mean "unbounded on this side". Shared by
 * `filterItemsByDates` (client-side filtering) and `timeRangeForDates` (backend request
 * bounds) — they apply the resulting range differently, but the intersection itself is
 * identical.
 */
function intersectDateFilters(dates: DateFilter[]): DateIntersection {
  let from = "0000-01-01";
  let to = "9999-12-31";
  let hasValidDate = false;
  for (const date of dates) {
    if (!date.valid) continue;
    hasValidDate = true;
    if (date.from > from) from = date.from;
    if (date.to < to) to = date.to;
  }
  return { from, to, hasValidDate };
}

function filterItemsByDates(items: CatalogItem[], dates: DateFilter[]): CatalogItem[] {
  const { from, to, hasValidDate } = intersectDateFilters(dates);
  return hasValidDate ? filterItemsByDate(items, from, to) : items;
}

/**
 * The API accepts nanosecond instants, while the query language accepts local calendar periods.
 * Date filters intersect, and the API's half-open range represents that intersection exactly.
 */
function timeRangeForDates(dates: DateFilter[]): { after?: string; before?: string } | null {
  const { from, to, hasValidDate } = intersectDateFilters(dates);
  if (!hasValidDate) return {};
  if (from > to) return null;

  return {
    ...(from === "0000-01-01" ? {} : { after: localDateToNs(from) }),
    ...(to === "9999-12-31" ? {} : { before: localDateToExclusiveNs(to) }),
  };
}
