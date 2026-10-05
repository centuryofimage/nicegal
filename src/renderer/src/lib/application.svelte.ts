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
import { isRemote } from "./platform";
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
  /** The native menu on the desktop; the file action sheet in a remote browser. */
  readonly showFileContextMenu: (assetIds: string[]) => Promise<void>;
  readonly closeFileSheet: () => void;
  /** With `replace`, starts a new visual search from these items ("Find similar images"). */
  readonly addToVisualSearch: (assetIds: readonly string[], replace: boolean) => void;
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
  /** Items the file action sheet is showing, first the one pressed. */
  readonly fileSheet: readonly string[] | null;
}

class Application implements ApplicationContext {
  readonly services: ApplicationServices;
  readonly commands: ApplicationCommands;
  initialized = $state(false);
  problem = $state.raw<AppProblem | null>(null);
  librarySelectionRevision = $state(0);
  welcomeVisible = $state(false);
  fileSheet = $state.raw<readonly string[] | null>(null);

  private started = false;
  private disposed = false;
  private initializationRevision = 0;
  private recoveryRevision = 0;
  private recoveryTask: Promise<void> | null = null;
  private backendInitialized = false;

  constructor() {
    const ocrSearch = new OcrSearchController();
    const catalog = new CatalogController((_previous, next) => {
      this.librarySelectionRevision += 1;
      if (catalog.backendStatus.ready)
        void window.nicegal.backend.setLibraryView(next).catch(() => {});
    });
    const runtime = new RuntimeController(
      () => this.stopJobsForRuntimeSwitch(),
      (model) => catalog.setImageModel(model),
    );
    const jobs: JobTracker = new JobTracker(
      (delay) => catalog.scheduleRefresh(delay),
      () => catalog.bumpThumbnailRevision(),
      () => void this.afterJob(),
    );
    const orchestrator = new JobOrchestrator(jobs);

    this.services = Object.freeze({ catalog, runtime, ocrSearch, jobs, orchestrator });
    this.commands = Object.freeze({
      startFileDrag: async (assetIds: string[], isCurrent: () => boolean) => {
        const token = await window.nicegal.native.prepareFileDrag({ assetIds });
        // A release, cancellation, or newer press during resolution must not start a late drag.
        if (isCurrent()) await window.nicegal.native.startFileDrag(token);
      },
      showFileContextMenu: async (assetIds: string[]) => {
        if (isRemote()) this.fileSheet = assetIds;
        else await window.nicegal.native.showFileContextMenu({ assetIds });
      },
      closeFileSheet: () => {
        this.fileSheet = null;
      },
      addToVisualSearch: (assetIds: readonly string[], replace: boolean) => {
        ocrSearch.addLibraryReferences(
          catalog.items
            .filter((item) => assetIds.includes(item.id))
            .map((item) => ({ id: item.id, displayName: item.displayName })),
          replace,
        );
      },
      createLibrary: (folder: string) => this.createLibrary(folder),
      saveLibrary: (libraryId: LibraryId, definition: LibraryDefinition, name: string | null) =>
        this.saveLibrary(libraryId, definition, name),
      scanLibrary: (
        libraryId: LibraryId,
        options: { scanMode?: "full" | "fast"; pendingOnly?: boolean; retryFailed?: boolean } = {},
      ) => {
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
    });
  }

  start(): () => void {
    if (this.started || this.disposed)
      throw new Error("Application lifecycle already started or disposed");
    this.started = true;

    const { catalog, runtime, orchestrator, jobs } = this.services;
    const unsubscribeSettings = settings.subscribe((value) => {
      catalog.onSettingsChange(value);
    });
    const unsubscribeVisualSearch = window.nicegal.native.onAddToVisualSearch(
      this.commands.addToVisualSearch,
    );
    const unsubscribeBackendStatus = window.nicegal.backend.onBackendStatusChanged((status) => {
      const replaced =
        status.ready &&
        !!status.instanceId &&
        !!catalog.backendStatus.instanceId &&
        status.instanceId !== catalog.backendStatus.instanceId;
      const disconnected = catalog.backendStatus.ready && (!status.ready || replaced);
      if (replaced) catalog.applyBackendStatus({ ready: false, error: null });
      catalog.applyBackendStatus(status);
      if (status.error && orchestrator.restartingIndex) orchestrator.backendDisconnected();
      if (disconnected) {
        this.recoveryRevision += 1;
        this.recoveryTask = null;
        runtime.reset();
        this.services.ocrSearch.suspend();
        const providerFallback = status.restartReason === "provider-fallback";
        const resuming = orchestrator.backendDisconnected(providerFallback);
        this.services.jobs.backendDisconnected(resuming);
      }
      if (status.ready) {
        // A reconnect can miss edits even when Rust did not restart.
        void this.recoverBackend();
      }
    });
    // Jobs are polled as well as followed: the backend queues scans on its own after library
    // edits and restarts, and the next queued scan starts without any client request.
    const revisionPoll = setInterval(() => {
      void catalog.pollRevision();
      if (catalog.backendStatus.ready && document.visibilityState === "visible") {
        void jobs.sync();
        // Preparation may finish between polls, before this window ever follows its job.
        void runtime.refreshModels();
      }
    }, 2_000);
    void this.initialize();

    return () => {
      this.started = false;
      this.disposed = true;
      this.initializationRevision += 1;
      this.recoveryRevision += 1;
      this.recoveryTask = null;
      runtime.dispose();
      unsubscribeSettings();
      unsubscribeVisualSearch();
      unsubscribeBackendStatus();
      clearInterval(revisionPoll);
      this.services.ocrSearch.dispose();
      catalog.dispose();
      this.services.jobs.dispose();
    };
  }

  private async initialize(): Promise<void> {
    if (!this.started) return;
    const revision = ++this.initializationRevision;
    const current = (): boolean => this.started && revision === this.initializationRevision;
    const { catalog } = this.services;
    try {
      await catalog.initialize();
      if (!current()) return;
      this.initialized = true;
      if (catalog.backendStatus.ready) {
        await this.recoverBackend();
      }
    } catch (error) {
      if (!current()) return;
      this.initialized = true;
      this.problem = {
        title: "Couldn't open the gallery",
        guidance: "Nicegal couldn't reach its gallery service. Try again, or restart the app.",
        message: errorMessage(error),
        retry: true,
      };
    }
  }

  /** Startup and reconnect share one operation per backend lifetime. */
  private recoverBackend(): Promise<void> {
    if (!this.started || !this.services.catalog.backendStatus.ready) return Promise.resolve();
    if (this.recoveryTask) return this.recoveryTask;
    const revision = this.recoveryRevision;
    const current = (): boolean =>
      this.started &&
      revision === this.recoveryRevision &&
      this.services.catalog.backendStatus.ready;
    const task = this.restoreBackend(current)
      .catch((error: unknown) => {
        if (!current()) return;
        this.problem = {
          title: "Couldn't reconnect to the gallery",
          guidance: "Try again to refresh the library and resume indexing.",
          message: errorMessage(error),
          retry: true,
        };
      })
      .finally(() => {
        if (this.recoveryTask === task) this.recoveryTask = null;
      });
    this.recoveryTask = task;
    return task;
  }

  private async restoreBackend(current: () => boolean): Promise<void> {
    const { catalog, runtime, orchestrator, jobs } = this.services;
    await catalog.loadLibraries();
    if (!current()) return;
    if (catalog.librariesError) throw new Error(catalog.librariesError);
    const libraryId = catalog.selectedId;
    await Promise.all([runtime.refresh(), runtime.refreshModels()]);
    if (!current()) return;
    await catalog.refreshLibraryStatuses();
    if (!current()) return;
    await jobs.sync();
    if (!current()) return;
    if (!this.backendInitialized) {
      this.welcomeVisible =
        catalog.librariesLoaded && !catalog.libraries.length && !this.welcomeWasDismissed();
      this.backendInitialized = true;
    }
    orchestrator.backendReady();
    // A selection made during recovery has already told the backend through `onSelectionChanged`.
    if (libraryId === catalog.selectedId) await window.nicegal.backend.setLibraryView(libraryId);
  }

  /**
   * Stops indexing so a model or provider switch can restart the gallery service. The restart
   * lets Rust recover background work. Returns why the switch has to wait, or null.
   */
  private async stopJobsForRuntimeSwitch(): Promise<string | null> {
    const { jobs, orchestrator } = this.services;
    await jobs.sync();
    if (!jobs.running) return null;
    if (!jobs.active || !stopsForRuntimeSwitch(jobs.active.type))
      return "Switch after the current job finishes.";
    // Cancelling is cooperative, and the backend refuses the switch until the job has ended. A
    // scan the backend had queued can start in the meantime, so cancel whatever is running.
    const deadline = Date.now() + 30_000;
    while (this.started && jobs.running && Date.now() < deadline) {
      if (!jobs.active || !stopsForRuntimeSwitch(jobs.active.type))
        return "Switch after the current job finishes.";
      if (jobs.active?.status !== "cancelling") await orchestrator.cancel();
      await new Promise((resolve) => setTimeout(resolve, 250));
      await jobs.sync();
    }
    return jobs.running ? "Indexing didn't stop in time. Try again." : null;
  }

  private async afterJob(): Promise<void> {
    if (!this.started) return;
    const revision = this.recoveryRevision;
    const { catalog, jobs, runtime } = this.services;
    // A scan may have prepared a model or failed to; the status bar's search warning reads this.
    void runtime.refreshModels();
    await catalog.loadLibraries();
    if (!this.started || revision !== this.recoveryRevision) return;
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
    return catalog.createLibrary(folder);
  }

  private async saveLibrary(
    libraryId: LibraryId,
    definition: LibraryDefinition,
    name: string | null,
  ): Promise<void> {
    const { catalog } = this.services;
    const current = catalog.definitions.find((library) => library.id === libraryId);
    if (current && definitionChanged(current, definition)) {
      await catalog.updateLibrary(libraryId, definition);
      catalog.updateLibraryViewState(libraryId, { name });
    } else {
      catalog.updateLibraryViewState(libraryId, { name });
    }
  }

  private async startThumbnailBackfill(
    libraryId: LibraryId,
    options: ThumbnailBackfillOptions,
  ): Promise<void> {
    const { jobs, orchestrator } = this.services;
    if (jobs.running) return;
    const buckets = this.toBucketList(options.buckets);
    const { sortField } = get(settings);
    await orchestrator.startJob({
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

  private async removeLibrary(libraryId: LibraryId, purge: boolean): Promise<boolean> {
    const { jobs, orchestrator } = this.services;
    if (jobs.running) return false;
    // A purge deletes the definition itself once it completes; see `JobOrchestrator`.
    if (purge) return orchestrator.purgeLibrary(libraryId);
    await this.services.catalog.deleteLibrary(libraryId);
    return true;
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
