import { tick, untrack } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import { fromStore } from "svelte/store";

import type { LibraryId } from "../../../shared/backend";
import type { DetailViewStatus } from "../components/DetailView.svelte";
import type { ApplicationContext } from "./application.svelte";
import type { LayoutOptions } from "./gallery/options";
import type { GalleryLayout } from "./gallery/types";
import type { GalleryItem } from "./gallery/types";
import type { SearchView } from "./ocr-search.svelte";
import type { SearchIssue } from "./search-issue";

import { errorMessage } from "./errors";
import { GalleryScrollState } from "./gallery/scroll-state.svelte";
import { collapseSearchSections } from "./gallery/search-sections";
import { GallerySelection, type SelectionModifiers } from "./gallery/selection.svelte";
import { isActiveJob } from "./job-state";
import { withScope } from "./search-query";
import { layoutOptions, settings } from "./settings.svelte";

export type SettingsPage = "gallery" | "search" | "about";
export type ActiveDialog = "manageLibraries" | "settings" | "searchProblem" | null;

export interface LibraryViewController {
  readonly galleryScroll: GalleryScrollState;
  readonly gallerySelection: GallerySelection;
  readonly activeDialog: ActiveDialog;
  settingsPage: SettingsPage;
  /** The search problem shown by the search problem dialog, as it was when opened. */
  readonly searchProblem: SearchIssue | null;
  /** The library initially selected in management. */
  readonly editingLibraryId: LibraryId | null;
  readonly librariesPaneOpen: boolean;
  readonly detailIndex: number | null;
  detailStatus: DetailViewStatus | null;
  readonly searchView: SearchView;
  readonly filteredItems: GalleryItem[];
  readonly rankedView: boolean;
  readonly galleryLayoutOptions: LayoutOptions;
  readonly statusMessage: string | undefined;
  readonly jobRunning: boolean;
  readonly indexingRunning: boolean;
  readonly detailItem: GalleryItem | undefined;
  readonly libraryName: string;
  toggleSection(key: string): void;
  closeDialog(): void;
  startWelcomeLibraryPicker(): void;
  /** Shows the libraries pane, e.g. from a "not ready" notice. */
  showLibrariesPane(): void;
  toggleLibrariesPane(): void;
  openManageLibraries(): void;
  editLibrary(libraryId: LibraryId): void;
  /** Opens Settings, on `page` when given. Also switches straight from Library manager. */
  openSettingsDialog(page?: SettingsPage): void;
  openSearchProblem(issue: SearchIssue): void;
  dismissSelectionOrDetail(): void;
  switchToMeaningSearch(): void;
  openDetail(index: number): void;
  openFileMenu(index: number): void;
  startFileDrag(index: number, isCurrent: () => boolean): void;
  selectGalleryItem(index: number, modifiers: SelectionModifiers): void;
  beginGalleryMarquee(modifiers: SelectionModifiers): void;
  updateGalleryMarquee(ids: readonly string[]): void;
  endGalleryMarquee(): void;
  closeDetail(): void;
  showPrevDetail(): void;
  showNextDetail(): void;
  handleGalleryScroll(state: { scrollTop: number; layout: GalleryLayout }): void;
  handleSeek(y: number): void;
  /** Picks a folder and creates a library for it. */
  addLibrary(): Promise<
    | { status: "created"; id: LibraryId }
    | { status: "cancelled" }
    | { status: "error"; message: string }
  >;
  selectLibrary(libraryId: LibraryId): Promise<void>;
  removeLibrary(libraryId: LibraryId, purge: boolean): Promise<boolean>;
  dispose(): void;
}

/** Component-scoped library session. Create during component initialization so its effects
 * belong to that view. The viewport is accessed through a port, never retained as a DOM node. */
export function createLibraryViewController(
  application: ApplicationContext,
  scrollTo: (y: number) => void,
): LibraryViewController {
  const { catalog, runtime, ocrSearch, jobs } = application.services;
  const commands = application.commands;
  const preferences = fromStore(settings);
  // Presentation settings emit through the same store. Only a changed timeline should rerun a
  // search; layout switches must retain the ranked results rather than clearing/requerying them.
  const searchTimeline = $derived(preferences.current.sortField);
  const supportsImageTextQueries = $derived(runtime.supportsImageTextQueries);
  // Saving scroll position replaces the library registry, and status polls replace row objects.
  // Only an actual change in OCR availability should restart the search. Keep the last count
  // during status loading/errors rather than toggling engines for a transient refresh.
  const hasOcr = $derived.by(() => {
    const status = catalog.selectedStatus;
    return !status || status.indexed > 0;
  });
  const hasImages = $derived((catalog.selectedStatus?.imageCoverage?.indexed ?? 0) > 0);
  const layoutPreferences = fromStore(layoutOptions);
  const galleryScroll = new GalleryScrollState();
  const searchIdentity = $derived(
    [catalog.selectedId, ocrSearch.query, ocrSearch.visualReferenceRevision].join("\u0000"),
  );
  // Progress replaces the active snapshot frequently; searches only care whether a job runs.
  const backendJobRunning = $derived(jobs.running);
  // Retain only the search's catalog snapshot during jobs. Catalog loading, counts and revision
  // polling continue normally. A new query/library/timeline gets a fresh snapshot immediately.
  // Only a snapshot of a finished load is retained: one taken mid-load (e.g. empty at startup,
  // while the startup scan runs) would otherwise hide the whole catalog until the job ends.
  let previousSearchCatalog:
    | {
        identity: string;
        timeline: string;
        items: GalleryItem[];
        hasOcr: boolean;
        settled: boolean;
      }
    | undefined;
  const searchCatalog = $derived.by(() => {
    const identity = searchIdentity;
    const timeline = searchTimeline;
    const hold =
      catalog.backendStatus.ready &&
      backendJobRunning &&
      Boolean(ocrSearch.query.trim() || ocrSearch.visualReferences.length);
    if (
      hold &&
      previousSearchCatalog?.settled &&
      previousSearchCatalog.identity === identity &&
      previousSearchCatalog.timeline === timeline
    )
      return previousSearchCatalog;
    return (previousSearchCatalog = {
      identity,
      timeline,
      items: catalog.items,
      hasOcr,
      settled: !catalog.loading,
    });
  });
  const gallerySelection = $derived.by(() => {
    void searchIdentity;
    return new GallerySelection();
  });
  // User overrides last for this query, including progressive arrivals and sort changes.
  let collapsedSections = $derived.by(() => {
    void searchIdentity;
    return new SvelteSet<string>();
  });
  let activeDialog = $state<ActiveDialog>(null);
  let settingsPage = $state<SettingsPage>("gallery");
  let searchProblem = $state.raw<SearchIssue | null>(null);
  /** Library manager and Settings edit what a scan does, so scans wait until neither is open.
   * Switching between them keeps the hold. */
  function setActiveDialog(next: ActiveDialog): void {
    const holdsScans = (dialog: ActiveDialog): boolean =>
      dialog === "manageLibraries" || dialog === "settings";
    if (!holdsScans(activeDialog) && holdsScans(next)) commands.beginDeferringScans();
    if (holdsScans(activeDialog) && !holdsScans(next)) commands.endDeferringScans();
    activeDialog = next;
  }
  function openSearchProblem(issue: SearchIssue): void {
    searchProblem = issue;
    editingLibraryId = null;
    setActiveDialog("searchProblem");
  }
  let editingLibraryId = $state<LibraryId | null>(null);
  // Progressive results may move an image between sections. The viewer follows its ID, not
  // whichever image later occupies the index that was clicked.
  let detailId = $derived.by(() => {
    void ocrSearch.composerOpen;
    return null as string | null;
  });
  const detailIndex = $derived.by(() => {
    if (detailId === null) return null;
    const index = filteredItems.findIndex((item) => item.id === detailId);
    return index < 0 ? null : index;
  });
  let detailStatus = $state<DetailViewStatus | null>(null);
  let restoringLibraryView = catalog.selectedId !== null;
  let disposed = false;
  let cancelSearchWait: (() => void) | undefined;
  let libraryViewGeneration = 0;
  /** The generation that currently owns `GalleryScrollState`'s restore suppression. */
  let preparedLibraryViewRestoreGeneration: number | null = null;
  let viewStateSaveTimer: ReturnType<typeof setTimeout> | undefined;
  const fullSearchView = $derived(ocrSearch.apply(searchCatalog.items));
  const searchView = $derived(collapseSearchSections(fullSearchView, collapsedSections));
  const filteredItems = $derived(searchView.items);
  /** Stable until the current search result changes; marquee moves must not rebuild this per event. */
  const filteredItemIds = $derived(filteredItems.map((item) => item.id));
  /** Relevance changes order, not presentation. Suppress date boundaries locally so the saved
   * header preference is restored on date sort (2026-09-12 supersedes the masonry override). */
  const rankedView = $derived(ocrSearch.rankable && ocrSearch.sortMode === "relevance");
  const galleryLayoutOptions = $derived(
    rankedView
      ? { ...layoutPreferences.current, granularity: "none" as const }
      : layoutPreferences.current,
  );
  /** A short failure of a gallery action (file menu, drag out), cleared after a few seconds. */
  let actionNotice = $state("");
  let actionNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  function showActionNotice(text: string): void {
    actionNotice = text;
    if (actionNoticeTimer) clearTimeout(actionNoticeTimer);
    actionNoticeTimer = setTimeout(() => {
      actionNotice = "";
      actionNoticeTimer = null;
    }, 8_000);
  }
  const statusMessage = $derived(
    actionNotice ||
      (jobs.completionMessage
        ? jobs.completionMessage
        : catalog.loading
          ? "Loading catalog…"
          : ocrSearch.pending
            ? ocrSearch.pendingLabel
            : undefined),
  );
  const jobRunning = $derived(jobs.running);
  const indexingRunning = $derived(jobs.active?.type === "libraryScan" && isActiveJob(jobs.active));
  /** `undefined` (out-of-range index, e.g. the filter changed while open) closes the detail view. */
  const detailItem = $derived(detailIndex !== null ? filteredItems[detailIndex] : undefined);
  const libraryName = $derived(catalog.selectedLibrary?.displayName ?? "No library");
  $effect(() => {
    const libraryId = catalog.selectedId;
    const query = ocrSearch.query;
    const visualReferenceRevision = ocrSearch.visualReferenceRevision;
    const scrollTop = untrack(() => galleryScroll.scrollTop);
    if (libraryId === null || restoringLibraryView) return;
    void visualReferenceRevision;
    scheduleLibraryViewState(libraryId, query, scrollTop);
  });
  $effect(() => {
    void ocrSearch.query;
    const libraryId = catalog.selectedId;
    const { items, hasOcr: ocrAvailable } = searchCatalog;
    const timeline = searchTimeline;
    const visualReferenceRevision = ocrSearch.visualReferenceRevision;
    if (!catalog.backendStatus.ready) {
      untrack(() => ocrSearch.suspend());
      return;
    }
    void visualReferenceRevision;
    const imageTextAvailable = supportsImageTextQueries;
    const imageAvailable = hasImages;
    untrack(() =>
      ocrSearch.schedule(
        libraryId,
        items,
        timeline,
        imageTextAvailable,
        ocrAvailable,
        imageAvailable,
      ),
    );
  });
  $effect(() => {
    const catalogItems = searchCatalog.items;
    untrack(() => gallerySelection.retainCatalogAssets(catalogItems));
  });
  $effect(() => {
    if (!application.initialized) return;
    void application.librarySelectionRevision;
    untrack(() => {
      const generation = beginLibraryViewRestore();
      void restoreLibraryView(catalog.selectedId, generation);
    });
  });
  function toggleSection(key: string): void {
    const next = new SvelteSet(collapsedSections);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsedSections = next;
    gallerySelection.retainCatalogAssets(filteredItems);
  }
  function closeDialog(): void {
    setActiveDialog(null);
    editingLibraryId = null;
  }
  function startWelcomeLibraryPicker(): void {
    commands.dismissWelcome();
    showLibrariesPane();
    void addLibrary();
  }
  function setLibrariesPaneOpen(open: boolean): void {
    settings.update((value) => ({ ...value, librariesPaneOpen: open }));
    if (open) void catalog.refreshLibraryStatuses();
  }
  function showLibrariesPane(): void {
    setLibrariesPaneOpen(true);
  }
  function toggleLibrariesPane(): void {
    setLibrariesPaneOpen(!preferences.current.librariesPaneOpen);
  }
  function editLibrary(libraryId: LibraryId): void {
    editingLibraryId = libraryId;
    setActiveDialog("manageLibraries");
    void catalog.loadLibraries();
  }
  function openManageLibraries(): void {
    editingLibraryId = catalog.selectedId;
    setActiveDialog("manageLibraries");
    void catalog.loadLibraries();
    void catalog.refreshLibraryStatuses();
  }
  function openSettingsDialog(page?: SettingsPage): void {
    if (page) settingsPage = page;
    editingLibraryId = null;
    setActiveDialog("settings");
    if (catalog.backendStatus.ready && !runtime.status && !runtime.loading) void runtime.refresh();
  }
  function dismissSelectionOrDetail(): void {
    if (detailIndex !== null) closeDetail();
    else if (gallerySelection.count > 0) gallerySelection.clear();
  }
  function switchToMeaningSearch(): void {
    ocrSearch.query = withScope(ocrSearch.query, "meaning");
  }
  function openDetail(index: number): void {
    detailStatus = null;
    detailId = filteredItems[index]?.id ?? null;
  }
  function openFileMenu(index: number): void {
    const item = filteredItems[index];
    if (!item) return;
    if (!gallerySelection.ids.has(item.id)) {
      gallerySelection.select(item.id, filteredItemIds, { toggle: false, extend: false });
    }
    const assetIds = [
      item.id,
      ...filteredItemIds.filter((id) => id !== item.id && gallerySelection.ids.has(id)),
    ];
    void commands.showFileContextMenu(assetIds).catch((error: unknown) => {
      showActionNotice(`Couldn't show file actions: ${errorMessage(error)}`);
    });
  }
  function selectGalleryItem(index: number, modifiers: SelectionModifiers): void {
    const item = filteredItems[index];
    if (!item) return;
    gallerySelection.select(item.id, filteredItemIds, modifiers);
  }
  function startFileDrag(index: number, isCurrent: () => boolean): void {
    const item = filteredItems[index];
    if (!item) return;
    gallerySelection.endMarquee();
    if (!gallerySelection.ids.has(item.id)) {
      gallerySelection.select(item.id, filteredItemIds, { toggle: false, extend: false });
    }
    const assetIds = filteredItemIds.filter((id) => gallerySelection.ids.has(id));
    const selection = gallerySelection;
    const visibleIds = filteredItemIds;
    const canStart = (): boolean =>
      isCurrent() && gallerySelection === selection && filteredItemIds === visibleIds;
    void commands.startFileDrag(assetIds, canStart).catch((error: unknown) => {
      if (canStart()) showActionNotice(`Couldn't drag the files: ${errorMessage(error)}`);
    });
  }
  function beginGalleryMarquee(modifiers: SelectionModifiers): void {
    gallerySelection.beginMarquee(modifiers);
  }
  function updateGalleryMarquee(ids: readonly string[]): void {
    gallerySelection.updateMarquee(ids, filteredItemIds);
  }
  function endGalleryMarquee(): void {
    gallerySelection.endMarquee();
  }
  function closeDetail(): void {
    detailId = null;
    detailStatus = null;
  }
  function showPrevDetail(): void {
    if (detailIndex !== null && detailIndex > 0) {
      detailStatus = null;
      detailId = filteredItems[detailIndex - 1].id;
    }
  }
  function showNextDetail(): void {
    if (detailIndex !== null && detailIndex < filteredItems.length - 1) {
      detailStatus = null;
      detailId = filteredItems[detailIndex + 1].id;
    }
  }
  function handleGalleryScroll(state: { scrollTop: number; layout: GalleryLayout }): void {
    galleryScroll.onScroll(state);
    if (catalog.selectedId !== null && !restoringLibraryView)
      scheduleLibraryViewState(catalog.selectedId, ocrSearch.query, galleryScroll.scrollTop);
  }
  function handleSeek(y: number): void {
    scrollTo(y);
  }
  function scheduleLibraryViewState(libraryId: LibraryId, query: string, scrollTop: number): void {
    if (viewStateSaveTimer) clearTimeout(viewStateSaveTimer);
    viewStateSaveTimer = setTimeout(() => {
      viewStateSaveTimer = undefined;
      catalog.updateLibraryViewState(libraryId, { query, scrollTop });
    }, 150);
  }

  function flushLibraryViewState(): void {
    if (viewStateSaveTimer) {
      clearTimeout(viewStateSaveTimer);
      viewStateSaveTimer = undefined;
    }
    if (catalog.selectedId === null || restoringLibraryView) return;
    catalog.updateLibraryViewState(catalog.selectedId, {
      query: ocrSearch.query,
      scrollTop: galleryScroll.scrollTop,
    });
  }

  function beginLibraryViewRestore(): number {
    cancelSearchWait?.();
    if (viewStateSaveTimer) clearTimeout(viewStateSaveTimer);
    viewStateSaveTimer = undefined;
    closeDetail();
    gallerySelection.clear();
    const generation = ++libraryViewGeneration;
    if (preparedLibraryViewRestoreGeneration !== null) {
      galleryScroll.finishRestore();
      preparedLibraryViewRestoreGeneration = null;
    }
    restoringLibraryView = true;
    return generation;
  }

  function abandonLibraryViewRestore(generation: number): void {
    if (preparedLibraryViewRestoreGeneration === generation) {
      galleryScroll.finishRestore();
      preparedLibraryViewRestoreGeneration = null;
    }
    if (generation === libraryViewGeneration) restoringLibraryView = false;
  }

  function canRestoreLibraryView(libraryId: LibraryId | null, generation: number): boolean {
    return !disposed && generation === libraryViewGeneration && catalog.selectedId === libraryId;
  }

  /** A saved offset belongs to the final search layout, not the empty/debounced result set.
   * The wait is cancelled by a newer library switch, a query edit, or view disposal. */
  function waitForRestoredSearch(
    libraryId: LibraryId | null,
    query: string,
    generation: number,
  ): Promise<boolean> {
    if (!canRestoreLibraryView(libraryId, generation) || ocrSearch.query !== query) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let stop = (): void => {};
      const finish = (ready: boolean): void => {
        stop();
        if (cancelSearchWait === cancel) cancelSearchWait = undefined;
        resolve(ready);
      };
      const cancel = (): void => finish(false);
      cancelSearchWait = cancel;
      stop = $effect.root(() => {
        $effect(() => {
          const currentLibraryId = catalog.selectedId;
          const currentQuery = ocrSearch.query;
          const pending = catalog.loading || ocrSearch.pending;
          untrack(() => {
            if (
              currentLibraryId !== libraryId ||
              currentQuery !== query ||
              !canRestoreLibraryView(libraryId, generation)
            ) {
              finish(false);
            } else if (!pending) {
              finish(true);
            }
          });
        });
      });
    });
  }

  async function restoreLibraryView(
    libraryId: LibraryId | null,
    generation: number,
  ): Promise<boolean> {
    if (!canRestoreLibraryView(libraryId, generation)) {
      abandonLibraryViewRestore(generation);
      return false;
    }
    const { query, scrollTop } =
      libraryId === null ? { query: "", scrollTop: 0 } : catalog.viewState(libraryId);
    ocrSearch.resetVisualSearch();
    ocrSearch.query = query;
    galleryScroll.prepareRestore(scrollTop);
    preparedLibraryViewRestoreGeneration = generation;
    await tick();
    if (!(await waitForRestoredSearch(libraryId, query, generation))) {
      abandonLibraryViewRestore(generation);
      return false;
    }
    await tick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (!canRestoreLibraryView(libraryId, generation) || ocrSearch.query !== query) {
      abandonLibraryViewRestore(generation);
      return false;
    }
    scrollTo(scrollTop);
    abandonLibraryViewRestore(generation);
    return true;
  }

  async function addLibrary(): Promise<
    | { status: "created"; id: LibraryId }
    | { status: "cancelled" }
    | { status: "error"; message: string }
  > {
    try {
      const folder = await window.nicegal.native.chooseDirectory();
      if (!folder) return { status: "cancelled" };
      flushLibraryViewState();
      // Selection advances `librarySelectionRevision`, whose effect restores the new view.
      const library = await commands.createLibrary(folder);
      return { status: "created", id: library.id };
    } catch (error) {
      const message = errorMessage(error);
      if (activeDialog !== "manageLibraries")
        commands.showProblem({
          title: "Couldn't add the folder",
          guidance: "Check that the folder exists and can be opened, then try again.",
          message,
        });
      return { status: "error", message };
    }
  }

  async function selectLibrary(libraryId: LibraryId): Promise<void> {
    if (libraryId === catalog.selectedId) return;
    flushLibraryViewState();
    const generation = beginLibraryViewRestore();
    if (!(await catalog.selectLibrary(libraryId))) {
      abandonLibraryViewRestore(generation);
      return;
    }
    await restoreLibraryView(libraryId, generation);
  }

  async function removeLibrary(libraryId: LibraryId, purge: boolean): Promise<boolean> {
    if (libraryId === catalog.selectedId) flushLibraryViewState();
    // Deleting the selected library advances `librarySelectionRevision`, which restores the
    // view of whichever library is selected next.
    return commands.removeLibrary(libraryId, purge);
  }

  return {
    galleryScroll,
    get gallerySelection() {
      return gallerySelection;
    },
    get activeDialog() {
      return activeDialog;
    },
    get settingsPage() {
      return settingsPage;
    },
    get searchProblem() {
      return searchProblem;
    },
    set settingsPage(value: SettingsPage) {
      settingsPage = value;
    },
    get editingLibraryId() {
      return editingLibraryId;
    },
    get librariesPaneOpen() {
      return preferences.current.librariesPaneOpen;
    },
    get detailIndex() {
      return detailIndex;
    },
    get detailStatus() {
      return detailStatus;
    },
    get searchView() {
      return searchView;
    },
    get filteredItems() {
      return filteredItems;
    },
    get rankedView() {
      return rankedView;
    },
    get galleryLayoutOptions() {
      return galleryLayoutOptions;
    },
    get statusMessage() {
      return statusMessage;
    },
    get jobRunning() {
      return jobRunning;
    },
    get indexingRunning() {
      return indexingRunning;
    },
    get detailItem() {
      return detailItem;
    },
    get libraryName() {
      return libraryName;
    },
    set detailStatus(value: DetailViewStatus | null) {
      detailStatus = value;
    },
    toggleSection,
    closeDialog,
    startWelcomeLibraryPicker,
    showLibrariesPane,
    toggleLibrariesPane,
    openManageLibraries,
    editLibrary,
    openSettingsDialog,
    openSearchProblem,
    dismissSelectionOrDetail,
    switchToMeaningSearch,
    openDetail,
    openFileMenu,
    startFileDrag,
    selectGalleryItem,
    beginGalleryMarquee,
    updateGalleryMarquee,
    endGalleryMarquee,
    closeDetail,
    showPrevDetail,
    showNextDetail,
    handleGalleryScroll,
    handleSeek,
    addLibrary,
    selectLibrary,
    removeLibrary,
    dispose(): void {
      flushLibraryViewState();
      disposed = true;
      cancelSearchWait?.();
      libraryViewGeneration += 1;
      galleryScroll.finishRestore();
      if (actionNoticeTimer) clearTimeout(actionNoticeTimer);
    },
  };
}
