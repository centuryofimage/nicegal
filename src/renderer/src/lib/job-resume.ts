import type { JobRequest, LibraryId, ThumbnailJobRequest } from "../../../shared/backend";

import { JOB_RESUME_STORAGE_KEY } from "./constants";

/**
 * Job types worth auto-resuming after an interrupted app exit. `thumbnailGenerate` is documented
 * as safe to retry — its writes are fingerprinted, so replaying the request skips finished work
 * (see "Jobs" in `nicegal-server/INTERNAL_API.md`). Library scans need no record here: the
 * backend keeps each folder's `scanPending` until a complete scan, and the app scans pending
 * folders when it starts. `pruneMissing` is deliberately excluded: it is a destructive,
 * user-confirmed action and must never restart on its own.
 */
export type ResumableJobRequest = ThumbnailJobRequest;

interface PendingJob {
  libraryId: LibraryId;
  request: ResumableJobRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isLibraryId(value: unknown): value is LibraryId {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isResumable(request: JobRequest): request is ResumableJobRequest {
  return request.type === "thumbnailGenerate";
}

/** Records in-flight job intent so it can be replayed if the app exits before the job finishes. */
export function savePendingJob(request: JobRequest): void {
  if (!isResumable(request) || !isLibraryId(request.params.libraryId)) return;
  try {
    localStorage.setItem(
      JOB_RESUME_STORAGE_KEY,
      JSON.stringify({ libraryId: request.params.libraryId, request } satisfies PendingJob),
    );
  } catch {
    // Best-effort only; losing the resume hint just means no auto-resume next launch.
  }
}

/** Call once a tracked job reaches a confirmed terminal state (completed/failed/cancelled). */
export function clearPendingJob(): void {
  try {
    localStorage.removeItem(JOB_RESUME_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Returns the pending job to replay, if any, scoped to the currently selected library. Records
 * from before library IDs carry a root instead and are ignored. */
export function loadPendingJob(libraryId: LibraryId): ResumableJobRequest | null {
  try {
    const raw = localStorage.getItem(JOB_RESUME_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.libraryId !== libraryId ||
      !isRecord(parsed.request) ||
      parsed.request.type !== "thumbnailGenerate" ||
      !isRecord(parsed.request.params) ||
      parsed.request.params.libraryId !== libraryId
    ) {
      return null;
    }
    return parsed.request as unknown as ResumableJobRequest;
  } catch {
    return null;
  }
}
