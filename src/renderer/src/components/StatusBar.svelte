<!--
  @component
  Gallery workspace status segments. AppShell owns the window's one physical status bar and lays
  these out left to right, divided by hairlines the way an Explorer status bar is:

      [catcopy] [84 / 103 items] [provider] … [transient message] [98 / 103 scanned]

  The item count lives here rather than inside the search field: search-bar width is scarce and
  the status bar has spare width by construction. One segment carries both readings — the library
  size at rest, matched-of-total during a search — so there is no duplicated denominator. Indexing
  sits at the far right while image-search coverage is incomplete. Once scanning catches up, that
  segment disappears only when its eligible-image total also duplicates the library count.
-->
<script lang="ts">
  import type { JobSnapshot } from "../../../shared/backend";
  import type { LibraryRowStatus } from "../lib/catalog.svelte";
  import type { RuntimeController } from "../lib/runtime.svelte";

  import { jobRateText } from "../lib/job-format";

  let {
    libraryName,
    libraryTitle,
    hasLibrary,
    matchedCount,
    totalCount,
    filtering,
    searching,
    selectedCount,
    status,
    message,
    backendReady,
    backendError,
    runtime,
    job = null,
    onsettings,
  }: {
    libraryName: string;
    /** Tooltip for the library name: its included folders. */
    libraryTitle: string;
    /** No library selected means no counts to show; the layout switch disables rather than hides. */
    hasLibrary: boolean;
    matchedCount: number;
    totalCount: number;
    /** Whether a search is narrowing the gallery, which is what flips the items segment's meaning. */
    filtering: boolean;
    searching: boolean;
    selectedCount: number;
    status: LibraryRowStatus | undefined;
    message: string | undefined;
    backendReady: boolean;
    backendError: string | null;
    runtime: RuntimeController;
    job?: JobSnapshot | null;
    onsettings: () => void;
  } = $props();

  const providerLabels: Record<string, string> = {
    cpu: "CPU",
    directml: "DirectML",
    openvino: "OpenVINO",
    webgpu: "WebGPU",
    coreml: "CoreML",
  };

  const providerText = $derived(
    runtime.activeProvider
      ? (providerLabels[runtime.activeProvider] ?? runtime.activeProvider) +
          (runtime.status?.restartRequired ? " ⟳" : "")
      : "",
  );
  const modelFailure = $derived(
    runtime.modelError ||
      (runtime.models &&
        Object.values(runtime.models).find((model) => model.state === "failed")?.error),
  );
  // `activeProvider` is the real loaded-model provider once known; `status.activeExecutionProvider`
  // is only what the process was launched with. They can differ when a launch-time provider failed
  // to compile and OCR silently fell back further (see RuntimeController.actualExecutionProvider).
  const providerTitle = $derived.by(() => {
    const active = runtime.activeProvider;
    if (!active) return undefined;
    const launched = runtime.status;
    if (launched?.restartRequired) {
      return `Running on ${active}; restart to switch to ${launched.configuredExecutionProvider}`;
    }
    if (
      launched &&
      runtime.actualExecutionProvider &&
      runtime.actualExecutionProvider !== launched.activeExecutionProvider
    ) {
      return `Running on ${active}; ${launched.activeExecutionProvider} failed to load and fell back automatically`;
    }
    return `Execution provider: ${active}`;
  });

  const itemsText = $derived(
    filtering && matchedCount !== totalCount
      ? `${matchedCount.toLocaleString()} / ${totalCount.toLocaleString()} items`
      : `${totalCount.toLocaleString()} items`,
  );
  const itemsTitle = $derived(
    filtering && matchedCount !== totalCount
      ? `${matchedCount.toLocaleString()} of ${totalCount.toLocaleString()} items match the current search`
      : undefined,
  );

  const indexText = $derived.by(() => {
    const coverage = status?.imageCoverage;
    if (!coverage || coverage.total === 0) return "";
    if (coverage.indexed === coverage.total) {
      return coverage.total === totalCount ? "" : `${coverage.indexed.toLocaleString()} scanned`;
    }
    return `${coverage.indexed.toLocaleString()} / ${coverage.total.toLocaleString()} scanned`;
  });
  const rateText = $derived(job ? jobRateText(job) : "");
</script>

<span class="status-segment library" title={libraryTitle || undefined}>{libraryName}</span>
{#if hasLibrary}
  <span class="status-segment count" role="status" title={itemsTitle}>{itemsText}</span>
  {#if selectedCount > 0}
    <span class="status-segment count" role="status">{selectedCount.toLocaleString()} selected</span
    >
  {/if}
{/if}
{#if !backendReady && backendError}
  <span class="status-segment backend-crashed" role="status" title={backendError}
    >Service unavailable</span
  >
{:else if runtime.activeProvider}
  <span class="status-segment provider" title={providerTitle}>{providerText}</span>
{/if}
{#if runtime.error || modelFailure}
  <button
    class="status-segment status-action"
    onclick={onsettings}
    title="Open Settings to review the error">Search setup needs attention</button
  >
{/if}
<span class="status-segment message" role="status">
  {#if searching}<span class="index-activity-indicator active" aria-hidden="true"
    ></span>Searching…{:else}{message ?? ""}{/if}
</span>
{#if hasLibrary}
  {#if indexText}
    <span class="status-segment count index-status">{indexText}</span>
  {/if}
{/if}

{#if rateText}
  <span class="status-segment count job-rate" title="Current phase throughput">{rateText}</span>
{/if}

<style>
  .library {
    max-width: 40%;
  }

  .count {
    flex: none;
    font-variant-numeric: tabular-nums;
  }

  .index-status {
    display: inline-flex;
    align-items: center;
  }

  .index-activity-indicator {
    flex: none;
    width: 6px;
    height: 6px;
    margin-right: var(--space-4);
    border: 1px solid var(--border-strong);
    border-radius: 50%;
    background: var(--surface-1);
  }

  .index-activity-indicator.active {
    border-color: var(--accent);
    border-top-color: transparent;
    animation: index-activity-spin 850ms linear infinite;
  }

  @keyframes index-activity-spin {
    to {
      transform: rotate(1turn);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .index-activity-indicator.active {
      border-top-color: var(--accent);
      background: var(--accent);
      animation: none;
    }
  }

  .provider {
    flex: none;
  }

  .backend-crashed {
    flex: none;
    color: var(--danger);
  }
  .status-action {
    flex: none;
    border: 0;
    background: transparent;
    color: var(--danger);
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }

  .message {
    display: inline-flex;
    align-items: center;
    flex: 1;
    min-width: 0;
    color: var(--text-secondary);
  }
</style>
