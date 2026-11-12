import { v4 as uuid } from "@lukeed/uuid";

import type { OcrSearchController } from "./ocr-search.svelte";
import type { OverlayHistory } from "./overlay-history";
import type { VisualReferenceTerm } from "./visual-query";

import { SEARCH_HISTORY_STORAGE_KEY } from "./constants";
import { isRememberable, searchStepRelation, withRecent, type SearchStep } from "./search-history";
import { parseQuery } from "./search-query";

/** How long a query must stay unchanged while typing before it becomes a Back step. */
const SETTLE_MS = 1200;

/** What a base history entry stores. Visual examples stay in memory: external ones carry image
 * bytes, and none of them outlive the session. */
interface SearchEntryState {
  search: { id: string; query: string };
}

interface CurrentStep extends SearchStep {
  id: string;
  /** This step put its query into the recent list, so refining it in place takes it back out. */
  addedToRecent: boolean;
}

function readRecent(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function entryState(state: unknown): SearchEntryState["search"] | null {
  const search = (state as Partial<SearchEntryState> | null)?.search;
  return search && typeof search.id === "string" && typeof search.query === "string"
    ? search
    : null;
}

/**
 * Search history in two forms. Each settled search is a browser history entry below any
 * overlays, so Back and Forward (keys, mouse buttons, a phone's back gesture) move between
 * searches. Queries with text are also kept in a persisted recent list for the search field's
 * dropdown.
 */
export class SearchHistory {
  /** Most recent first. */
  recent = $state<string[]>(readRecent());

  readonly #search: OcrSearchController;
  readonly #overlays: OverlayHistory;
  #current: CurrentStep;
  /** Visual examples of entries from this session, by entry ID. Nothing renders from it. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  readonly #references = new Map<string, VisualReferenceTerm[]>();
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(search: OcrSearchController, overlays: OverlayHistory) {
    this.#search = search;
    this.#overlays = overlays;
    this.#current = this.#step(false);
    this.#write(false);
    overlays.onBaseTraversal((state) => this.#restore(state));
  }

  /** The query or its visual examples changed; record it once it settles. */
  noteChange(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.commit(false), SETTLE_MS);
  }

  /**
   * Records the live search now. `final` marks a deliberate point (Enter, leaving the field,
   * opening a result, choosing a recent search) after which further typing is a new Back step.
   */
  commit(final = true): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const next = this.#step(!final);
    const relation = searchStepRelation(this.#current, next);
    if (relation === "same") {
      if (final) this.#current.provisional = false;
      return;
    }
    if (relation === "replace") {
      if (this.#current.addedToRecent) this.#forget(this.#current.query.trim());
      this.#references.delete(this.#current.id);
    }
    this.#current = next;
    this.#write(relation === "push");
    if (isRememberable(next.query, next.referenceIds.length)) {
      const text = next.query.trim();
      next.addedToRecent = !this.recent.includes(text);
      this.#setRecent(withRecent(this.recent, text));
    }
  }

  /** The live search was replaced without a user edit, as when a library's view is restored.
   * It takes over the current entry instead of adding a Back step. */
  adopt(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#current = this.#step(false);
    this.#write(false);
  }

  /** Runs `query` from the recent list as a new step. */
  run(query: string): void {
    this.#search.resetVisualSearch();
    this.#search.query = query;
    this.commit(true);
  }

  remove(query: string): void {
    this.#forget(query);
    if (this.#current.query.trim() === query) this.#current.addedToRecent = false;
  }

  clearRecent(): void {
    this.#setRecent([]);
    this.#current.addedToRecent = false;
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#overlays.onBaseTraversal(() => {});
  }

  #forget(query: string): void {
    if (this.recent.includes(query)) this.#setRecent(this.recent.filter((q) => q !== query));
  }

  #setRecent(recent: string[]): void {
    this.recent = recent;
    try {
      localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(recent));
    } catch {
      // Best-effort persistence only.
    }
  }

  #liveReferences(): VisualReferenceTerm[] {
    return parseQuery(this.#search.query).scope === "like" ? this.#search.visualReferences : [];
  }

  #step(provisional: boolean): CurrentStep {
    return {
      id: uuid(),
      query: this.#search.query,
      referenceIds: this.#liveReferences().map((reference) => reference.id),
      provisional,
      addedToRecent: false,
    };
  }

  #write(push: boolean): void {
    const references = this.#liveReferences();
    if (references.length) this.#references.set(this.#current.id, [...references]);
    const state: SearchEntryState = {
      search: { id: this.#current.id, query: this.#current.query },
    };
    this.#overlays.setBase(state, push);
  }

  /** Back or Forward landed on another search. */
  #restore(state: unknown): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    // An entry from before a reload has no search; it stands for the field as it was then,
    // which is unknown, so leave the live search alone.
    const entry = entryState(state);
    if (!entry) return;
    const references = this.#references.get(entry.id) ?? [];
    this.#search.resetVisualSearch();
    this.#search.query = entry.query;
    if (references.length) this.#search.setVisualReferences(references);
    this.#current = {
      id: entry.id,
      query: entry.query,
      referenceIds: references.map((reference) => reference.id),
      provisional: false,
      addedToRecent: false,
    };
  }
}
