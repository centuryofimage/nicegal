import type { JobRequest, JobSnapshot, LibraryId } from "../../../shared/backend";

import { cleanDiagnostic, errorMessage } from "./errors";
import { acknowledgeJobErrors, newJobErrors } from "./job-error-history";
import { summarizeCompletion } from "./job-format";
import { isTerminalJobStatus } from "./job-state";

const COMPLETION_MESSAGE_MS = 6_000;

export interface JobFailure {
  title: string;
  guidance: string;
  /** Technical text for copying; "" when the guidance says everything. */
  message: string;
}

export class JobTracker {
  active = $state<JobSnapshot | null>(null);
  /** Covers the request/response gap before the backend returns the first job snapshot. */
  starting = $state(false);
  /** Scans the backend has queued behind the active job, in its order. */
  queued = $state.raw<JobSnapshot[]>([]);
  /** A failure to start, stop or finish following a job, shown over the gallery until dismissed. */
  failure = $state.raw<JobFailure | null>(null);
  /** The failure's technical text, or "" when there is none. */
  get error(): string {
    return this.failure?.message ?? "";
  }
  connectionError = $state<string | null>(null);
  /** Transient result line for the status bar after a terminal job result. */
  completionMessage = $state("");
  /** Folder snapshots change only when a scan ends, never on per-file progress. */
  completedScanRevision = $state(0);

  private previousPhase: JobSnapshot["phase"] | null = null;
  private refreshedThumbnailJobId: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private completionTimer: ReturnType<typeof setTimeout> | null = null;
  /** A job subscription can send its terminal snapshot more than once while it winds down. */
  private completedJobId: string | null = null;
  /** The job this tracker is currently subscribed to — kept separately from `active` since
   * `active` can go back to null on a clean completion while the subscription is still live. */
  private currentJobId: string | null = null;
  private generation = 0;
  private cancelRequested = false;

  constructor(
    private readonly onCatalogRefresh: (delay: number) => void,
    private readonly onThumbnailsGenerated: () => void,
    /** Fires once, exactly when a job reaches a terminal status — independent of whether `active`
     * goes on to clear itself, so callers that need to observe "this job finished" (e.g. clearing
     * a resume record) don't miss it if it's cleared within the same tick. */
    private readonly onTerminal: (snapshot: JobSnapshot) => void,
  ) {}

  get running(): boolean {
    return this.starting || Boolean(this.active && !isTerminalJobStatus(this.active.status));
  }

  /** The library the active job belongs to; null for model preparation or no job. */
  get libraryId(): LibraryId | null {
    return this.active?.libraryId ?? null;
  }

  /** Whether `libraryId` has a running scan, or one waiting in the backend's queue. */
  scanState(libraryId: LibraryId): "scanning" | "queued" | null {
    if (
      this.active?.type === "libraryScan" &&
      this.active.libraryId === libraryId &&
      !isTerminalJobStatus(this.active.status)
    )
      return "scanning";
    return this.queued.some((job) => job.libraryId === libraryId) ? "queued" : null;
  }

  /**
   * Starts a job. Only a `libraryScan` may be requested while another job runs: the backend
   * queues it (or merges it into the library's queued scan) and this tracker lists it in
   * `queued` until it becomes the active job.
   */
  async start(request: JobRequest): Promise<JobSnapshot | null> {
    if (this.running) {
      if (request.type !== "libraryScan") return null;
      try {
        const snapshot = await window.nicegal.backend.startJob(request);
        if (snapshot.status === "queued") this.addQueued(snapshot);
        else if (snapshot.jobId !== this.currentJobId) void this.sync();
        return snapshot;
      } catch (error) {
        this.fail("Couldn't start the job", error);
        return null;
      }
    }
    const generation = ++this.generation;
    this.cancelRequested = false;
    this.failure = null;
    this.connectionError = null;
    this.completionMessage = "";
    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
      this.completionTimer = null;
    }

    let snapshot: JobSnapshot;
    this.starting = true;
    try {
      snapshot = await window.nicegal.backend.startJob(request);
    } catch (error) {
      // Leave the previous job's subscription and `active` snapshot exactly as they were — a
      // failed start must not drop the old subscription while its (now-frozen) snapshot stays
      // on screen.
      if (generation === this.generation) this.fail("Couldn't start the job", error);
      return null;
    } finally {
      if (generation === this.generation) this.starting = false;
    }
    if (generation !== this.generation) return null;
    if (snapshot.status === "queued" && snapshot.type === "libraryScan") {
      // Another client's job holds the slot; follow whichever job is active instead.
      this.addQueued(snapshot);
      await this.sync();
      return snapshot;
    }
    this.attach(snapshot, generation);
    if (this.cancelRequested) await this.cancel();
    return snapshot;
  }

  /**
   * Reads the backend's job list: follows its active job when this tracker is not already, and
   * refreshes `queued`. Scans the backend queues on its own (after library edits or restart)
   * are discovered here.
   */
  async sync(): Promise<void> {
    if (this.starting) return;
    const generation = this.generation;
    let list;
    try {
      list = await window.nicegal.backend.listJobs();
    } catch {
      return; // The next sync retries; a failed poll must not blank known job state.
    }
    if (generation !== this.generation || this.starting) return;
    // Polled every two seconds; republish only when the queue actually changed.
    const queued = list.jobs.filter((job) => job.status === "queued");
    if (
      queued.length !== this.queued.length ||
      queued.some((job, index) => job.jobId !== this.queued[index].jobId)
    )
      this.queued = queued;
    // A subscription may miss its last event. Deliver that result before following the next
    // queued job, so its completion callback can finish the old job's bookkeeping.
    if (this.currentJobId && this.currentJobId !== this.completedJobId) {
      const current = list.jobs.find((job) => job.jobId === this.currentJobId);
      if (current && isTerminalJobStatus(current.status)) this.handleSnapshot(current);
    }
    const active = list.jobs.find((job) => job.jobId === list.activeJobId);
    if (
      active &&
      active.jobId !== this.currentJobId &&
      active.jobId !== this.completedJobId &&
      !isTerminalJobStatus(active.status)
    ) {
      this.failure = null;
      this.completionMessage = "";
      this.attach(active, ++this.generation);
    } else if (active?.jobId === this.currentJobId) {
      // The event stream can disconnect or miss its final event. Keep the visible job current
      // from the same poll that discovers newly active jobs.
      this.handleSnapshot(active);
    }
  }

  /** Cancels the active job and every queued scan. */
  async cancelAll(): Promise<void> {
    const queued = this.queued;
    this.queued = [];
    await Promise.all([
      this.cancel(),
      ...queued.map((job) => window.nicegal.backend.cancelJob(job.jobId).catch(() => undefined)),
    ]);
  }

  /** Cancels a library's running and queued scans, e.g. when the user switches away from it. */
  async cancelLibraryScans(libraryId: LibraryId): Promise<void> {
    const queued = this.queued.filter((job) => job.libraryId === libraryId);
    this.queued = this.queued.filter((job) => job.libraryId !== libraryId);
    await Promise.all([
      this.scanState(libraryId) === "scanning" ? this.cancel() : undefined,
      ...queued.map((job) => window.nicegal.backend.cancelJob(job.jobId).catch(() => undefined)),
    ]);
  }

  private addQueued(snapshot: JobSnapshot): void {
    this.queued = [...this.queued.filter((job) => job.jobId !== snapshot.jobId), snapshot];
  }

  private attach(snapshot: JobSnapshot, generation: number): void {
    // Only now that the new job actually started do we tear down the previous subscription.
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.active = snapshot;
    this.currentJobId = snapshot.jobId;
    this.completedJobId = null;
    this.previousPhase = snapshot.phase;
    this.handleSnapshot(snapshot);
    if (!isTerminalJobStatus(snapshot.status)) {
      this.unsubscribe = window.nicegal.backend.subscribeJob(
        snapshot.jobId,
        (next) => {
          if (generation === this.generation) this.handleSnapshot(next);
        },
        (error) => {
          if (generation === this.generation)
            this.connectionError = error ? errorMessage(error) : null;
        },
      );
    }
    this.queued = this.queued.filter((job) => job.jobId !== snapshot.jobId);
  }

  async cancel(): Promise<void> {
    if (this.starting) {
      this.cancelRequested = true;
      return;
    }
    if (!this.active || isTerminalJobStatus(this.active.status)) return;
    const generation = this.generation;
    try {
      const snapshot = await window.nicegal.backend.cancelJob(this.active.jobId);
      if (generation === this.generation) this.handleSnapshot(snapshot);
    } catch (error) {
      if (generation === this.generation) this.fail("Couldn't stop the job", error);
    }
  }

  /**
   * Acknowledges a terminal result or an operation error. Its file errors are remembered, so a
   * later job that meets only those again reports them in the status bar instead.
   */
  dismiss(): void {
    this.failure = null;
    this.completionMessage = "";
    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
      this.completionTimer = null;
    }
    if (!this.active || !isTerminalJobStatus(this.active.status)) return;

    acknowledgeJobErrors(this.active.errors);
    this.active = null;
  }

  dispose(): void {
    this.generation += 1;
    this.unsubscribe?.();
    if (this.completionTimer) clearTimeout(this.completionTimer);
  }

  backendDisconnected(restarting = false): void {
    const interrupted = this.running;
    this.generation += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.currentJobId = null;
    // The replacement server starts allocating job IDs from the beginning. An ID from the old
    // process must not suppress the new server's active job or thumbnail refresh.
    this.completedJobId = null;
    this.refreshedThumbnailJobId = null;
    this.previousPhase = null;
    this.active = null;
    this.queued = [];
    this.starting = false;
    this.connectionError = null;
    if (restarting) this.failure = null;
    else if (interrupted)
      this.failure = {
        title: "Indexing stopped",
        guidance:
          "The gallery service stopped before this job finished. Indexing resumes when the service is running again. Finished work is kept.",
        message: "",
      };
  }

  private fail(title: string, error: unknown): void {
    this.failure = {
      title,
      guidance: "Try again. If it keeps failing, restart the app.",
      message: errorMessage(error),
    };
  }

  private handleSnapshot(snapshot: JobSnapshot): void {
    if (this.currentJobId && snapshot.jobId !== this.currentJobId) return;
    if (snapshot.jobId === this.completedJobId) return;
    this.connectionError = null;
    snapshot = {
      ...snapshot,
      ...(snapshot.error ? { error: cleanDiagnostic(snapshot.error) } : {}),
      errors: snapshot.errors.map((error) => ({
        ...error,
        message: cleanDiagnostic(error.message),
      })),
    };
    const enteredThumbnailPhase =
      snapshot.phase === "thumbnails" && this.previousPhase !== "thumbnails";
    const generatedThumbnails =
      isTerminalJobStatus(snapshot.status) &&
      snapshot.progress.thumbnailsGenerated > 0 &&
      this.refreshedThumbnailJobId !== snapshot.jobId;
    const isTerminal = Boolean(isTerminalJobStatus(snapshot.status));

    this.active = snapshot;
    this.previousPhase = snapshot.phase;

    // New rows during a scan reach the gallery through the catalog revision poll, which reloads
    // only when rows actually changed. `cataloged` counts files that were already current too, so
    // reloading on it would restart a large catalog load on every progress snapshot.
    if (generatedThumbnails) {
      this.refreshedThumbnailJobId = snapshot.jobId;
      this.onThumbnailsGenerated();
    }
    if (enteredThumbnailPhase || isTerminal) this.onCatalogRefresh(0);
    if (isTerminal) {
      if (snapshot.type === "libraryScan") this.completedScanRevision += 1;
      this.completedJobId = snapshot.jobId;
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.onTerminal(snapshot);
      // A failure or a file error not acknowledged before stays in the canonical job indicator
      // until dismissed. Anything else, including a startup rescan meeting the same unreadable
      // files again, folds into the status bar and frees the toolbar space.
      const needsAttention =
        snapshot.status === "failed" ||
        Boolean(snapshot.error) ||
        newJobErrors(snapshot.errors).length > 0;
      if (!needsAttention) {
        const known = snapshot.errors.length;
        this.completionMessage = [
          summarizeCompletion(snapshot),
          known ? `${known.toLocaleString()} known file error${known === 1 ? "" : "s"}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        this.active = null;
        this.completionTimer = setTimeout(() => {
          this.completionMessage = "";
          this.completionTimer = null;
        }, COMPLETION_MESSAGE_MS);
      }
    }
  }
}
