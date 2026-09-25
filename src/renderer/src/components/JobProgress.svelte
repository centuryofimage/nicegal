<script lang="ts">
  import type { JobSnapshot } from "../../../shared/backend";

  import { formatBytes, jobLabel, jobPhaseProgress, jobPhases } from "../lib/job-format";
  import { isTerminalJobStatus } from "../lib/job-state";
  import JobMetric from "./JobMetric.svelte";

  let { job }: { job: JobSnapshot } = $props();

  type ContextMetric = { label: string; value: string };

  const phases = $derived(jobPhases(job));
  // -1 (not found) is a real, valid result here — it means the current backend phase (e.g.
  // `queued`, or any phase not yet mapped for this job type) isn't one of the visible steps.
  // Leaving it as -1 rather than clamping to 0 means no step is marked current/complete, instead
  // of incorrectly snapping the strip back to the first step.
  const currentPhaseIndex = $derived.by(() => {
    if (job.status === "completed") return phases.length - 1;
    return phases.findIndex((phase) => phase.backendPhases.includes(job.phase));
  });
  const currentLabel = $derived(jobLabel(job));
  const phaseProgress = $derived(jobPhaseProgress(job));
  const activeAssetPaths = $derived(job.activeAssetPaths ?? []);
  let hasShownActiveAssets = $state(false);
  $effect(() => {
    if (activeAssetPaths.length > 0) hasShownActiveAssets = true;
  });
  const hasMeaningfulTotal = $derived(phaseProgress.ratio !== null);
  const phasePercent = $derived(hasMeaningfulTotal ? Math.round(phaseProgress.ratio! * 100) : 0);
  const contextMetrics = $derived.by((): ContextMetric[] => {
    const metrics: ContextMetric[] = [];

    if (job.progress.failed > 0) {
      metrics.push({ label: "Failed", value: job.progress.failed.toLocaleString() });
    }
    if (job.progress.skipped > 0) {
      metrics.push({ label: "Skipped", value: job.progress.skipped.toLocaleString() });
    }
    if (job.type === "ocrModelLoad" && job.progress.downloadedBytes > 0) {
      metrics.push({ label: "Model data", value: formatBytes(job.progress.downloadedBytes) });
    }
    if (job.type === "pruneMissing") {
      if (job.progress.pruneCandidates > 0) {
        metrics.push({ label: "Candidates", value: job.progress.pruneCandidates.toLocaleString() });
      }
      if (job.progress.deleted > 0) {
        metrics.push({ label: "Deleted", value: job.progress.deleted.toLocaleString() });
      }
    }
    if (job.type === "libraryPurge" && job.progress.deleted > 0) {
      metrics.push({ label: "Deleted", value: job.progress.deleted.toLocaleString() });
    }
    if (
      job.type === "libraryScan" &&
      (job.progress.pruneCandidates > 0 || job.progress.deleted > 0)
    ) {
      metrics.push({ label: "Deleted", value: job.progress.deleted.toLocaleString() });
    }

    return metrics.slice(0, 3);
  });
</script>

<div class="job-progress">
  <section class="phase-progress" aria-label="Job phases">
    <div class="phase-track" style:--phase-count={phases.length}>
      {#each phases as phase, index (phase.label)}
        {@const isCurrent = !isTerminalJobStatus(job.status) && index === currentPhaseIndex}
        {@const isComplete = job.status === "completed" || index < currentPhaseIndex}
        <span
          class:complete={isComplete}
          class:current={isCurrent}
          aria-label={`${phase.label}${isCurrent ? ", current phase" : isComplete ? ", complete" : ""}`}
        ></span>
      {/each}
    </div>
    <div class="phase-labels" style:--phase-count={phases.length} aria-hidden="true">
      {#each phases as phase (phase.label)}
        <span>{phase.label}</span>
      {/each}
    </div>
  </section>

  {#if !isTerminalJobStatus(job.status)}
    <section class="within-phase">
      {#if job.progress.download}
        <div class="model-download-name">{job.progress.download.modelId}</div>
        <div class="model-download-file">{job.progress.download.filename}</div>
      {/if}
      <div class="within-phase-heading">
        <span>{currentLabel}</span>
        <span class="progress-value">{phaseProgress.text}</span>
      </div>
      <div
        class:indeterminate={!hasMeaningfulTotal}
        class="progress-track"
        role="progressbar"
        aria-label={`${currentLabel} progress`}
        aria-valuemin="0"
        aria-valuemax={hasMeaningfulTotal ? 100 : undefined}
        aria-valuenow={hasMeaningfulTotal ? phasePercent : undefined}
        aria-valuetext={hasMeaningfulTotal
          ? phaseProgress.text
          : `${phaseProgress.text || "0"} completed; total unknown`}
      >
        {#if hasMeaningfulTotal}
          <span class="progress-fill" style:width={`${phasePercent}%`}></span>
        {:else}
          <span class="progress-fill indeterminate-fill"></span>
        {/if}
      </div>
    </section>
  {/if}

  {#if activeAssetPaths.length || (hasShownActiveAssets && !isTerminalJobStatus(job.status))}
    <section class="active-assets" aria-label="Files being processed">
      <span class="active-assets-label"
        >Processing{activeAssetPaths.length > 1 ? ` · ${activeAssetPaths.length} files` : ""}</span
      >
      <ul>
        {#each activeAssetPaths as path (path)}
          <li title={path}>{path.split(/[\\/]/).pop() || path}</li>
        {/each}
        {#if activeAssetPaths.length === 0}
          <li class="active-assets-idle">Waiting for the next file…</li>
        {/if}
      </ul>
    </section>
  {/if}

  {#if contextMetrics.length}
    <div class="context-metrics">
      {#each contextMetrics as metric (metric.label)}
        <JobMetric label={metric.label} value={metric.value} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .active-assets {
    min-width: 0;
  }

  .active-assets-label {
    color: var(--text-secondary);
  }

  .active-assets ul {
    height: 96px;
    overflow: auto;
    margin: var(--space-3) 0 0;
    padding: 0;
    list-style: none;
  }

  .active-assets li {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
  }

  .active-assets li.active-assets-idle {
    color: var(--text-secondary);
  }

  .job-progress,
  .phase-progress,
  .within-phase,
  .context-metrics {
    display: flex;
    flex-direction: column;
  }

  .job-progress {
    gap: var(--space-7);
  }

  .phase-progress,
  .within-phase {
    gap: var(--space-3);
  }

  .phase-track,
  .phase-labels {
    display: grid;
    grid-template-columns: repeat(var(--phase-count), minmax(0, 1fr));
    gap: 2px;
  }

  .phase-track {
    height: 7px;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--track-groove);
    box-shadow: var(--bevel-sunken);
  }

  .phase-track span {
    min-width: 0;
    background: var(--surface-2);
  }

  .phase-track .complete {
    background: var(--accent);
  }

  .phase-track .current {
    background: color-mix(in srgb, var(--accent) 70%, var(--surface-1));
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .phase-labels {
    color: var(--text-tertiary);
    font-size: var(--font-size-xs);
    line-height: 1;
    text-align: center;
  }

  .phase-labels span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .within-phase-heading {
    display: flex;
    justify-content: space-between;
    gap: var(--space-7);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-tight);
  }

  .progress-value {
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .progress-track {
    position: relative;
    display: flex;
    height: var(--space-12);
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--track-groove);
    box-shadow: var(--bevel-sunken);
  }

  .progress-fill {
    height: 100%;
    background: var(--accent);
  }

  .indeterminate-fill {
    width: 45%;
    background: repeating-linear-gradient(
      135deg,
      var(--accent) 0,
      var(--accent) 5px,
      color-mix(in srgb, var(--accent) 65%, var(--surface-1)) 5px,
      color-mix(in srgb, var(--accent) 65%, var(--surface-1)) 10px
    );
    animation: indeterminate-progress 900ms linear infinite;
  }

  .context-metrics {
    gap: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--border);
  }

  @keyframes indeterminate-progress {
    from {
      transform: translateX(-110%);
    }
    to {
      transform: translateX(250%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .indeterminate-fill {
      animation: none;
      width: 100%;
    }
  }
</style>
