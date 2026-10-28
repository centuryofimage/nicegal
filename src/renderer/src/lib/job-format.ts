/**
 * Pure presentation helpers for job progress: how a job's phase, label, and progress numbers are
 * shown to the user. Kept separate from `job-tracker.svelte.ts`, which owns the reactive
 * subscription/state side of a job — this module owns "how a job phase is presented" and has no
 * Svelte reactivity of its own.
 *
 * Authoritative source for phase semantics: nicegal-server/INTERNAL_API.md, the job-progress table.
 */
import type { JobPhase, JobProgress, JobSnapshot } from "../../../shared/backend";

import { m } from "../../../shared/paraglide/messages.js";

type JobType = JobSnapshot["type"];

/** Use the backend's phase rate; missing measurements must not look like zero throughput. */
export function jobRateText(job: JobSnapshot): string {
  const rate = job.progress.itemsPerSecond;
  if (
    (job.status !== "running" && job.status !== "cancelling") ||
    job.progress.download ||
    ![
      "scanning",
      "cataloging",
      "thumbnails",
      "ocr",
      "imageEmbedding",
      "textEmbedding",
      "pruning",
    ].includes(job.phase) ||
    typeof rate !== "number" ||
    !Number.isFinite(rate) ||
    rate < 0
  )
    return "";
  // Image indexing counts each still image and sampled video frame, not files.
  const unit =
    job.phase === "imageEmbedding"
      ? m.job_rate_unit_images_per_second()
      : m.job_rate_unit_items_per_second();
  return m.job_rate_format({ rate, unit });
}

export function jobPhaseLabel(phase: JobPhase): string {
  switch (phase) {
    case "queued":
      return m.job_queued();
    case "loadingModels":
      return m.job_loading_models();
    // Distinct labels: the walk counts files found, then cataloging restarts at 0 of that count.
    // Sharing one label made the second phase look like progress going backwards.
    case "scanning":
      return m.job_scanning();
    case "cataloging":
      return m.job_syncing();
    case "thumbnails":
      return m.job_thumbnails();
    case "ocr":
      return m.job_ocr();
    case "imageEmbedding":
      return m.job_indexing();
    case "textEmbedding":
      return m.job_indexing_text();
    case "pruning":
      return m.job_removing();
    case "finished":
      return m.job_done();
  }
}

/** The subject of a cancelled summary, such as "Library scan cancelled". */
function cancelledSubject(type: JobType): string {
  switch (type) {
    case "modelPrepare":
      return m.job_cancel_label_model_prepare();
    case "libraryScan":
      return m.job_cancel_label_library_scan();
    case "thumbnailGenerate":
      return m.job_cancel_label_thumbnail_generate();
    case "textEmbed":
      return m.job_cancel_label_text_embed();
    case "imageEmbed":
      return m.job_cancel_label_image_embed();
    case "pruneMissing":
      return m.job_cancel_label_prune();
    case "libraryPurge":
      return m.job_removing();
  }
}

/** Human-facing state for a particular job, distinct from its backend implementation phase. */
export function jobLabel(snapshot: JobSnapshot): string {
  switch (snapshot.status) {
    case "cancelled":
      return m.job_cancelled();
    case "completed":
      return m.job_done();
    case "failed":
      return m.job_failed();
    case "cancelling":
      return m.common_cancelling();
  }

  if (snapshot.phase === "queued") return m.job_queued();
  if (snapshot.progress.download) return m.job_downloading_models();
  return jobPhaseLabel(snapshot.phase);
}

function byteUnitLabel(unit: number): string {
  switch (unit) {
    case 0:
      return m.job_unit_bytes();
    case 1:
      return m.job_unit_kib();
    case 2:
      return m.job_unit_mib();
    default:
      return m.job_unit_gib();
  }
}

export function formatBytes(value: number): string {
  const maxUnit = 3;
  let unit = 0;
  let amount = value;
  while (amount >= 1024 && unit < maxUnit) {
    amount /= 1024;
    unit += 1;
  }
  return m.job_bytes_format({ amount, unit: byteUnitLabel(unit) });
}

/** Display text plus a normalized 0-1 completion ratio for a phase, or `ratio: null` when the
 * phase has no honest denominator and should render as indeterminate (per the contract table). */
export interface PhaseProgress {
  text: string;
  ratio: number | null;
}

function itemProgress(progress: JobProgress, fallbackText?: string): PhaseProgress {
  const completed = Math.max(0, progress.phaseCompleted ?? 0);
  const { total } = progress;
  if (total !== null && total > 0) {
    return {
      text: `${completed.toLocaleString()} / ${total.toLocaleString()}`,
      ratio: Math.min(1, completed / total),
    };
  }
  // A stage checking for pending work has no total yet; a bare "0" reads as finished.
  return { text: fallbackText ?? (completed > 0 ? completed.toLocaleString() : ""), ratio: null };
}

/** Phase-aware display text + completion ratio, shared by the pill (JobIndicator) and the hover
 * card (JobProgress) so both agree on what a phase's progress bar and label show. A model download (`progress.download`)
 * formats as bytes; item-counted phases format as counts. */
export function jobPhaseProgress(snapshot: JobSnapshot): PhaseProgress {
  const { progress } = snapshot;
  if (progress.download) {
    const { downloadedBytes, totalBytes } = progress.download;
    return totalBytes > 0
      ? {
          text: `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`,
          ratio: Math.min(1, downloadedBytes / totalBytes),
        }
      : {
          text: downloadedBytes > 0 ? formatBytes(downloadedBytes) : m.job_connecting(),
          ratio: null,
        };
  }
  switch (snapshot.phase) {
    case "loadingModels":
      // The phase label already says "Loading models"; without a total there is no count to add.
      return itemProgress(progress, "");
    case "scanning":
      // `discovered` is what's actually moving while the walk is indeterminate; `total` /
      // `phaseCompleted` only become meaningful once the walk finishes (final discovered count).
      return itemProgress(progress, progress.discovered.toLocaleString());
    case "cataloging":
    case "ocr":
    case "textEmbedding":
    case "thumbnails":
    case "pruning":
      return itemProgress(progress);
    case "imageEmbedding": {
      const result = itemProgress(progress);
      const active = snapshot.activeAssetPaths?.length ?? 0;
      // A video can spend a long time decoding and embedding samples before its one
      // completed item is committed. Show that the worker is active in the meantime.
      return active > 0 && progress.phaseCompleted === 0
        ? { ...result, text: m.job_processing_files({ progress: result.text, count: active }) }
        : result;
    }
    case "queued":
    case "finished":
    default:
      return { text: "", ratio: null };
  }
}

export function summarizeCompletion(snapshot: JobSnapshot): string {
  if (snapshot.status === "cancelled") {
    return m.job_cancelled_summary({ label: cancelledSubject(snapshot.type) });
  }
  switch (snapshot.type) {
    case "modelPrepare":
      return m.job_search_models_ready();
    case "libraryScan": {
      const n = snapshot.progress.cataloged;
      const embedded = snapshot.progress.embedded;
      const unfinished =
        snapshot.folders?.filter((folder) => folder.state !== "completed").length ?? 0;
      return [
        embedded
          ? m.job_scan_scanned_indexed({ count: n, indexed: embedded })
          : m.job_scan_scanned({ count: n }),
        removedEntrySummary(snapshot.progress.deleted),
        unfinished ? m.job_scan_folders_attention({ count: unfinished }) : "",
      ]
        .filter((part) => part !== "")
        .join(m.common_separator());
    }
    case "thumbnailGenerate":
      return m.job_thumbnails_generated({ count: snapshot.progress.thumbnailsGenerated });
    case "textEmbed":
    case "imageEmbed":
      return m.job_files_indexed({ count: snapshot.progress.embedded });
    case "pruneMissing": {
      const n = snapshot.progress.deleted;
      return n ? m.job_prune_deleted({ count: n }) : "";
    }
    case "libraryPurge":
      return m.job_library_purge_removed({ count: snapshot.progress.deleted });
  }
}

function removedEntrySummary(count: number): string {
  return count ? m.job_scan_deleted_removed({ count }) : "";
}

/** The visible phase model: how a job type's backend phases collapse into a small strip of
 * user-facing steps (e.g. `scanning` + `cataloging` both show as "Sync"). */
export type VisiblePhase = { label: string; backendPhases: readonly JobPhase[] };

function phasesFor(type: JobType): readonly VisiblePhase[] {
  switch (type) {
    case "modelPrepare":
      return [
        { label: m.job_step_prepare(), backendPhases: ["loadingModels"] },
        { label: m.job_done(), backendPhases: ["finished"] },
      ];
    case "libraryScan":
      return [
        { label: m.job_step_sync(), backendPhases: ["scanning", "cataloging", "pruning"] },
        { label: m.job_step_images(), backendPhases: ["imageEmbedding"] },
        { label: m.job_ocr(), backendPhases: ["ocr"] },
        { label: m.job_step_text(), backendPhases: ["textEmbedding"] },
        { label: m.job_done(), backendPhases: ["finished"] },
      ];
    case "thumbnailGenerate":
      return [
        { label: m.job_step_thumbs(), backendPhases: ["thumbnails"] },
        { label: m.job_done(), backendPhases: ["finished"] },
      ];
    case "textEmbed":
      return [
        { label: m.job_step_text(), backendPhases: ["textEmbedding"] },
        { label: m.job_done(), backendPhases: ["finished"] },
      ];
    case "imageEmbed":
      return [
        { label: m.job_step_images(), backendPhases: ["imageEmbedding"] },
        { label: m.job_done(), backendPhases: ["finished"] },
      ];
    case "pruneMissing":
      return [
        { label: m.job_step_prune(), backendPhases: ["pruning"] },
        { label: m.job_done(), backendPhases: ["finished"] },
      ];
    case "libraryPurge":
      return [
        { label: m.job_step_remove(), backendPhases: ["pruning"] },
        { label: m.job_done(), backendPhases: ["finished"] },
      ];
  }
}

/** The visible step a job is on, or -1 when its phase has no step, such as `queued`. A scan's
 * model load counts towards the stage it loads for. */
export function jobStepIndex(job: JobSnapshot, phases: readonly VisiblePhase[]): number {
  if (job.status === "completed") return phases.length - 1;
  const phase = job.phase === "loadingModels" ? (job.progress.loadingFor ?? job.phase) : job.phase;
  return phases.findIndex((step) => step.backendPhases.includes(phase));
}

/** A scan shows only the index stages its library runs; without `indexStages`, all of them. */
export function jobPhases(job: JobSnapshot): readonly VisiblePhase[] {
  const phases = phasesFor(job.type);
  const stages = job.indexStages;
  if (job.type !== "libraryScan" || !stages) return phases;
  return phases.filter(
    (phase) =>
      (!phase.backendPhases.includes("ocr") || stages.ocr) &&
      (!phase.backendPhases.includes("imageEmbedding") || stages.image) &&
      (!phase.backendPhases.includes("textEmbedding") || stages.text),
  );
}
