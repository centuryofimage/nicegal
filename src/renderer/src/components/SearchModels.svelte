<script lang="ts">
  import { onMount } from "svelte";

  import type { SearchModelsResponse } from "../../../shared/backend";

  import { useApplication } from "../lib/application.svelte";
  import { cleanDiagnostic } from "../lib/errors";
  import { jobLabel, jobPhaseProgress } from "../lib/job-format";

  const { services } = useApplication();
  const { runtime, jobs, orchestrator, catalog } = services;
  const names: { key: keyof SearchModelsResponse; label: string }[] = [
    { key: "text", label: "Text meaning" },
    { key: "clipImage", label: "Visual search" },
    { key: "clipText", label: "Picture descriptions" },
  ];
  const modelDescriptions: Record<string, string> = {
    "facebook/metaclip-2-worldwide-b32":
      "Good enough for most searches. A balanced starting point.",
    "facebook/metaclip-2-worldwide-b16":
      "Sees more detail and can give slightly better results. Best with a stronger GPU.",
    "facebook/metaclip-2-worldwide-l14":
      "30% more image tokens than MetaCLIP2 B/16, but is very slow. 3GB download",
    "google/siglip2-base-patch16-256":
      "Similar visual search, but prioritizes results differently. Same size as MetaCLIP2 B/16.",
    "deepghs/siglip_beta/smilingwolf/siglip_swinv2_base_2025_02_22_18h56m54s":
      "Specialty model trained on Danbooru tags. Good for anime and art, less useful elsewhere.",
    "facebook/dinov3-vitb16-pretrain-lvd1689m":
      "Very fast indexing and image-to-image search. Does not search from picture descriptions.",
  };
  const modelLicenses: Record<string, { label: string; url: string }> = {
    "facebook/metaclip-2-worldwide-b32": {
      label: "CC BY-NC 4.0",
      url: "https://creativecommons.org/licenses/by-nc/4.0/",
    },
    "facebook/metaclip-2-worldwide-b16": {
      label: "CC BY-NC 4.0",
      url: "https://creativecommons.org/licenses/by-nc/4.0/",
    },
    "facebook/metaclip-2-worldwide-l14": {
      label: "CC BY-NC 4.0",
      url: "https://creativecommons.org/licenses/by-nc/4.0/",
    },
    "facebook/dinov3-vitb16-pretrain-lvd1689m": {
      label: "DINOv3 license",
      url: "https://ai.meta.com/resources/models-and-libraries/dinov3-license",
    },
  };
  let modelLicenseError = $state<string | null>(null);
  async function openModelLicense(
    event: MouseEvent & { currentTarget: HTMLAnchorElement },
  ): Promise<void> {
    event.preventDefault();
    modelLicenseError = null;
    try {
      await window.nicegal.native.openExternalUrl(event.currentTarget.href);
    } catch (cause) {
      modelLicenseError = cause instanceof Error ? cause.message : String(cause);
    }
  }
  const setupJob = $derived(
    jobs.active &&
      (jobs.active.type === "modelPrepare" ||
        jobs.active.type === "ocrModelLoad" ||
        jobs.active.type === "libraryScan")
      ? jobs.active
      : null,
  );
  const settingUp = $derived(
    orchestrator.preparingSearchModels || Boolean(setupJob && jobs.running),
  );
  const download = $derived(settingUp ? setupJob?.progress.download : undefined);
  const downloadProgress = $derived(download && setupJob ? jobPhaseProgress(setupJob) : null);
  const downloadPercent = $derived(
    downloadProgress?.ratio != null ? Math.floor(downloadProgress.ratio * 100) : undefined,
  );
  const currentSetupModel = $derived.by((): string | null => {
    const job = setupJob;
    if (!settingUp || !job || download || job.type === "libraryScan") return null;
    if (job.type === "ocrModelLoad") {
      return job.phase === "downloadingModels" || job.phase === "loadingModels"
        ? "PaddleOCR v6 small detector and recognizer"
        : null;
    }
    if (job.phase !== "loadingModels") return null;
    const imageModel = runtime.imageModel;
    const imageName =
      imageModel?.models.find((model) => model.id === imageModel.activeModel)?.name ??
      imageModel?.activeModel ??
      "Image search model";
    const models = [
      "BGE small English v1.5 · text meaning",
      `${imageName} · image indexing`,
      ...(runtime.supportsImageTextQueries ? [`${imageName} · image text search`] : []),
    ];
    return models[job.progress.phaseCompleted] ?? null;
  });
  const failed = $derived(
    Boolean(
      runtime.modelError ||
      setupJob?.status === "failed" ||
      (runtime.models && Object.values(runtime.models).some((model) => model.state === "failed")),
    ),
  );
  const stopped = $derived(!settingUp && setupJob?.status === "cancelled");
  onMount(() => {
    void runtime.refreshModels();
    const poll = setInterval(() => {
      if (catalog.backendStatus.ready) void runtime.refreshModels();
    }, 2000);
    return () => clearInterval(poll);
  });
</script>

<section aria-labelledby="search-models-title" class="model-section">
  <h2 id="search-models-title">Search</h2>
  {@render preparation()}
  <fieldset
    class="image-model-picker"
    disabled={!runtime.imageModel ||
      runtime.imageModelSaving ||
      runtime.saving ||
      jobs.running ||
      !catalog.backendStatus.ready}
  >
    <legend>Image search model</legend>
    <p class="model-intro">
      Chooses how pictures are compared with example images and descriptions. It does not change OCR
      or related-text search.
    </p>
    <div class="image-model-options">
      {#each runtime.imageModel?.models ?? [] as model (model.id)}
        <div class="image-model-option" class:chosen={model.id === runtime.imageModel?.activeModel}>
          <label>
            <input
              type="radio"
              name="image-search-model"
              value={model.id}
              checked={model.id === runtime.imageModel?.activeModel}
              disabled={!model.available}
              onchange={(event) => runtime.setImageModel(event.currentTarget.value)}
            />
            <span class="model-copy">
              <span class="model-name">{model.name}</span>
              <span class="model-description"
                >{modelDescriptions[model.id] ?? "Visual search model."}</span
              >
            </span>
          </label>
          {#if modelLicenses[model.id]}
            <a href={modelLicenses[model.id].url} onclick={openModelLicense}
              >{modelLicenses[model.id].label}</a
            >
          {/if}
          {#if !model.available}<span class="model-unavailable">Unavailable</span>{/if}
        </div>
      {/each}
    </div>
  </fieldset>
  {#if modelLicenseError}<p class="model-error" role="alert">{modelLicenseError}</p>{/if}
  {#if !runtime.supportsImageTextQueries}
    <p>
      This model finds similar images from image examples. Text descriptions are unavailable; file
      name and OCR text searches still work.
    </p>
  {/if}
  <p>
    {runtime.imageModelSaving
      ? "Switching image model…"
      : "Each model keeps its own index. Switching briefly restarts the gallery service."}
  </p>
  {#if runtime.imageModelError}<p class="model-error" role="alert">
      {runtime.imageModelError}
    </p>{/if}
  {#snippet preparation()}
    <section class="model-setup" aria-label="Search preparation">
      <p>
        Visual search prepares automatically when you add a folder. Downloads happen as needed. Text
        recognition is optional; enable it in Libraries to search words inside pictures.
      </p>
      {#if settingUp || failed || stopped}
        <p class="setup-status" role="status">
          {#if settingUp}Preparing search…{:else if failed}Search needs attention{:else}Search
            preparation stopped{/if}
        </p>
      {/if}
      {#if download && downloadProgress}
        <div class="model-download">
          <p class="model-download-name">Downloading: <strong>{download.modelId}</strong></p>
          <p class="model-download-file">{download.filename}</p>
          <div
            class="model-download-track"
            role="progressbar"
            aria-label={`Downloading ${download.filename}`}
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={downloadPercent}
            aria-valuetext={downloadProgress.text}
          >
            <span
              class:indeterminate={downloadPercent === undefined}
              style:width={downloadPercent === undefined ? "35%" : `${downloadPercent}%`}
            ></span>
          </div>
          <p class="model-download-value">
            {downloadProgress.text}{downloadPercent !== undefined ? ` · ${downloadPercent}%` : ""}
          </p>
        </div>
      {:else if settingUp && setupJob}
        <p>{jobLabel(setupJob)} {jobPhaseProgress(setupJob).text}</p>
      {/if}
      {#if currentSetupModel}
        <p class="current-model" role="status">
          {setupJob?.phase === "downloadingModels" ? "Downloading" : "Preparing"}:
          <strong>{currentSetupModel}</strong>
        </p>
      {/if}
      {#if setupJob?.status === "cancelling"}<p>
          Stopping… Completed downloads and search data will be kept.
        </p>{/if}
      {#if failed || stopped}<p>Use Library manager → Rescan library to resume preparing search.</p>{/if}
      <div class="model-actions">
        {#if settingUp}
          <button
            class="ui-button"
            disabled={!jobs.running || setupJob?.status === "cancelling"}
            onclick={() => orchestrator.cancel()}>Stop preparing search</button
          >
        {/if}
      </div>
      {#if failed}
        <details>
          <summary>Error details</summary>
          {#each names as model (model.key)}
            {@const status = runtime.models?.[model.key]}
            {#if status?.state === "failed" && status.error}<div class="model-error" role="alert">
                {model.label}: {cleanDiagnostic(status.error)}
              </div>{/if}
          {/each}
          {#if runtime.modelError}<p class="model-error" role="alert">{runtime.modelError}</p>{/if}
          {#if setupJob}
            {#if setupJob.error}<p class="model-error" role="alert">
                {cleanDiagnostic(setupJob.error)}
              </p>{/if}
            {#if setupJob.status === "cancelled"}<p>
                Preparation cancelled. You can retry; completed downloads remain cached.
              </p>{/if}
          {/if}
        </details>
      {/if}
    </section>
  {/snippet}
</section>

<style>
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
  p,
  .model-actions {
    margin: var(--space-8) var(--space-9);
  }
  details {
    margin: var(--space-8) var(--space-9);
  }
  summary {
    cursor: pointer;
  }
  .setup-status {
    color: var(--text-primary);
    font-weight: var(--font-weight-semibold);
  }
  .current-model {
    overflow-wrap: anywhere;
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
  .model-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-6);
  }
</style>
