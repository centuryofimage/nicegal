import { get } from "svelte/store";

import type { JobTracker } from "./job-tracker.svelte";

import { type JobRequest, type JobSnapshot, type LibraryId } from "../../../shared/backend";
import { clearPendingJob, loadPendingJob, savePendingJob } from "./job-resume";
import { isTerminalJobStatus } from "./job-state";
import { settings } from "./settings.svelte";

/**
 * Coordinates the multi-job intents the backend does not own: scan requests, library purge,
 * and resuming an interrupted thumbnail backfill. The backend never scans on its
 * own; it only queues a requested scan behind a busy worker. JobTracker follows whichever job
 * runs.
 */
export class JobOrchestrator {
  /** A scan was interrupted by a deliberate provider fallback. Cleared once the backend is ready
   * again, when the application requests the selected library's pending folders. */
  restartingIndex = $state(false);

  /** A purge deletes its library only after that exact job completes. `jobId` is null while
   * `JobTracker.start` receives the first snapshot, so an immediately-terminal job still counts. */
  private libraryPurge: { libraryId: LibraryId; jobId: string | null } | null = null;
  /** Job backed by the persisted resume record; only its terminal snapshot clears that record. */
  private resumeTrackedJobId: string | null = null;

  constructor(
    private readonly jobs: JobTracker,
    /** Deletes a library definition once a `libraryPurge` for it completes successfully. */
    private readonly onLibraryPurged: (libraryId: LibraryId) => Promise<void>,
  ) {}

  /**
   * Requests a scan of a library: every folder, or with `pendingOnly` just the folders a create,
   * edit, or earlier interruption left pending. The backend queues it when busy.
   */
  async scan(
    libraryId: LibraryId,
    options: { scanMode?: "full" | "fast"; pendingOnly?: boolean; retryFailed?: boolean } = {},
  ): Promise<void> {
    const { debugIndexLimit } = get(settings);
    await this.jobs.start({
      type: "libraryScan",
      params: {
        libraryId,
        scanMode: options.scanMode ?? "fast",
        ...(options.pendingOnly ? { pendingOnly: true } : {}),
        ...(options.retryFailed ? { retryFailed: true } : {}),
        // The control is dev-only; a value saved by a dev build must not cap release scans.
        ...(import.meta.env.DEV && debugIndexLimit > 0 ? { debugLimit: debugIndexLimit } : {}),
      },
    });
  }

  /** Stops the running job and every queued scan. The backend does not retry a cancelled
   * folder on its own, so the scan resumes only when requested again. */
  async cancel(): Promise<void> {
    this.restartingIndex = false;
    clearPendingJob();
    await this.jobs.cancelAll();
  }

  backendDisconnected(providerFallback = false): boolean {
    this.restartingIndex =
      providerFallback &&
      this.jobs.active?.type === "libraryScan" &&
      !isTerminalJobStatus(this.jobs.active.status);
    this.libraryPurge = null;
    this.resumeTrackedJobId = null;
    return this.restartingIndex;
  }

  backendReady(): void {
    this.restartingIndex = false;
  }

  /** Starts a job and, for the resumable types, records it so an interrupted run picks back up on
   * the next launch — see `lib/job-resume.ts`. */
  async startResumableJob(request: JobRequest): Promise<JobSnapshot | null> {
    const snapshot = await this.jobs.start(request);
    if (snapshot && isTerminalJobStatus(snapshot.status)) {
      clearPendingJob();
      this.resumeTrackedJobId = null;
    } else if (snapshot) {
      this.resumeTrackedJobId = snapshot.jobId;
      savePendingJob(request);
    }
    return snapshot;
  }

  /** Starts a `libraryPurge`; `handleTerminalJob` deletes the library once that exact job
   * completes. Returns false when the job could not start. */
  async purgeLibrary(libraryId: LibraryId): Promise<boolean> {
    this.libraryPurge = { libraryId, jobId: null };
    const snapshot = await this.jobs.start({ type: "libraryPurge", params: { libraryId } });
    const purge = this.libraryPurge;
    if (purge?.libraryId === libraryId && purge.jobId === null) {
      this.libraryPurge = snapshot ? { libraryId, jobId: snapshot.jobId } : null;
    }
    return snapshot !== null;
  }

  /** Removes indexed data for folders no longer covered by this library. */
  async purgeRemovedFolders(libraryId: LibraryId, folders: string[]): Promise<boolean> {
    if (!folders.length) return true;
    const snapshot = await this.jobs.start({
      type: "libraryPurge",
      params: { libraryId, folders },
    });
    return snapshot !== null;
  }

  /** Replays an interrupted thumbnail job for the selected library. */
  async resumeInterruptedJob(libraryId: LibraryId | null): Promise<void> {
    if (libraryId === null || this.jobs.running) return;
    const pending = loadPendingJob(libraryId);
    if (pending) await this.startResumableJob(pending);
  }

  /** The single place a terminal `JobSnapshot` is interpreted against whichever intent it belongs
   * to. Must be wired as `JobTracker`'s `onTerminal` callback. */
  handleTerminalJob(snapshot: JobSnapshot): void {
    if (this.resumeTrackedJobId && snapshot.jobId === this.resumeTrackedJobId) {
      clearPendingJob();
      this.resumeTrackedJobId = null;
    }
    const purge = this.libraryPurge;
    if (
      snapshot.type === "libraryPurge" &&
      purge &&
      (purge.jobId === null || snapshot.jobId === purge.jobId)
    ) {
      this.libraryPurge = null;
      if (snapshot.status === "completed") void this.onLibraryPurged(purge.libraryId);
    }
  }
}
