import { createContext } from "svelte";
import { get } from "svelte/store";

import type { LibraryDefinition, LibraryId } from "../../../shared/backend";
import type { ThumbnailBackfillOptions } from "./job-params";

import { CatalogController, type LibraryRecord } from "./catalog.svelte";
import { ONBOARDING_DISMISSED_STORAGE_KEY } from "./constants";
import { errorMessage } from "./errors";
import { JobOrchestrator } from "./job-orchestrator.svelte";
import { JobTracker } from "./job-tracker.svelte";
import { sameFolder } from "./library-root";
import { OcrSearchController } from "./ocr-search.svelte";
import { RuntimeController } from "./runtime.svelte";
import { settings } from "./settings.svelte";

type IndexBucket = 128 | 256 | 512 | 1024;

export interface ApplicationServices {
  readonly catalog: CatalogController;
  readonly runtime: RuntimeController;
  readonly ocrSearch: OcrSearchController;
  readonly jobs: JobTracker;
  readonly orchestrator: JobOrchestrator;
}

export interface ApplicationCommands {
  readonly showFileContextMenu: (assetIds: string[]) => Promise<void>;
  readonly startFileDrag: (assetIds: string[], isCurrent: () => boolean) => Promise<void>;
  /** Creates a library for one folder and selects it. */
  readonly createLibrary: (folder: string) => Promise<LibraryRecord>;
  /** Saves an edited definition and schedules its pending scan. */
  readonly saveLibrary: (
    libraryId: LibraryId,
    definition: LibraryDefinition,
    name: string | null,
  ) => Promise<void>;
  /** Requests a scan of every folder, or only pending ones; queued by the backend when busy. */
  readonly scanLibrary: (
    libraryId: LibraryId,
    options?: { scanMode?: "full" | "fast"; pendingOnly?: boolean; retryFailed?: boolean },
  ) => void;
  readonly startThumbnailBackfill: (
    libraryId: LibraryId,
    options: ThumbnailBackfillOptions,
  ) => Promise<void>;
  readonly dismissJobResult: () => void;
  /** Deletes a library; with `purge`, first removes indexed data no other library covers. */
  readonly removeLibrary: (libraryId: LibraryId, purge: boolean) => Promise<boolean>;
  readonly dismissWelcome: () => void;
  readonly showWelcome: () => void;
  readonly beginLibraryManagement: () => void;
  readonly endLibraryManagement: () => void;
}

export interface ApplicationContext {
  readonly services: ApplicationServices;
  readonly commands: ApplicationCommands;
  readonly initialized: boolean;
  readonly librarySelectionRevision: number;
  readonly welcomeVisible: boolean;
}

class Application implements ApplicationContext {
  readonly services: ApplicationServices;
  readonly commands: ApplicationCommands;
  initialized = $state(false);
  librarySelectionRevision = $state(0);
  welcomeVisible = $state(false);

  private started = false;
  private backendInitialized = false;
  private managingLibraries = false;
  private deferredScanId: LibraryId | null = null;
  /** The video-indexing choice last saved to the backend, so unrelated settings changes do not
   * resend it. */
  private savedIndexVideos: boolean | null = null;

  constructor() {
    const ocrSearch = new OcrSearchController();
    // Only the library on screen is indexed: leaving one stops its scan, and opening one scans
    // whatever its folders still need.
    const catalog = new CatalogController((previous, next) => {
      if (!catalog.backendStatus.ready) return;
      void jobs.cancelLibraryScans(previous);
      if (next !== null) this.requestPendingScan(next);
    });
    const runtime = new RuntimeController();
    const jobs: JobTracker = new JobTracker(
      (delay) => catalog.scheduleRefresh(delay),
      () => catalog.bumpThumbnailRevision(),
      (snapshot) => {
        orchestrator.handleTerminalJob(snapshot);
        void runtime.refreshModels();
        void this.afterJob();
      },
    );
    const orchestrator = new JobOrchestrator(jobs, async (libraryId) => {
      await this.deleteLibrary(libraryId);
    });

    this.services = Object.freeze({ catalog, runtime, ocrSearch, jobs, orchestrator });
    this.commands = Object.freeze({
      startFileDrag: async (assetIds: string[], isCurrent: () => boolean) => {
        const token = await window.nicegal.native.prepareFileDrag({ assetIds });
        // A release, cancellation, or newer press during resolution must not start a late drag.
        if (isCurrent()) await window.nicegal.native.startFileDrag(token);
      },
      showFileContextMenu: (assetIds: string[]) =>
        window.nicegal.native.showFileContextMenu({ assetIds }),
      createLibrary: (folder: string) => this.createLibrary(folder),
      saveLibrary: (libraryId: LibraryId, definition: LibraryDefinition, name: string | null) =>
        this.saveLibrary(libraryId, definition, name),
      scanLibrary: (
        libraryId: LibraryId,
        options: { scanMode?: "full" | "fast"; pendingOnly?: boolean; retryFailed?: boolean } = {},
      ) => {
        if (this.deferredScanId === libraryId) this.deferredScanId = null;
        void orchestrator.scan(libraryId, { scanMode: "full", ...options });
      },
      startThumbnailBackfill: (libraryId: LibraryId, options: ThumbnailBackfillOptions) =>
        this.startThumbnailBackfill(libraryId, options),
      dismissJobResult: () => this.services.jobs.dismiss(),
      removeLibrary: (libraryId: LibraryId, purge: boolean) => this.removeLibrary(libraryId, purge),
      dismissWelcome: () => this.dismissWelcome(),
      showWelcome: () => {
        this.welcomeVisible = true;
      },
      beginLibraryManagement: () => { this.managingLibraries = true; },
      endLibraryManagement: () => {
        this.managingLibraries = false;
        const id = this.deferredScanId;
        this.deferredScanId = null;
        if (id !== null && id === catalog.selectedId) void orchestrator.scan(id);
      },
    });
  }

  start(): () => void {
    if (this.started) throw new Error("Application lifecycle already started");
    this.started = true;

    const { catalog, runtime, orchestrator, jobs } = this.services;
    const unsubscribeSettings = settings.subscribe((value) => {
      catalog.onSettingsChange(value);
      this.saveIndexVideos(value.indexVideos);
    });
    const unsubscribeVisualSearch = window.nicegal.native.onAddToVisualSearch(
      (assetIds, replace) => {
        this.services.ocrSearch.addLibraryReferences(
          catalog.items
            .filter((item) => assetIds.includes(item.id))
            .map((item) => ({ id: item.id, displayName: item.displayName })),
          replace,
        );
      },
    );
    const unsubscribeBackendStatus = window.nicegal.backend.onBackendStatusChanged((status) => {
      const recovered = !catalog.backendStatus.ready && status.ready;
      const disconnected = catalog.backendStatus.ready && !status.ready;
      catalog.applyBackendStatus(status);
      if (status.error && orchestrator.restartingIndex) orchestrator.backendDisconnected();
      if (disconnected) {
        runtime.reset();
        const providerFallback = status.restartReason === "provider-fallback";
        const resuming = orchestrator.backendDisconnected(providerFallback);
        this.services.jobs.backendDisconnected(resuming);
      }
      if (recovered) {
        if (this.backendInitialized) {
          void runtime.refresh();
          void runtime.refreshModels();
        }
        void this.recoverBackend();
      }
    });
    // Jobs are polled as well as followed: the backend queues scans on its own after library
    // edits and restarts, and the next queued scan starts without any client request.
    const revisionPoll = setInterval(() => {
      void catalog.pollRevision();
      if (catalog.backendStatus.ready && document.visibilityState === "visible") void jobs.sync();
    }, 2_000);
    void this.initialize();

    return () => {
      unsubscribeSettings();
      unsubscribeVisualSearch();
      unsubscribeBackendStatus();
      clearInterval(revisionPoll);
      this.services.ocrSearch.dispose();
      catalog.dispose();
      this.services.jobs.dispose();
      this.started = false;
    };
  }

  private async initialize(): Promise<void> {
    const { catalog, jobs } = this.services;
    try {
      await catalog.initialize();
      this.initialized = true;
      if (catalog.backendStatus.ready) await this.initializeReadyBackend();
    } catch (error) {
      this.initialized = true;
      jobs.error = errorMessage(error);
    }
  }

  private async recoverBackend(): Promise<void> {
    await this.services.catalog.loadLibraries();
    await this.initializeReadyBackend();
    const { catalog, orchestrator, jobs } = this.services;
    orchestrator.backendReady();
    this.savedIndexVideos = null;
    this.saveIndexVideos(get(settings).indexVideos);
    await jobs.sync();
    // A restart (including a provider fallback) drops any scan that was running or queued.
    if (catalog.selectedId !== null)
      await orchestrator.scan(catalog.selectedId, { pendingOnly: true });
  }

  private async initializeReadyBackend(): Promise<void> {
    if (this.backendInitialized) return;
    this.backendInitialized = true;
    const { catalog, runtime, orchestrator, jobs } = this.services;
    this.welcomeVisible =
      catalog.librariesLoaded && !catalog.libraries.length && !this.welcomeWasDismissed();
    void catalog.refreshLibraryStatuses();
    void runtime.refresh();
    void runtime.refreshModels();
    this.saveIndexVideos(get(settings).indexVideos);
    try {
      // Follow whatever the backend is already running or has queued from its last session.
      await jobs.sync();
      await orchestrator.resumeInterruptedJob(catalog.selectedId);
      // Opening the app checks the selected library; the backend runs a full walk when due.
      if (catalog.selectedId !== null) await orchestrator.scan(catalog.selectedId);
    } catch (error) {
      jobs.error = errorMessage(error);
    }
  }

  /** Called after every terminal job: library state may have moved, and the backend may have
   * started the next queued scan. */
  private async afterJob(): Promise<void> {
    const { catalog, jobs } = this.services;
    await catalog.loadLibraries();
    void catalog.refreshLibraryStatuses();
    await jobs.sync();
  }

  /** Scans read the video choice from the backend's runtime settings, so keep it saved there. */
  private saveIndexVideos(indexVideos: boolean): void {
    if (!this.services.catalog.backendStatus.ready || this.savedIndexVideos === indexVideos) return;
    this.savedIndexVideos = indexVideos;
    void window.nicegal.backend.setIndexVideos(indexVideos).catch((error: unknown) => {
      this.savedIndexVideos = null;
      this.services.jobs.error = errorMessage(error);
    });
  }

  private async createLibrary(folder: string): Promise<LibraryRecord> {
    const { catalog } = this.services;
    await catalog.loadLibraries();
    if (catalog.librariesError) throw new Error(`Could not check existing libraries: ${catalog.librariesError}`);
    const existing = catalog.libraries.find((library) =>
      library.include.some((included) => sameFolder(included.path, folder)),
    );
    if (existing) {
      throw new Error(`That folder is already in “${existing.displayName}”. Select that library or add a different folder.`);
    }
    const library = await catalog.createLibrary(folder);
    this.librarySelectionRevision += 1;
    this.requestPendingScan(library.id);
    return library;
  }

  private async saveLibrary(
    libraryId: LibraryId,
    definition: LibraryDefinition,
    name: string | null,
  ): Promise<void> {
    const { catalog } = this.services;
    const current = catalog.definitions.find((library) => library.id === libraryId);
    if (current && definitionChanged(current, definition)) {
      const updated = await catalog.updateLibrary(libraryId, definition);
      catalog.updateLibraryViewState(libraryId, { name });
      if (this.managingLibraries || updated.include.some((folder) => folder.scanPending))
        this.requestPendingScan(libraryId);
    } else {
      catalog.updateLibraryViewState(libraryId, { name });
    }
  }

  private requestPendingScan(libraryId: LibraryId): void {
    if (this.managingLibraries) this.deferredScanId = libraryId;
    else void this.services.orchestrator.scan(libraryId, { pendingOnly: true });
  }

  private async startThumbnailBackfill(
    libraryId: LibraryId,
    options: ThumbnailBackfillOptions,
  ): Promise<void> {
    const { jobs, orchestrator } = this.services;
    if (jobs.running) return;
    const buckets = this.toBucketList(options.buckets);
    const { sortField } = get(settings);
    await orchestrator.startResumableJob({
      type: "thumbnailGenerate",
      params: {
        libraryId,
        buckets: buckets.length ? buckets : undefined,
        timeline: sortField,
        range:
          options.fromNs || options.toNs
            ? { fromNs: options.fromNs, toNs: options.toNs }
            : undefined,
      },
    });
  }

  private async deleteLibrary(libraryId: LibraryId): Promise<boolean> {
    const { catalog } = this.services;
    const selected = catalog.selectedId === libraryId;
    await catalog.deleteLibrary(libraryId);
    if (selected) this.librarySelectionRevision += 1;
    return true;
  }

  private async removeLibrary(libraryId: LibraryId, purge: boolean): Promise<boolean> {
    const { jobs, orchestrator } = this.services;
    if (jobs.running) return false;
    // A purge deletes the definition itself once it completes; see `JobOrchestrator`.
    if (purge) return orchestrator.purgeLibrary(libraryId);
    return this.deleteLibrary(libraryId);
  }

  private welcomeWasDismissed(): boolean {
    try {
      return localStorage.getItem(ONBOARDING_DISMISSED_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  }

  private dismissWelcome(): void {
    this.welcomeVisible = false;
    try {
      localStorage.setItem(ONBOARDING_DISMISSED_STORAGE_KEY, "1");
    } catch {
      // The welcome has still been dismissed for this session if browser storage is unavailable.
    }
  }

  private toBucketList(values: number[]): IndexBucket[] {
    const validBuckets: readonly number[] = [128, 256, 512, 1024];
    return values.filter((value): value is IndexBucket => validBuckets.includes(value));
  }
}

function sameFolders(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function definitionChanged(
  current: { include: { path: string }[]; exclude: string[]; ocr: boolean; image: boolean },
  next: LibraryDefinition,
): boolean {
  return (
    current.ocr !== next.ocr ||
    current.image !== next.image ||
    !sameFolders(
      current.include.map((folder) => folder.path),
      next.include,
    ) ||
    !sameFolders(current.exclude, next.exclude)
  );
}

const [getApplication, setApplication] = createContext<ApplicationContext>();

export function createApplication(): ApplicationContext & { start(): () => void } {
  return new Application();
}

export function provideApplication(application: ApplicationContext): void {
  setApplication(application);
}

export function useApplication(): ApplicationContext {
  return getApplication();
}
