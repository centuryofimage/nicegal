<script lang="ts">
  import { useApplication } from "../lib/application.svelte";

  const { services } = useApplication();
  const { runtime, jobs, catalog } = services;
  const modelDescriptions: Record<string, string> = {
    "facebook/metaclip-2-worldwide-b32":
      "Good for most searches.",
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
</script>

<section aria-labelledby="search-models-title" class="model-section">
  <h2 id="search-models-title">Search</h2>
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
