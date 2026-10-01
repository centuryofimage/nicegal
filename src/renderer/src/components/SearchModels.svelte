<script lang="ts">
  import { useApplication } from "../lib/application.svelte";
  import { jobBlocksRuntimeSwitch, runtimeSwitchJobNote } from "../lib/job-state";
  import ModelPicker from "./ModelPicker.svelte";

  let { onshowservicedetails }: { onshowservicedetails: () => void } = $props();

  const { services } = useApplication();
  const { runtime, jobs, catalog } = services;
  // A running scan is stopped by the switch itself; other jobs have to finish first.
  const jobBlocksSwitch = $derived(jobBlocksRuntimeSwitch(jobs));
  const jobNote = $derived(runtimeSwitchJobNote(jobs));
</script>

<section aria-labelledby="search-models-title" class="model-section">
  <h2 id="search-models-title">Search</h2>
  {#if !catalog.backendStatus.ready && catalog.backendStatus.error}
    <div class="service-status" role="status">
      <span>Search settings are unavailable while the gallery service is offline.</span>
      <button class="ui-button ui-button-compact" onclick={onshowservicedetails}
        >Show details</button
      >
    </div>
  {/if}
  <ModelPicker
    {runtime}
    disabled={!runtime.imageModel ||
      runtime.imageModelSaving ||
      runtime.saving ||
      jobBlocksSwitch ||
      !catalog.backendStatus.ready}
  />
  {#if !runtime.supportsImageTextQueries}
    <p>
      This model finds similar images from image examples. Text descriptions are unavailable; file
      name and OCR text searches still work.
    </p>
  {/if}
  <p>
    {runtime.stoppingJobs
      ? "Stopping indexing…"
      : runtime.imageModelSaving
        ? "Switching image model…"
        : jobNote ||
          "Each model keeps its own index. Switching briefly restarts the gallery service."}
  </p>
  {#if runtime.imageModelError}<p class="model-error" role="alert">
      {runtime.imageModelError}
    </p>{/if}
</section>

<style>
  .service-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
    padding: var(--space-7) var(--space-9);
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .model-section {
    border: 1px solid var(--border);
    background: var(--surface-1);
  }
  h2 {
    margin: 0;
    padding: var(--space-7) var(--space-9);
    border-bottom: 1px solid var(--border-subtle);
    font-size: var(--font-size-md);
  }
  p {
    margin: var(--space-8) var(--space-9);
  }
  p {
    color: var(--text-secondary);
    line-height: var(--line-height-normal);
  }
  .model-error {
    color: var(--danger);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 140px;
    overflow: auto;
    user-select: text;
  }
</style>
