import { SvelteMap } from "svelte/reactivity";
import { get } from "svelte/store";

import type {
  BackendStatus,
  GalleryAsset,
  ImageEmbeddingCoverage,
  Library,
  LibraryDefinition,
  LibraryId,
  Timeline,
} from "../../../shared/backend";

import {
  LIBRARIES_STORAGE_KEY,
  LIBRARY_ROOT_STORAGE_KEY,
  LIBRARY_VIEWS_STORAGE_KEY,
} from "./constants";
import { errorMessage } from "./errors";
import { aspectRatioOf, type GalleryItem } from "./gallery/types";
import { folderName, rootKey, rootsMatch } from "./library-root";
import { libraryIndexing, settings, type GallerySettings } from "./settings.svelte";

/** Frontend preferences for one backend library: its optional name and restorable view. */
export interface LibraryViewState {
  /** User-chosen name; null shows a name derived from the folders. */
  name: string | null;
  /** The unparsed search text, so a library restores exactly what the user entered. */
  query: string;
  scrollTop: number;
}

/** A backend library joined with its name. Query and scroll position are deliberately absent:
 * they change on every scroll and are read only when a library view is restored, so they live
 * outside reactive state (see `CatalogController.viewState`). */
export interface LibraryRecord extends Library {
  /** User-chosen name; null shows a name derived from the folders. */
  name: string | null;
  displayName: string;
}

export type LibraryViewStatePatch = Partial<LibraryViewState>;

/** Independent catalog and embedding counts rendered beside each library. */
export interface LibraryRowStatus {
  imageCoverage?: ImageEmbeddingCoverage | null;
  cataloged: number;
  indexed: number;
  embedded: number;
  pending: number;
  /** Unix seconds of the newest indexed file in the library; null when the backend has none. */
  lastIndexedAt: number | null;
  loading: boolean;
  error: string | null;
}

/** Persisted as `LIBRARY_VIEWS_STORAGE_KEY`. Backend library IDs key every entry. */
interface LibraryViewRegistry {
  selectedId: LibraryId | null;
  views: Record<string, LibraryViewState>;
  /** Set once every v2 registry root has been imported into the backend. */
  importedV2: boolean;
}

/** One record of the retired `nicegal.libraries.v2` registry, kept as rollback material. */
interface V2LibraryRecord {
  root: string;
  displayName: string;
  query: string;
  scrollTop: number;
}

function emptyLibraryRowStatus(): LibraryRowStatus {
  return {
    cataloged: 0,
    indexed: 0,
    embedded: 0,
    pending: 0,
    lastIndexedAt: null,
    loading: false,
    error: null,
  };
}

// The main process (`nicegal-server-client.ts#getTextEmbeddingCoverage`) already validates this
// shape before it crosses IPC. IPC types are erased at runtime, so this cheap re-check keeps a
// future main-side change or stubbed backend from handing an untyped value straight through.
function statusCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid text embedding coverage ${field} count`);
  }
  return value;
}

function normalizeTextEmbeddingCoverage(
  value: unknown,
): Pick<LibraryRowStatus, "indexed" | "embedded" | "pending" | "lastIndexedAt"> {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid text embedding coverage response");
  }
  const coverage = value as Record<string, unknown>;
  return {
    indexed: statusCount(coverage.indexed, "indexed"),
    embedded: statusCount(coverage.embedded, "embedded"),
    pending: statusCount(coverage.pending, "pending"),
    // Unlike the counts, a missing timestamp is legitimate — an unindexed library has none.
    lastIndexedAt:
      typeof coverage.lastIndexedAt === "number" && Number.isFinite(coverage.lastIndexedAt)
        ? coverage.lastIndexedAt
        : null,
  };
}

/** The label shown when the user has not named a library: its first folder, plus a count. */
export function derivedLibraryName(include: readonly { path: string }[]): string {
  if (!include.length) return "Library";
  const first = folderName(include[0].path);
  return include.length > 1 ? `${first} + ${include.length - 1}` : first;
}

function normalizeViewState(value: unknown): LibraryViewState {
  const record = (value && typeof value === "object" ? value : {}) as Partial<LibraryViewState>;
  return {
    name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : null,
    query: typeof record.query === "string" ? record.query : "",
    scrollTop:
      typeof record.scrollTop === "number" && Number.isFinite(record.scrollTop)
        ? Math.max(0, record.scrollTop)
        : 0,
  };
}

function emptyViewState(): LibraryViewState {
  return { name: null, query: "", scrollTop: 0 };
}

function isLibraryId(value: unknown): value is LibraryId {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** The v2 registry and the older single-root key, in their stored order. */
function readV2Registry(): { libraries: V2LibraryRecord[]; selectedRoot: string } {
  const libraries: V2LibraryRecord[] = [];
  let selectedRoot = "";
  try {
    const serialized = localStorage.getItem(LIBRARIES_STORAGE_KEY);
    if (serialized !== null) {
      const value = JSON.parse(serialized) as { libraries?: unknown; selectedRoot?: unknown };
      if (typeof value?.selectedRoot === "string") selectedRoot = value.selectedRoot;
      for (const entry of Array.isArray(value?.libraries) ? value.libraries : []) {
        const record = entry as Partial<V2LibraryRecord>;
        const root = typeof record?.root === "string" ? record.root.trim() : "";
        if (!root || libraries.some((library) => rootsMatch(library.root, root))) continue;
        const view = normalizeViewState(record);
        libraries.push({
          root,
          displayName: typeof record.displayName === "string" ? record.displayName.trim() : "",
          query: view.query,
          scrollTop: view.scrollTop,
        });
      }
    } else {
      const legacyRoot = localStorage.getItem(LIBRARY_ROOT_STORAGE_KEY)?.trim();
      if (legacyRoot) {
        libraries.push({ root: legacyRoot, displayName: "", query: "", scrollTop: 0 });
        selectedRoot = legacyRoot;
      }
    }
  } catch {
    // Unreadable rollback data imports nothing; the backend list remains authoritative.
  }
  return { libraries, selectedRoot };
}

/**
 * Owns the asset catalog: backend library definitions, the selected library, what's loaded from
 * it, per-library view preferences, and the polling/refresh plumbing that keeps the catalog in
 * sync with catalog-mutating jobs.
 *
 * The backend owns library membership (included and excluded folders, search types). The
 * renderer keeps only view preferences keyed by library ID. Application owns cross-controller
 * job and library orchestration.
 */
export class CatalogController {
  /** Catalog snapshots are replaced as a whole. Avoid deep proxies for tens of thousands of
   * immutable rows; publish a new array if an asset changes. */
  items = $state.raw<GalleryItem[]>([]);
  loading = $state(true);
  loadError = $state("");
  backendStatus = $state<BackendStatus>({ ready: false, error: null });
  /** Backend definitions in creation order; replaced as a whole on every load. */
  definitions = $state.raw<Library[]>([]);
  /** Set once the definitions have been read from a ready backend. */
  librariesLoaded = $state(false);
  librariesError = $state("");
  /** The selected library, or null when no libraries exist. */
  selectedId = $state<LibraryId | null>(null);
  /** Persisted view preferences. Plain, not `$state`: scroll saves must not invalidate anything
   * that renders libraries. Names are mirrored reactively in `names`. */
  private views: Record<string, LibraryViewState> = {};
  /** User-chosen library names, the only view preference the UI renders. */
  private names = $state.raw<Record<string, string>>({});
  private importedV2 = false;

  /** Every library, joined with its name. */
  readonly libraries: LibraryRecord[] = $derived(
    this.definitions.map((library) => {
      const name = this.names[library.id] ?? null;
      return { ...library, name, displayName: name ?? derivedLibraryName(library.include) };
    }),
  );
  readonly selectedLibrary: LibraryRecord | undefined = $derived(
    this.libraries.find((library) => library.id === this.selectedId),
  );
  /**
   * Per-library counts used by the libraries pane. `SvelteMap` gives fine-grained reactivity for
   * single-row updates without copying the whole map on every row change.
   */
  libraryStatuses = new SvelteMap<LibraryId, LibraryRowStatus>();

  /** Timeline field the currently-loaded `items` were sorted/grouped by; `null` until first load. */
  private loadedTimeline: Timeline | null = null;
  /** Backend catalog revision as of the last successful load, used only for change polling. */
  private catalogRevision = $state("");
  /** Bumped on every started load; a response that lands after a newer one starts is dropped. */
  private generation = 0;
  /** Library and timeline of the load in flight, so a repeat request coalesces into it. */
  private inFlightRefresh: string | null = null;
  /** A repeat request arrived during the load in flight; load once more when it lands. */
  private refreshAgain = false;
  /** Bumped on every library-list load; an overtaken list response is dropped. */
  private librariesGeneration = 0;
  /** Cache-busting counter stamped onto items, advanced whenever a job regenerates thumbnails. */
  private thumbnailRevision = $state(0);
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Prevents the two-second revision interval from stacking requests behind a slow backend. */
  private revisionPollPending = false;
  /** Invalidates every outstanding row-status pass when a newer pass starts. */
  private libraryStatusGeneration = 0;
  /** Invalidates status completions for one library when its cataloged count can change. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- generation counters are private bookkeeping, never read reactively by the UI
  private readonly libraryStatusIdGenerations = new Map<LibraryId, number>();
  /** Set when a catalog load supersedes row-status work; the winning catalog load retries it. */
  private libraryStatusRefreshRequested = false;

  /**
   * @param onSelectionChanged Called when the selection moves from one library to another,
   *   whether the user picked it or a deletion or reload replaced it. Not called for the first
   *   selection a load makes from nothing.
   */
  constructor(
    private readonly onSelectionChanged: (
      previous: LibraryId,
      next: LibraryId | null,
    ) => void = () => {},
  ) {
    const registry = this.loadViewRegistry();
    this.setViews(registry.views);
    this.selectedId = registry.selectedId;
    this.importedV2 = registry.importedV2;
  }

  /** Fetches backend status and, if ready, loads libraries and the catalog. Call once. */
  async initialize(): Promise<void> {
    this.backendStatus = await window.nicegal.backend.getBackendStatus();
    if (this.backendStatus.ready) await this.loadLibraries();
    else this.loading = false;
  }

  /** Applies a status pushed live from the main process — today, only an nicegal-server crash.
   * See `onBackendStatusChanged` wiring in `application.svelte.ts`. */
  applyBackendStatus(status: BackendStatus): void {
    this.backendStatus = status;
  }

  /**
   * Reads the backend's library definitions, importing any v2 registry first. Keeps the current
   * selection when it still exists, otherwise selects the first library, and reloads the catalog
   * only when the selection changed or nothing is loaded yet.
   */
  async loadLibraries(): Promise<void> {
    if (!this.backendStatus.ready) return;
    const generation = ++this.librariesGeneration;
    try {
      if (!this.importedV2) await this.importV2Registry();
      const definitions = await window.nicegal.backend.listLibraries();
      if (generation !== this.librariesGeneration) return;
      this.librariesError = "";
      // Reloaded after every job; an unchanged list must not rebuild every library record.
      if (JSON.stringify(definitions) !== JSON.stringify(this.definitions) || this.generation === 0)
        this.applyDefinitions(definitions);
    } catch (error) {
      if (generation !== this.librariesGeneration) return;
      this.librariesError = errorMessage(error);
      this.loading = false;
    } finally {
      if (generation === this.librariesGeneration) this.librariesLoaded = true;
    }
  }

  /**
   * Re-loads `items` from the backend. A load of a different library or timeline supersedes one
   * in flight; a repeat request for the same one coalesces into a single follow-up load, so
   * frequent requests during a scan cannot keep restarting a large catalog load.
   */
  async refresh(timeline: Timeline = get(settings).sortField): Promise<void> {
    if (!this.backendStatus.ready) return;
    const key = `${this.selectedId}:${timeline}`;
    if (this.inFlightRefresh === key) {
      this.refreshAgain = true;
      return;
    }
    this.inFlightRefresh = key;
    this.refreshAgain = false;
    const generation = ++this.generation;
    this.loading = true;
    this.loadError = "";
    const libraryId = this.selectedId;
    if (libraryId !== null) this.invalidateLibraryStatusRequest(libraryId);
    if (libraryId === null) {
      this.items = [];
      this.catalogRevision = "";
      this.loadedTimeline = null;
      this.loading = false;
      this.inFlightRefresh = null;
      return;
    }
    try {
      // A revision read after the rows could describe an insertion absent from those rows.
      // Keep the earlier revision so polling detects any change during the load.
      const revision = await window.nicegal.backend.getCatalogRevision();
      if (generation !== this.generation) return;
      const assets = await window.nicegal.backend.listAssets({ libraryId, timeline });
      if (generation !== this.generation) return;
      this.items = assets.map((asset) => this.mapGalleryAsset(asset, timeline));
      // Record what was actually loaded so `onSettingsChange` can tell a real sort-field change
      // from a settings emission that leaves the loaded timeline untouched.
      this.loadedTimeline = timeline;
      this.updateSelectedCatalogCount();
      this.catalogRevision = revision;
    } catch (error) {
      if (generation === this.generation) {
        const message = errorMessage(error);
        this.loadError = message;
        this.updateLibraryStatus(libraryId, {
          ...this.statusFor(libraryId),
          loading: false,
          error: message,
        });
      }
    } finally {
      if (generation === this.generation) {
        this.inFlightRefresh = null;
        this.loading = false;
        if (this.refreshAgain) {
          this.refreshAgain = false;
          void this.refresh(timeline);
        }
        if (this.libraryStatusRefreshRequested) {
          this.libraryStatusRefreshRequested = false;
          void this.refreshLibraryStatuses();
        }
      }
    }
  }

  /** Debounced refresh, used after a job reports catalog progress. */
  scheduleRefresh(delay: number): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, delay);
  }

  /** Cheap poll for a changed catalog revision (e.g. another window indexed); refreshes on change. */
  async pollRevision(): Promise<void> {
    if (
      this.revisionPollPending ||
      !this.backendStatus.ready ||
      document.visibilityState !== "visible"
    )
      return;
    this.revisionPollPending = true;
    const generation = this.generation;
    try {
      const revision = await window.nicegal.backend.getCatalogRevision();
      if (generation !== this.generation) return;
      if (this.catalogRevision && revision !== this.catalogRevision) await this.refresh();
      else this.catalogRevision = revision;
      const libraryId = this.selectedId;
      if (libraryId !== null && generation === this.generation) {
        const imageCoverage = await window.nicegal.backend.getImageEmbeddingCoverage(libraryId);
        if (generation === this.generation && libraryId === this.selectedId) {
          this.updateLibraryStatus(libraryId, { ...this.statusFor(libraryId), imageCoverage });
        }
      }
    } catch (error) {
      console.warn("Catalog revision poll failed", error);
      if (generation === this.generation && this.selectedId !== null) {
        this.updateLibraryStatus(this.selectedId, {
          ...this.statusFor(this.selectedId),
          imageCoverage: null,
        });
      }
    } finally {
      this.revisionPollPending = false;
    }
  }

  /** Re-loads when the settings store's sort field changes; a no-op for any other settings change. */
  onSettingsChange(value: GallerySettings): void {
    if (value.sortField === this.loadedTimeline) return;
    this.loadedTimeline = value.sortField;
    if (this.backendStatus.ready) void this.refresh(value.sortField);
  }

  /** Advances the thumbnail cache-buster; call after a job regenerates thumbnails. */
  bumpThumbnailRevision(): void {
    this.thumbnailRevision += 1;
  }

  /**
   * Refreshes independent catalog and embedding counts for every library row. Failures stay on
   * their row so a malformed response for one library cannot blank otherwise healthy rows.
   */
  async refreshLibraryStatuses(): Promise<void> {
    if (!this.backendStatus.ready) return;

    const generation = ++this.libraryStatusGeneration;
    const ids = this.definitions.map((library) => library.id);
    const selectedId = this.selectedId;
    const selectedCataloged = this.items.length;
    // `this.items` is only trustworthy as the selected library's count once a `refresh()` has
    // finished landing it; mid-load it is stale. Snapshot `loading` now rather than trust it.
    const selectedLoading = this.loading;
    for (const id of ids) {
      this.updateLibraryStatus(id, { ...this.statusFor(id), loading: true, error: null });
    }

    await Promise.all(
      ids.map(async (id) => {
        const idGeneration = this.libraryStatusIdGeneration(id);
        try {
          const catalogedRequest =
            id === selectedId && !selectedLoading
              ? Promise.resolve(selectedCataloged)
              : window.nicegal.backend.countAssets(id).then((count) => {
                  if (!Number.isSafeInteger(count) || count < 0)
                    throw new Error("Invalid catalog status response");
                  return count;
                });
          const [cataloged, rawCoverage, imageCoverage] = await Promise.all([
            catalogedRequest,
            window.nicegal.backend.getTextEmbeddingCoverage(id),
            window.nicegal.backend.getImageEmbeddingCoverage(id),
          ]);
          const coverage = normalizeTextEmbeddingCoverage(rawCoverage);
          if (!this.isCurrentLibraryStatusRequest(id, generation, idGeneration)) return;
          this.updateLibraryStatus(id, {
            cataloged,
            imageCoverage,
            ...coverage,
            loading: false,
            error: null,
          });
        } catch (error) {
          if (!this.isCurrentLibraryStatusRequest(id, generation, idGeneration)) return;
          this.updateLibraryStatus(id, {
            ...this.statusFor(id),
            imageCoverage: null,
            loading: false,
            error: errorMessage(error),
          });
        }
      }),
    );
  }

  /** Creates a one-folder library with the default search types and selects it. */
  async createLibrary(folder: string): Promise<LibraryRecord> {
    const { indexOcr, indexImage } = get(settings);
    const library = await window.nicegal.backend.createLibrary({
      include: [folder],
      exclude: [],
      ocr: indexOcr,
      image: indexImage,
    });
    this.applyDefinitions([...this.definitions.filter(({ id }) => id !== library.id), library]);
    await this.selectLibrary(library.id);
    return this.libraries.find(({ id }) => id === library.id)!;
  }

  /** Replaces a library's folders and search types; the caller decides whether to scan. */
  async updateLibrary(id: LibraryId, definition: LibraryDefinition): Promise<Library> {
    const updated = await window.nicegal.backend.updateLibrary(id, definition);
    this.applyDefinitions(
      this.definitions.map((library) => (library.id === id ? updated : library)),
    );
    // Membership changed, so the loaded catalog and every count for it are stale. Reload in
    // place rather than clearing, so the gallery does not flash empty.
    if (id === this.selectedId) await this.refresh();
    void this.refreshLibraryStatuses();
    return updated;
  }

  /** Deletes a library definition. Its indexed data stays; see `libraryPurge` for removal. */
  async deleteLibrary(id: LibraryId): Promise<void> {
    await window.nicegal.backend.deleteLibrary(id);
    this.applyDefinitions(this.definitions.filter((library) => library.id !== id));
  }

  /**
   * Selects a library, resets the loaded catalog, and loads it. Returns false when `id` is not
   * a known library.
   */
  async selectLibrary(id: LibraryId): Promise<boolean> {
    if (!this.definitions.some((library) => library.id === id)) return false;
    const previous = this.selectedId;
    if (previous !== id) {
      if (previous !== null) this.invalidateLibraryStatusRequest(previous);
      this.invalidateLibraryStatusRequest(id);
      this.selectedId = id;
      this.persistViewRegistry();
      if (previous !== null) this.onSelectionChanged(previous, id);
    }
    await this.refreshSelectedLibrary();
    return true;
  }

  /** The saved search text and scroll offset to restore for one library. Not reactive. */
  viewState(id: LibraryId): LibraryViewState {
    return this.views[id] ?? emptyViewState();
  }

  /** Persists view preferences for one library: its name, raw search text, and scroll offset. */
  updateLibraryViewState(id: LibraryId, patch: LibraryViewStatePatch): void {
    const current = this.views[id] ?? emptyViewState();
    const next = normalizeViewState({ ...current, ...patch });
    if (
      next.name === current.name &&
      next.query === current.query &&
      next.scrollTop === current.scrollTop
    )
      return;
    this.views[id] = next;
    if (next.name !== current.name) this.setViews(this.views);
    this.persistViewRegistry();
  }

  /** Replaces the view preferences and republishes names only when one actually changed. */
  private setViews(views: Record<string, LibraryViewState>): void {
    this.views = views;
    const names: Record<string, string> = {};
    for (const [id, view] of Object.entries(views)) if (view.name) names[id] = view.name;
    const current = Object.entries(this.names);
    if (
      current.length !== Object.keys(names).length ||
      current.some(([id, name]) => names[id] !== name)
    )
      this.names = names;
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }

  /**
   * The selected library's counts, or undefined when nothing is selected. Rows start as an empty
   * status the moment a library appears, so callers must treat a zero `cataloged` as "nothing
   * to show yet" rather than a real reading.
   */
  get selectedStatus(): LibraryRowStatus | undefined {
    return this.selectedId === null ? undefined : this.libraryStatuses.get(this.selectedId);
  }

  private applyDefinitions(definitions: Library[]): void {
    const previousSelection = this.selectedId;
    this.definitions = definitions;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local lookup, never read reactively
    const ids = new Set(definitions.map((library) => library.id));
    for (const id of [...this.libraryStatuses.keys()]) {
      if (!ids.has(id)) {
        this.libraryStatuses.delete(id);
        this.libraryStatusIdGenerations.delete(id);
      }
    }
    for (const library of definitions) {
      if (!this.libraryStatuses.has(library.id))
        this.libraryStatuses.set(library.id, emptyLibraryRowStatus());
    }
    // Views of deleted libraries are dropped; their IDs are never reused by the backend.
    const views = Object.fromEntries(
      Object.entries(this.views).filter(([id]) => ids.has(Number(id))),
    );
    if (Object.keys(views).length !== Object.keys(this.views).length) this.setViews(views);
    if (this.selectedId === null || !ids.has(this.selectedId)) {
      this.selectedId = definitions[0]?.id ?? null;
    }
    this.persistViewRegistry();
    if (previousSelection !== null && this.selectedId !== previousSelection)
      this.onSelectionChanged(previousSelection, this.selectedId);
    // Reload only for a new selection, or when nothing was ever loaded. A mid-refresh reload of
    // the list must not clear the gallery and load it again.
    if (this.selectedId !== previousSelection || this.generation === 0)
      void this.refreshSelectedLibrary();
  }

  /**
   * Imports each v2 root as its own one-folder library. `importKey` makes a repeat return the
   * library the first import created, so an interrupted import resumes without duplicates.
   * The v2 key is left in place as rollback material.
   */
  private async importV2Registry(): Promise<void> {
    const { libraries, selectedRoot } = readV2Registry();
    const preferences = get(settings);
    let complete = true;
    for (const record of libraries) {
      try {
        const library = await window.nicegal.backend.createLibrary({
          include: [record.root],
          exclude: [],
          ...libraryIndexing(preferences, record.root),
          importKey: `${LIBRARIES_STORAGE_KEY}:${rootKey(record.root)}`,
        });
        if (!this.views[library.id]) {
          const derived = derivedLibraryName(library.include);
          this.setViews({
            ...this.views,
            [library.id]: {
              name:
                record.displayName && record.displayName !== derived ? record.displayName : null,
              query: record.query,
              scrollTop: record.scrollTop,
            },
          });
        }
        if (this.selectedId === null && rootsMatch(record.root, selectedRoot))
          this.selectedId = library.id;
      } catch (error) {
        complete = false;
        console.warn(`Could not import library ${record.root}`, error);
      }
    }
    this.importedV2 = complete;
    this.persistViewRegistry();
  }

  private mapGalleryAsset(asset: GalleryAsset, timeline: Timeline): GalleryItem {
    const width = asset.width ?? 1;
    const height = asset.height ?? 1;
    const timestampNs =
      timeline === "capture" ? (asset.captureNs ?? asset.modifiedNs) : asset.modifiedNs;
    return {
      id: asset.id,
      path: asset.path,
      displayName: asset.displayName,
      extension: asset.extension,
      modifiedNs: asset.modifiedNs,
      createdNs: asset.createdNs,
      captureNs: asset.captureNs,
      sourceSize: asset.sourceSize,
      thumbnailRevision: this.thumbnailRevision,
      mediaKind: asset.mediaKind,
      mediaFormat: asset.mediaFormat,
      animated: asset.animated,
      frameCount: asset.frameCount,
      durationMs: asset.durationMs,
      width,
      height,
      sourceWidth: asset.width,
      sourceHeight: asset.height,
      aspectRatio: aspectRatioOf(width, height),
      date: Number(BigInt(timestampNs) / 1_000_000n),
    };
  }

  private statusFor(id: LibraryId): LibraryRowStatus {
    return this.libraryStatuses.get(id) ?? emptyLibraryRowStatus();
  }

  private updateLibraryStatus(id: LibraryId, status: LibraryRowStatus): void {
    if (!this.definitions.some((library) => library.id === id)) return;
    this.libraryStatuses.set(id, status);
  }

  private libraryStatusIdGeneration(id: LibraryId): number {
    return this.libraryStatusIdGenerations.get(id) ?? 0;
  }

  private invalidateLibraryStatusRequest(id: LibraryId): void {
    this.libraryStatusIdGenerations.set(id, this.libraryStatusIdGeneration(id) + 1);
    const status = this.statusFor(id);
    if (status.loading) {
      // The request that owned this loading flag can no longer settle it. Clear it immediately,
      // then let the catalog refresh that superseded it request fresh counts once it lands.
      this.libraryStatusRefreshRequested = true;
      this.updateLibraryStatus(id, { ...status, loading: false });
    }
  }

  private isCurrentLibraryStatusRequest(
    id: LibraryId,
    generation: number,
    idGeneration: number,
  ): boolean {
    return (
      generation === this.libraryStatusGeneration &&
      idGeneration === this.libraryStatusIdGeneration(id) &&
      this.definitions.some((library) => library.id === id)
    );
  }

  private updateSelectedCatalogCount(): void {
    if (this.selectedId === null) return;
    this.updateLibraryStatus(this.selectedId, {
      ...this.statusFor(this.selectedId),
      cataloged: this.items.length,
    });
  }

  private loadViewRegistry(): LibraryViewRegistry {
    try {
      const serialized = localStorage.getItem(LIBRARY_VIEWS_STORAGE_KEY);
      if (serialized === null) return { selectedId: null, views: {}, importedV2: false };
      const value = JSON.parse(serialized) as Partial<LibraryViewRegistry>;
      const views: Record<string, LibraryViewState> = {};
      if (value.views && typeof value.views === "object") {
        for (const [id, view] of Object.entries(value.views)) {
          if (isLibraryId(Number(id))) views[id] = normalizeViewState(view);
        }
      }
      return {
        selectedId: isLibraryId(value.selectedId) ? value.selectedId : null,
        views,
        importedV2: value.importedV2 === true,
      };
    } catch {
      return { selectedId: null, views: {}, importedV2: false };
    }
  }

  private persistViewRegistry(): void {
    try {
      localStorage.setItem(
        LIBRARY_VIEWS_STORAGE_KEY,
        JSON.stringify({
          selectedId: this.selectedId,
          views: this.views,
          importedV2: this.importedV2,
        } satisfies LibraryViewRegistry),
      );
    } catch {
      // View preferences are conveniences; the backend still owns every library.
    }
  }

  private async refreshSelectedLibrary(): Promise<void> {
    this.items = [];
    this.catalogRevision = "";
    this.loadedTimeline = null;
    this.loadError = "";
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    await this.refresh();
  }
}
