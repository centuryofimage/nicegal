<!--
  @component
  Gallery workspace status segments. AppShell owns the window's one physical status bar and lays
  these out left to right, divided by hairlines the way an Explorer status bar is:

      [catcopy] [84 / 103 items] [provider] … [transient message] [98 / 103 scanned]

  The item count lives here rather than inside the search field: search-bar width is scarce and
  the status bar can give it room when available. One segment carries both readings — the library
  size at rest, matched-of-total during a search — so there is no duplicated denominator. Indexing
  sits at the far right while image-search coverage is incomplete. Once scanning catches up, that
  segment disappears only when its eligible-image total also duplicates the library count.
-->
<script lang="ts">
  import X from "@lucide/svelte/icons/x";

  import type { JobSnapshot } from "../../../shared/backend";
  import type { LibraryRowStatus } from "../lib/catalog.svelte";
  import type { RuntimeController } from "../lib/runtime.svelte";

  import { useApplication } from "../lib/application.svelte";
  import { jobRateText } from "../lib/job-format";
  import { jobBlocksRuntimeSwitch } from "../lib/job-state";
  import { searchIssue, type SearchIssue } from "../lib/search-issue";
  import ActivitySpinner from "./ActivitySpinner.svelte";
  import ModelPicker from "./ModelPicker.svelte";

  let {
    libraryName,
    libraryTitle,
    hasLibrary,
    matchedCount,
    totalCount,
    filtering,
    searching,
    mappingPatches,
    selectedCount,
    status,
    message,
    backendReady,
    backendError,
    runtime,
    job = null,
    onsearchproblem,
    dismissedSetupErrorKey,
    ondismisssetup,
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
    mappingPatches: boolean;
    selectedCount: number;
    status: LibraryRowStatus | undefined;
    message: string | undefined;
    backendReady: boolean;
    backendError: string | null;
    runtime: RuntimeController;
    job?: JobSnapshot | null;
    /** Opens the search problem dialog for the warning shown. */
    onsearchproblem: (issue: SearchIssue) => void;
    dismissedSetupErrorKey: string | null;
    ondismisssetup: (key: string) => void;
  } = $props();

  const {
    services: { jobs },
  } = useApplication();
  const modelSwitchDisabled = $derived(
    !backendReady || runtime.saving || runtime.imageModelSaving || jobBlocksRuntimeSwitch(jobs),
  );

  const providerLabels: Record<string, string> = {
    cpu: "CPU",
    directml: "DirectML",
    cuda: "CUDA",
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
  const setupIssue = $derived(searchIssue(runtime));
  // Loaded indexing models share one provider. Before they load, show the launch choice.
  const providerTitle = $derived.by(() => {
    const active = runtime.activeProvider;
    if (!active) return undefined;
    const launched = runtime.status;
    if (launched?.restartRequired) {
      return `Running on ${active}; restart to switch to ${launched.configuredExecutionProvider}`;
    }
    if (
      launched &&
      launched.loadedExecutionProvider &&
      launched.loadedExecutionProvider !== launched.activeExecutionProvider
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
  <span class="status-segment count item-count" role="status" title={itemsTitle}>{itemsText}</span>
  {#if selectedCount > 0}
    <span class="status-segment count selected-count" role="status"
      >{selectedCount.toLocaleString()} selected</span
    >
  {/if}
{/if}
{#if !backendReady && backendError}
  <span class="status-segment backend-crashed" role="status" title={backendError}
    >Service unavailable</span
  >
{:else if runtime.activeProvider}
  <span class="status-segment provider" title={providerTitle}>{providerText}</span>
  {#if hasLibrary && runtime.imageModelName}
    <span class="status-segment image-model">
      <ModelPicker {runtime} disabled={modelSwitchDisabled} compact={true} />
    </span>
  {/if}
{/if}
{#if setupIssue && setupIssue.key !== dismissedSetupErrorKey}
  <span class="status-segment setup-issue">
    <button class="status-action" onclick={() => onsearchproblem(setupIssue)}
      >{setupIssue.label}</button
    >
    <button
      class="dismiss-setup"
      onclick={() => ondismisssetup(setupIssue.key)}
      title="Dismiss this search warning"
      aria-label="Dismiss this search warning"><X size={11} aria-hidden="true" /></button
    >
  </span>
{/if}
{#if searching || mappingPatches || message}
  <span class="status-segment message" role="status">
    {#if searching}<ActivitySpinner /> Searching…{:else if mappingPatches}<ActivitySpinner /> Mapping…{:else}{message}{/if}
  </span>
{/if}
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

  .provider,
  .image-model {
    flex: none;
  }

  .backend-crashed {
    flex: 0 1 auto;
    min-width: 0;
    color: var(--danger);
  }
  .status-action {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    border: 0;
    background: transparent;
    color: var(--danger);
    font: inherit;
    text-decoration: underline;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }

  .setup-issue {
    display: inline-flex;
    flex: 0 1 auto;
    align-items: center;
    gap: var(--space-4);
    min-width: 0;
  }

  .dismiss-setup {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .status-action:focus-visible,
  .dismiss-setup:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .message {
    display: inline-flex;
    align-items: center;
    gap: var(--space-4);
    flex: 1;
    min-width: 0;
    color: var(--text-secondary);
  }

  /* The details area shrinks before the pane buttons and size slider. Drop optional readings
     in order while keeping scan throughput and warning actions available. */
  @container (max-width: 550px) {
    .library {
      display: none;
    }
  }

  @container (max-width: 480px) {
    .selected-count {
      display: none;
    }
  }

  @container (max-width: 410px) {
    .item-count,
    .image-model {
      display: none;
    }
  }

  @container (max-width: 330px) {
    .provider,
    .message {
      display: none;
    }
  }

  @container (max-width: 220px) {
    .index-status {
      display: none;
    }
  }
</style>
