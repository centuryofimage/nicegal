import type { JobSnapshot } from "../../../shared/backend";

import { m } from "../../../shared/paraglide/messages.js";

export function isTerminalJobStatus(status: JobSnapshot["status"]): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

export function isActiveJob(job: JobSnapshot | null | undefined): boolean {
  return Boolean(job && !isTerminalJobStatus(job.status));
}

/**
 * Whether a model or execution provider switch may stop this job first. The switch restarts the
 * gallery service, and a library scan runs again once Settings closes. Jobs that write
 * thumbnails or remove data finish first.
 */
export function stopsForRuntimeSwitch(type: JobSnapshot["type"]): boolean {
  return type === "libraryScan" || type === "modelPrepare";
}

type RunningJobs = { running: boolean; active: JobSnapshot | null };

/** A running job that a model or provider switch has to wait for. */
export function jobBlocksRuntimeSwitch(jobs: RunningJobs): boolean {
  return jobs.running && !(jobs.active && stopsForRuntimeSwitch(jobs.active.type));
}

/** Settings copy for a model or provider switch while a job runs; empty when none runs. */
export function runtimeSwitchJobNote(jobs: RunningJobs): string {
  if (!jobs.running) return "";
  return jobBlocksRuntimeSwitch(jobs) ? m.common_switch_after_job() : m.job_switch_stops_indexing();
}
