import type { JobItemError } from "../../../shared/backend";

import { ACKNOWLEDGED_JOB_ERRORS_STORAGE_KEY as STORAGE_KEY } from "./constants";

/**
 * File errors the user acknowledged by dismissing a job, kept across restarts so the startup
 * rescan that meets the same unreadable files again does not raise the job card every launch.
 */

/** Oldest entries fall off first; a file that fails again after that is simply reported again. */
const LIMIT = 5_000;

function errorKey(error: JobItemError): string {
  return `${error.path ?? ""}\n${error.message}`;
}

function readKeys(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((key) => typeof key === "string") : [];
  } catch {
    return [];
  }
}

/** The errors not yet acknowledged in this or an earlier session. */
export function newJobErrors(errors: readonly JobItemError[]): JobItemError[] {
  if (!errors.length) return [];
  const acknowledged = new Set(readKeys());
  return errors.filter((error) => !acknowledged.has(errorKey(error)));
}

export function acknowledgeJobErrors(errors: readonly JobItemError[]): void {
  if (!errors.length) return;
  const keys = new Set(readKeys());
  for (const error of errors) {
    // Re-adding moves a repeat to the newest end, so errors that keep happening are kept longest.
    keys.delete(errorKey(error));
    keys.add(errorKey(error));
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys].slice(-LIMIT)));
  } catch {
    // Best effort, like settings: without storage, a repeated error is shown again.
  }
}
