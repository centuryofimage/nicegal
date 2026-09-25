<script lang="ts">
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import X from "@lucide/svelte/icons/x";

  import type { JobSnapshot } from "../../../shared/backend";

  import { jobLabel, jobPhaseProgress } from "../lib/job-format";
  import { popoverDismiss } from "../lib/popover-dismiss";
  import AppMessage from "./AppMessage.svelte";
  import JobErrorsDialog from "./JobErrorsDialog.svelte";
  import JobProgress from "./JobProgress.svelte";

  let {
    job,
    running,
    oncancel,
    ondismiss,
  }: {
    job: JobSnapshot;
    running: boolean;
    oncancel: () => void;
    ondismiss: () => void;
  } = $props();

  const phaseProgress = $derived(jobPhaseProgress(job));
  const count = $derived(phaseProgress.text);
  const label = $derived(jobLabel(job));
  const hasFileErrors = $derived(job.errors.length > 0);
  const needsAttention = $derived(job.status === "failed" || Boolean(job.error) || hasFileErrors);
  const hasMeaningfulTotal = $derived(job.status === "completed" || phaseProgress.ratio !== null);
  const percent = $derived(
    job.status === "completed"
      ? 100
      : hasMeaningfulTotal
        ? Math.round(phaseProgress.ratio! * 100)
        : 0,
  );
  const issueLabel = $derived(
    `${job.errors.length.toLocaleString()} file ${job.errors.length === 1 ? "error" : "errors"} reported`,
  );
  const issueMessage = $derived(
    job.status === "completed"
      ? "The rest of the job completed."
      : running
        ? "The job is continuing with the remaining files."
        : "The job stopped before it could finish.",
  );
  const displayLabel = $derived(
    needsAttention && job.status === "completed" ? "Completed with issues" : label,
  );
  const downloading = $derived(
    running && (Boolean(job.progress.download) || job.phase === "downloadingModels"),
  );
  const compactLabel = $derived(
    downloading
      ? `${job.status === "cancelling" ? "Cancelling" : "Downloading"}${phaseProgress.ratio !== null ? ` ${Math.floor(phaseProgress.ratio * 100)}%` : "…"}`
      : `${displayLabel}${count ? ` · ${count}` : ""}`,
  );
  let cardPinned = $state(false);
  let hiddenAttentionJob = $state<string | null>(null);
  let reviewingErrors = $state(false);
  const cardOpen = $derived(cardPinned || (needsAttention && hiddenAttentionJob !== job.jobId));

  /** Closing a clean result acknowledges it. Failures and file errors stay until dismissed. */
  function closeCard(): void {
    if (!running && !needsAttention) {
      ondismiss();
      return;
    }
    cardPinned = false;
    hiddenAttentionJob = job.jobId;
  }

  function onIndicatorKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    closeCard();
    (event.currentTarget as HTMLElement).blur();
  }

  function toggleCard(): void {
    if (cardOpen) closeCard();
    else cardPinned = true;
  }
</script>

<div
  class:pinned={cardOpen}
  class:needs-attention={needsAttention}
  class="job-anchor"
  {@attach popoverDismiss(cardOpen && !reviewingErrors, closeCard)}
>
  <button
    class:has-cancel={running}
    class="job-indicator"
    type="button"
    aria-controls="job-progress-card"
    aria-expanded={cardOpen}
    aria-label="Show {displayLabel.toLowerCase()} progress"
    onclick={toggleCard}
    onkeydown={onIndicatorKeydown}
  >
    <span class="job-spinner" class:running>
      {#if running}
        <LoaderCircle size={13} aria-hidden="true" />
      {:else if needsAttention}
        <TriangleAlert size={13} aria-hidden="true" />
      {:else}
        <CircleCheck size={13} aria-hidden="true" />
      {/if}
    </span>
    <span class="job-status">
      <span class="job-label">{compactLabel}</span>
    </span>
    {#if running || job.status === "completed"}
      <span
        class:indeterminate={!hasMeaningfulTotal}
        class="mini-track"
        role="progressbar"
        aria-label={`${label} progress`}
        aria-valuemin="0"
        aria-valuemax={hasMeaningfulTotal ? 100 : undefined}
        aria-valuenow={hasMeaningfulTotal ? percent : undefined}
      >
        {#if hasMeaningfulTotal}
          <span class="mini-fill" style:width={`${percent}%`}></span>
        {:else}
          <span class="mini-fill indeterminate-fill"></span>
        {/if}
      </span>
    {/if}
  </button>
  {#if running}
    <button
      class="job-cancel"
      onclick={oncancel}
      title="Cancel"
      aria-label="Cancel {label.toLowerCase()}"
    >
      <X size={11} aria-hidden="true" />
    </button>
  {/if}

  <div id="job-progress-card" class="job-card" inert={!cardOpen}>
    {#key job.jobId}
      <JobProgress {job} />
    {/key}
    {#if job.error}
      <AppMessage
        title="Job failed"
        message={job.error}
        actionLabel={!running && !hasFileErrors ? "Dismiss" : undefined}
        onaction={ondismiss}
      />
    {/if}
    {#if hasFileErrors}
      <section class="issue-summary">
        <strong>{issueLabel}</strong>
        <p>{issueMessage}</p>
        <div class="job-actions">
          <button class="ui-button" onclick={() => (reviewingErrors = true)}>Review errors…</button>
          {#if !running}<button class="ui-button" onclick={ondismiss}>Dismiss job</button>{/if}
        </div>
      </section>
    {:else if job.status === "failed"}
      <AppMessage
        message="This job did not complete. Dismiss it to continue."
        actionLabel="Dismiss"
        onaction={ondismiss}
      />
    {/if}
  </div>
</div>

{#if reviewingErrors}
  <JobErrorsDialog errors={job.errors} onclose={() => (reviewingErrors = false)} />
{/if}

<style>
  .job-anchor {
    position: relative;
    display: flex;
    flex: none;
    align-self: flex-start;
  }

  .job-indicator {
    position: relative;
    display: grid;
    box-sizing: border-box;
    height: var(--toolbar-control-height);
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: var(--space-5);
    padding: 0 var(--space-8);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--font-size-sm);
    text-align: left;
    white-space: nowrap;
    cursor: default;
  }

  .job-indicator.has-cancel {
    padding-right: calc(var(--space-8) + 20px);
  }

  .job-indicator:hover {
    border-color: var(--btn-border-hover);
    background: var(--btn-face-hover);
    color: var(--text-primary);
  }

  .job-spinner {
    display: inline-flex;
  }

  .job-spinner.running :global(svg) {
    animation: spin 1s linear infinite;
  }

  .needs-attention .job-spinner {
    color: var(--danger);
  }

  .needs-attention .job-spinner :global(svg) {
    animation: none;
  }

  .job-status {
    display: flex;
    min-width: 0;
  }

  .job-label {
    overflow: hidden;
    line-height: var(--line-height-tight);
    text-overflow: ellipsis;
  }

  .mini-track {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    box-sizing: border-box;
    height: 3px;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 1px;
    background: var(--track-groove);
    box-shadow: var(--bevel-sunken);
  }

  .mini-fill {
    display: block;
    height: 100%;
    background: var(--accent);
  }

  .mini-track.indeterminate .indeterminate-fill {
    width: 45%;
    background: repeating-linear-gradient(
      135deg,
      var(--accent) 0,
      var(--accent) 3px,
      color-mix(in srgb, var(--accent) 65%, var(--surface-1)) 3px,
      color-mix(in srgb, var(--accent) 65%, var(--surface-1)) 6px
    );
    animation: mini-indeterminate 900ms linear infinite;
  }

  .job-cancel {
    position: absolute;
    top: 50%;
    right: var(--space-8);
    transform: translateY(-50%);
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 1px solid var(--btn-border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .job-cancel:hover {
    border-color: var(--btn-border-hover);
    background: var(--btn-face-hover);
    color: var(--text-primary);
  }

  .job-cancel:active {
    border-color: var(--btn-border-active);
    background: var(--btn-face-active);
  }

  .job-card {
    position: absolute;
    z-index: var(--z-panel);
    top: calc(100% + var(--space-4));
    right: 0;
    box-sizing: border-box;
    width: 310px;
    max-height: calc(100dvh - var(--control-height) - var(--space-12));
    padding: var(--space-9);
    overflow-y: auto;
    border: 1px solid var(--border);
    background: var(--surface-1);
    box-shadow: var(--shadow-overlay);
    opacity: 0;
    pointer-events: none;
    transform: translateY(-2px);
    transition:
      opacity 100ms linear,
      transform 100ms linear;
  }

  .job-anchor.pinned .job-card {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0);
  }

  .job-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-7);
  }

  .issue-summary {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding-top: var(--space-7);
    border-top: 1px solid var(--border-subtle);
  }

  .issue-summary strong {
    color: var(--danger);
    font-weight: var(--font-weight-semibold);
  }
  .issue-summary p {
    margin: 0;
    color: var(--text-secondary);
  }

  .job-actions {
    display: flex;
    gap: var(--space-5);
  }

  .job-actions button {
    padding: var(--space-4) var(--space-7);
  }

  @media (prefers-reduced-motion: reduce) {
    .job-spinner.running :global(svg),
    .mini-track.indeterminate .indeterminate-fill {
      animation: none;
    }
    .mini-track.indeterminate .indeterminate-fill {
      width: 100%;
    }
    .job-card {
      transition: none;
    }
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes mini-indeterminate {
    from {
      transform: translateX(-110%);
    }
    to {
      transform: translateX(250%);
    }
  }
</style>
