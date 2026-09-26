import { createContext } from "svelte";
import { get } from "svelte/store";

import type { LibraryDefinition, LibraryId } from "../../../shared/backend";
import type { ThumbnailBackfillOptions } from "./job-params";

import { CatalogController, type LibraryRecord } from "./catalog.svelte";
import { ONBOARDING_DISMISSED_STORAGE_KEY } from "./constants";
import { errorMessage } from "./errors";
import { JobOrchestrator } from "./job-orchestrator.svelte";
import { stopsForRuntimeSwitch } from "./job-state";
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
  /** Holds scans that library or search settings changes would start until the dialog closes,
   * then runs one scan of the selected library. */
  readonly beginDeferringScans: () => void;
  readonly endDeferringScans: () => void;
  /** Shows a failure that is not a job's, such as adding a folder, in the gallery overlay. */
  readonly showProblem: (problem: AppProblem) => void;
  readonly dismissProblem: () => void;
  /** Reruns startup after `problem.retry` was offered. */
  readonly retryStartup: () => void;
}

/** A failure outside any job, shown over the gallery until dismissed or retried. */
export interface AppProblem {
  title: string;
  guidance: string;
  /** Technical text for copying. */
  message: string;
  /** Startup failures offer Retry, which reruns startup, instead of Dismiss. */
  retry?: boolean;
}

export interface ApplicationContext {
  readonly services: ApplicationServices;
  readonly commands: ApplicationCommands;
  readonly initialized: boolean;
  readonly librarySelectionRevision: number;
  readonly welcomeVisible: boolean;
  readonly problem: AppProblem | null;
}

class Application implements ApplicationContext {
  readonly services: ApplicationServices;
  readonly commands: ApplicationCommands;
  initialized = $state(false);
  problem = $state.raw<AppProblem | null>(null);
  librarySelectionRevision = $state(0);
  welcomeVisible = $state(false);

  private started = false;
  private backendInitialized = false;
  private deferringScans = false;
  /** The library whose scan is held while a settings dialog is open. */
  private deferredScan: LibraryId | null = null;

  constructor() {
    const ocrSearch = new OcrSearchController();
    // Only the library on screen is indexed: leaving one stops its scan, and opening one scans
    // whatever its folders still need.
    const catalog = new CatalogController((previous, next) => {
      if (!catalog.backendStatus.ready) return;
      void jobs.cancelLibraryScans(previous);
      if (next !== null) this.requestPendingScan(next);
    });
    const runtime = new RuntimeController(() => this.stopJobsForRuntimeSwitch());
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
        if (this.deferredScan === libraryId) this.deferredScan = null;
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
      beginDeferringScans: () => {
        this.deferringScans = true;
      },
      showProblem: (problem: AppProblem) => {
        this.problem = problem;
      },
      dismissProblem: () => {
        this.problem = null;
      },
      retryStartup: () => {
        this.problem = null;
        void this.initialize();
      },
      endDeferringScans: () => {
        this.deferringScans = false;
        const libraryId = this.deferredScan;
        this.deferredScan = null;
        if (libraryId !== null && libraryId === catalog.selectedId)
          void orchestrator.scan(libraryId);
      },
    });
  }

  start(): () => void {
    if (this.started) throw new Error("Application lifecycle already started");
    this.started = true;

    const { catalog, runtime, orchestrator, jobs } = this.services;
    const unsubscribeSettings = settings.subscribe((value) => {
      catalog.onSettingsChange(value);
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
    const { catalog } = this.services;
    try {
      await catalog.initialize();
      this.initialized = true;
      if (catalog.backendStatus.ready) await this.initializeReadyBackend();
    } catch (error) {
      this.initialized = true;
      this.problem = {
        title: "Couldn't open the gallery",
        guidance: "Nicegal couldn't reach its gallery service. Try again, or restart the app.",
        message: errorMessage(error),
        retry: true,
      };
    }
  }

  private async recoverBackend(): Promise<void> {
    await this.services.catalog.loadLibraries();
    await this.initializeReadyBackend();
    const { catalog, orchestrator, jobs } = this.services;
    orchestrator.backendReady();
    await jobs.sync();
    // A restart drops running and queued scans. A routine scan may have started with no
    // pending folder flag, so rescan every folder. The directory check is enough: indexing
    // covers every asset the current models still lack, including after a model change. A
    // restart from Settings (model or provider change) waits until the dialog closes.
    if (catalog.selectedId === null) return;
    if (this.deferringScans) this.deferredScan = catalog.selectedId;
    else await orchestrator.scan(catalog.selectedId);
  }

  /**
   * Stops indexing so a model or provider switch can restart the gallery service. The restart
   * resumes the selected library's scan once Settings closes; holding it here as well covers a
   * switch that fails. Returns why the switch has to wait, or null.
   */
  private async stopJobsForRuntimeSwitch(): Promise<string | null> {
    const { catalog, jobs, orchestrator } = this.services;
    if (!jobs.running) return null;
    if (!jobs.active || !stopsForRuntimeSwitch(jobs.active.type))
      return "Switch after the current job finishes.";
    if (this.deferringScans && catalog.selectedId !== null) this.deferredScan = catalog.selectedId;
    // Cancelling is cooperative, and the backend refuses the switch until the job has ended. A
    // scan the backend had queued can start in the meantime, so cancel whatever is running.
    const deadline = Date.now() + 30_000;
    while (jobs.running && Date.now() < deadline) {
      if (jobs.active?.status !== "cancelling") await orchestrator.cancel();
      await new Promise((resolve) => setTimeout(resolve, 250));
      await jobs.sync();
    }
    return jobs.running ? "Indexing didn't stop in time. Try again." : null;
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
    try {
      // Follow whatever the backend is already running or has queued from its last session.
      await jobs.sync();
      await orchestrator.resumeInterruptedJob(catalog.selectedId);
      // Opening the app checks the selected library's directories for changes.
      if (catalog.selectedId !== null) await orchestrator.scan(catalog.selectedId);
    } catch (error) {
      this.problem = {
        title: "Couldn't check the library for changes",
        guidance: "Rescan the library to try again.",
        message: errorMessage(error),
      };
    }
  }

  /** Called after every terminal job: library state may have moved, and the backend may have
   * started the next queued scan. */
  private async afterJob(): Promise<void> {
    const { catalog, jobs, runtime } = this.services;
    // A scan may have prepared a model or failed to; the status bar's search warning reads this.
    void runtime.refreshModels();
    await catalog.loadLibraries();
    void catalog.refreshLibraryStatuses();
    await jobs.sync();
  }

  private async createLibrary(folder: string): Promise<LibraryRecord> {
    const { catalog } = this.services;
    await catalog.loadLibraries();
    if (catalog.librariesError)
      throw new Error(`Couldn't check existing libraries: ${catalog.librariesError}`);
    const existing = catalog.libraries.find((library) =>
      library.include.some((included) => sameFolder(included.path, folder)),
    );
    if (existing) {
      throw new Error(
        `That folder is already in “${existing.displayName}”. Select that library or add a different folder.`,
      );
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
      if (this.deferringScans || updated.include.some((folder) => folder.scanPending))
        this.requestPendingScan(libraryId);
    } else {
      catalog.updateLibraryViewState(libraryId, { name });
    }
  }

  private requestPendingScan(libraryId: LibraryId): void {
    if (this.deferringScans) this.deferredScan = libraryId;
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
  current: Omit<LibraryDefinition, "include"> & { include: { path: string }[] },
  next: LibraryDefinition,
): boolean {
  return (
    current.ocr !== next.ocr ||
    current.image !== next.image ||
    current.videos !== next.videos ||
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
