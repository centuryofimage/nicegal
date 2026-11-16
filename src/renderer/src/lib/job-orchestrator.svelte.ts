import { get } from "svelte/store";

import type { JobTracker } from "./job-tracker.svelte";

import { type JobRequest, type JobSnapshot, type LibraryId } from "../../../shared/backend";
import { isTerminalJobStatus } from "./job-state";
import { settings } from "./settings.svelte";

/** Issues explicit user commands. Rust owns scheduling, recovery and completion side effects. */
export class JobOrchestrator {
  /** A scan was interrupted by a deliberate provider fallback. Cleared once the backend is ready
   * again, when Rust recovers background work. */
  restartingIndex = $state(false);

  constructor(private readonly jobs: JobTracker) {}

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
    await this.jobs.cancelAll();
  }

  backendDisconnected(providerFallback = false): boolean {
    this.restartingIndex =
      providerFallback &&
      this.jobs.active?.type === "libraryScan" &&
      !isTerminalJobStatus(this.jobs.active.status);
    return this.restartingIndex;
  }

  backendReady(): void {
    this.restartingIndex = false;
  }

  async startJob(request: JobRequest): Promise<JobSnapshot | null> {
    return this.jobs.start(request);
  }

  /** The backend owns both purge and definition removal, even if this client disconnects. */
  async purgeLibrary(libraryId: LibraryId): Promise<boolean> {
    return (
      (await this.jobs.start({
        type: "libraryPurge",
        params: { libraryId, removeLibrary: true },
      })) !== null
    );
  }

  /**
   * Removes indexed data for folders no longer covered by this library. A purge needs the worker
   * to itself, so whatever runs is stopped first; a stopped scan is requested again behind it.
   */
  async purgeRemovedFolders(libraryId: LibraryId, folders: string[]): Promise<boolean> {
    if (!folders.length) return true;
    const stopped = await this.stopForPurge();
    if (!stopped) return false;
    const snapshot = await this.jobs.start({
      type: "libraryPurge",
      params: { libraryId, folders },
    });
    if (snapshot && stopped.resumeScan !== null) await this.scan(stopped.resumeScan);
    return snapshot !== null;
  }

  /**
   * Cancels the running job and queued scans, then waits for the backend to wind them down.
   * Returns the library whose scan was stopped, or null when it did not stop in time.
   */
  private async stopForPurge(): Promise<{ resumeScan: LibraryId | null } | null> {
    await this.jobs.sync();
    const { active } = this.jobs;
    const resumeScan =
      (active?.type === "libraryScan" && !isTerminalJobStatus(active.status)
        ? active.libraryId
        : this.jobs.queued[0]?.libraryId) ?? null;
    // Cancelling is cooperative, and a scan the backend had queued can start in the meantime.
    const deadline = Date.now() + 30_000;
    while (this.jobs.running || this.jobs.queued.length) {
      if (Date.now() >= deadline) return null;
      if (this.jobs.active?.status !== "cancelling") await this.cancel();
      await new Promise((resolve) => setTimeout(resolve, 250));
      await this.jobs.sync();
    }
    return { resumeScan };
  }
}
