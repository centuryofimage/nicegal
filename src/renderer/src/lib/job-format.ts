/**
 * Pure presentation helpers for job progress: how a job's phase, label, and progress numbers are
 * shown to the user. Kept separate from `job-tracker.svelte.ts`, which owns the reactive
 * subscription/state side of a job — this module owns "how a job phase is presented" and has no
 * Svelte reactivity of its own.
 *
 * Authoritative source for phase semantics: nicegal-server/INTERNAL_API.md, the job-progress table.
 */
import type { JobPhase, JobProgress, JobSnapshot } from "../../../shared/backend";

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
      "cleanup",
      "pruning",
    ].includes(job.phase) ||
    typeof rate !== "number" ||
    !Number.isFinite(rate) ||
    rate < 0
  )
    return "";
  return `${rate.toLocaleString(undefined, { maximumFractionDigits: 1 })} items/s`;
}

const PHASE_LABELS: Record<JobPhase, string> = {
  queued: "Queued",
  downloadingModels: "Downloading models",
  loadingModels: "Preparing models",
  // Distinct labels: the walk counts files found, then cataloging restarts at 0 of that count.
  // Sharing one label made the second phase look like progress going backwards.
  scanning: "Finding files",
  cataloging: "Syncing",
  thumbnails: "Thumbnails",
  ocr: "OCR",
  imageEmbedding: "Indexing content",
  textEmbedding: "Indexing text",
  cleanup: "Cleanup",
  pruning: "Removing deleted files",
  finished: "Done",
};

const CANCELLED_COMPLETION_LABELS: Record<JobSnapshot["type"], string> = {
  modelPrepare: "Search model preparation",
  ocrModelLoad: "OCR model loading",
  libraryScan: "Library scan",
  thumbnailGenerate: "Thumbnail generation",
  pruneMissing: "Pruning",
  libraryPurge: "Removing",
};

export function jobPhaseLabel(phase: JobPhase): string {
  return PHASE_LABELS[phase];
}

/** Human-facing state for a particular job, distinct from its backend implementation phase. */
export function jobLabel(snapshot: JobSnapshot): string {
  switch (snapshot.status) {
    case "cancelled":
      return "Cancelled";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelling":
      return "Cancelling";
  }

  if (snapshot.phase === "queued") return "Queued";
  if (snapshot.progress.download) return "Downloading models";
  if (snapshot.type === "libraryPurge" && snapshot.phase === "pruning") return "Removing";
  return jobPhaseLabel(snapshot.phase);
}

export function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB"] as const;
  let unit = 0;
  let amount = value;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`;
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
  return { text: fallbackText ?? completed.toLocaleString(), ratio: null };
}

/** Phase-aware display text + completion ratio, shared by the pill (JobIndicator) and the hover
 * card (JobProgress) so both agree on what a phase's progress bar and label show. Byte-counted
 * phases (`downloadingModels`) format as bytes; item-counted phases format as counts. */
export function jobPhaseProgress(snapshot: JobSnapshot): PhaseProgress {
  const { progress } = snapshot;
  if (progress.download) {
    const { downloadedBytes, totalBytes } = progress.download;
    return totalBytes > 0
      ? {
          text: `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`,
          ratio: Math.min(1, downloadedBytes / totalBytes),
        }
      : { text: downloadedBytes > 0 ? formatBytes(downloadedBytes) : "Connecting…", ratio: null };
  }
  switch (snapshot.phase) {
    case "downloadingModels": {
      const { downloadedBytes, downloadTotalBytes } = progress;
      if (downloadTotalBytes > 0) {
        return {
          text: `${formatBytes(downloadedBytes)} / ${formatBytes(downloadTotalBytes)}`,
          ratio: Math.min(1, downloadedBytes / downloadTotalBytes),
        };
      }
      return { text: formatBytes(downloadedBytes), ratio: null };
    }
    case "loadingModels":
      return itemProgress(progress, "Preparing models…");
    case "scanning":
      // `discovered` is what's actually moving while the walk is indeterminate; `total` /
      // `phaseCompleted` only become meaningful once the walk finishes (final discovered count).
      return itemProgress(progress, progress.discovered.toLocaleString());
    case "cataloging":
    case "ocr":
    case "cleanup":
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
        ? {
            ...result,
            text: `${result.text} · processing ${active} ${active === 1 ? "file" : "files"}`,
          }
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
    return `${CANCELLED_COMPLETION_LABELS[snapshot.type]} cancelled`;
  }
  switch (snapshot.type) {
    case "modelPrepare":
      return "Search models ready";
    case "ocrModelLoad":
      return "OCR models ready";
    case "libraryScan": {
      const n = snapshot.progress.cataloged;
      const embedded = snapshot.progress.embedded;
      const unfinished =
        snapshot.folders?.filter((folder) => folder.state !== "completed").length ?? 0;
      return [
        `Scanned ${n.toLocaleString()} file${n === 1 ? "" : "s"}`,
        embedded ? `, indexed ${embedded.toLocaleString()}` : "",
        removedEntrySummary(snapshot.progress.deleted),
        unfinished
          ? ` · ${unfinished.toLocaleString()} folder${unfinished === 1 ? "" : "s"} need${unfinished === 1 ? "s" : ""} attention`
          : "",
      ].join("");
    }
    case "thumbnailGenerate": {
      const n = snapshot.progress.thumbnailsGenerated;
      return `Generated ${n.toLocaleString()} thumbnail${n === 1 ? "" : "s"}`;
    }
    case "pruneMissing": {
      const n = snapshot.progress.deleted;
      return n ? `Deleted ${n.toLocaleString()} missing ${n === 1 ? "entry" : "entries"}` : "";
    }
    case "libraryPurge": {
      const n = snapshot.progress.deleted;
      return `Removed ${n.toLocaleString()} item${n === 1 ? "" : "s"}`;
    }
  }
}

function removedEntrySummary(count: number): string {
  return count
    ? ` · ${count.toLocaleString()} deleted ${count === 1 ? "file" : "files"} removed from library`
    : "";
}

/** The visible phase model: how a job type's backend phases collapse into a small strip of
 * user-facing steps (e.g. `scanning` + `cataloging` both show as "Sync"). */
export type VisiblePhase = { label: string; backendPhases: readonly JobPhase[] };

export const PHASES_BY_TYPE: Record<JobSnapshot["type"], readonly VisiblePhase[]> = {
  modelPrepare: [
    { label: "Prepare", backendPhases: ["downloadingModels", "loadingModels"] },
    { label: "Done", backendPhases: ["finished"] },
  ],
  ocrModelLoad: [
    { label: "Download", backendPhases: ["downloadingModels"] },
    { label: "Load", backendPhases: ["loadingModels"] },
    { label: "Done", backendPhases: ["finished"] },
  ],
  libraryScan: [
    { label: "Sync", backendPhases: ["scanning", "cataloging", "pruning"] },
    { label: "Images", backendPhases: ["imageEmbedding"] },
    { label: "OCR", backendPhases: ["downloadingModels", "loadingModels", "ocr"] },
    { label: "Text", backendPhases: ["textEmbedding"] },
    { label: "Done", backendPhases: ["finished"] },
  ],
  thumbnailGenerate: [
    { label: "Thumbs", backendPhases: ["thumbnails"] },
    { label: "Done", backendPhases: ["finished"] },
  ],
  pruneMissing: [
    { label: "Prune", backendPhases: ["pruning"] },
    { label: "Done", backendPhases: ["finished"] },
  ],
  libraryPurge: [
    { label: "Remove", backendPhases: ["pruning"] },
    { label: "Done", backendPhases: ["finished"] },
  ],
};

/** A scan shows only the index stages its library runs; without `indexStages`, all of them. */
export function jobPhases(job: JobSnapshot): readonly VisiblePhase[] {
  const stages = job.indexStages;
  if (job.type !== "libraryScan" || !stages) return PHASES_BY_TYPE[job.type];
  return PHASES_BY_TYPE.libraryScan.filter(
    (phase) =>
      (!phase.backendPhases.includes("ocr") || stages.ocr) &&
      (!phase.backendPhases.includes("imageEmbedding") || stages.image) &&
      (!phase.backendPhases.includes("textEmbedding") || stages.text),
  );
}
