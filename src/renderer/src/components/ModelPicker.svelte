<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";

  import type { RuntimeController } from "../lib/runtime.svelte";

  import { errorMessage } from "../lib/errors";
  import {
    compactModelDescriptions,
    modelDescriptions,
    modelLicenses,
    shortModelName,
  } from "../lib/model-descriptions";

  let {
    runtime,

    disabled,

    compact = false,
  }: {
    runtime: RuntimeController;

    disabled: boolean;

    compact?: boolean;
  } = $props();

  let popup = $state<HTMLDivElement>();

  let trigger = $state<HTMLButtonElement>();

  let open = $state(false);

  const id = $props.id();

  function position(): void {
    if (!trigger || !popup) return;

    const rect = trigger.getBoundingClientRect();

    const width = Math.min(compact ? 350 : 390, window.innerWidth - 16);

    popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;

    popup.style.bottom = `${window.innerHeight - rect.top + 4}px`;

    popup.style.maxHeight = `${Math.max(0, rect.top - 12)}px`;
  }

  function close(): void {
    popup?.hidePopover();
  }

  async function choose(event: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const input = event.currentTarget;

    const group = input.closest("fieldset");

    if (compact) {
      close();

      trigger?.focus();
    }

    await runtime.setImageModel(input.value);

    // The native radio group changes before the request; a failed switch keeps the old model.

    for (const radio of group?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? []) {
      radio.checked = radio.value === runtime.imageModel?.activeModel;
    }
  }

  let modelLicenseError = $state<string | null>(null);

  async function openModelLicense(
    event: MouseEvent & { currentTarget: HTMLAnchorElement },
  ): Promise<void> {
    event.preventDefault();

    modelLicenseError = null;

    try {
      await window.nicegal.native.openExternalUrl(event.currentTarget.href);
    } catch (cause) {
      modelLicenseError = errorMessage(cause);
    }
  }
</script>

{#snippet options()}
  <fieldset class="image-model-picker" class:compact {disabled}>
    <legend class:compact-legend={compact}>Image search model</legend>

    {#if !compact}
      <p class="model-intro">
        Chooses how pictures are compared with example images and descriptions. It does not change
        OCR or related-text search.
      </p>
    {/if}

    <div class="image-model-options">
      {#each runtime.imageModel?.models ?? [] as model (model.id)}
        <div class="image-model-option" class:chosen={model.id === runtime.imageModel?.activeModel}>
          <label title={compact ? modelDescriptions[model.id] : undefined}>
            <input
              type="radio"
              name={`${id}-image-model`}
              value={model.id}
              checked={model.id === runtime.imageModel?.activeModel}
              disabled={!model.available}
              onchange={choose}
            />

            <span class="model-copy">
              <span class="model-name"
                >{compact
                  ? shortModelName(model.name)
                  : model.name}{#if compact && !model.available}
                  · Unavailable{/if}</span
              >

              <span class="model-description"
                >{(compact ? compactModelDescriptions[model.id] : modelDescriptions[model.id]) ??
                  modelDescriptions[model.id] ??
                  "Image search model."}</span
              >
            </span>
          </label>

          {#if !compact}
            {#if modelLicenses[model.id]}
              <a href={modelLicenses[model.id].url} onclick={openModelLicense}
                >{modelLicenses[model.id].label}</a
              >
            {/if}

            {#if !model.available}<span class="model-unavailable">Unavailable</span>{/if}
          {/if}
        </div>
      {/each}
    </div>
  </fieldset>

  {#if modelLicenseError}<p class="model-error" role="alert">{modelLicenseError}</p>{/if}
{/snippet}

<svelte:window onresize={close} />

{#if compact}
  <button
    class="model-trigger"
    bind:this={trigger}
    {disabled}
    popovertarget={id}
    aria-label={`Image search model: ${shortModelName(runtime.imageModelName ?? "")}`}
    aria-expanded={open}
    aria-haspopup="dialog"
    title="Choose image search model"
    onclick={position}
  >
    {shortModelName(runtime.imageModelName ?? "")}<ChevronDown size={10} aria-hidden="true" />
  </button>

  <div
    {id}
    class="model-picker"
    popover="auto"
    role="dialog"
    aria-label="Choose image search model"
    bind:this={popup}
    ontoggle={(event) => (open = event.newState === "open")}
  >
    {@render options()}
  </div>
{:else}
  {@render options()}
{/if}

<style>
  .model-trigger {
    display: inline-flex;

    align-items: center;

    gap: var(--space-2);

    padding: 0;

    border: 0;

    background: transparent;

    color: inherit;

    font: inherit;

    cursor: pointer;
  }

  .model-trigger:focus-visible {
    outline: var(--focus-ring);
  }

  .model-picker {
    box-sizing: border-box;

    position: fixed;

    inset: auto;

    width: min(350px, calc(100vw - 16px));

    margin: 0;

    padding: var(--space-2);

    overflow-x: hidden;

    overflow-y: auto;

    white-space: normal;

    border: 1px solid var(--border-strong);

    background: var(--surface-0);

    color: var(--text-primary);

    box-shadow: var(--shadow-overlay);

    font-size: var(--font-size-sm);
  }

  .image-model-picker.compact {
    margin: 0;
  }

  .compact-legend {
    position: absolute;

    width: 1px;

    height: 1px;

    padding: 0;

    overflow: hidden;

    clip-path: inset(50%);

    white-space: nowrap;
  }

  .compact .image-model-options {
    border: 0;
  }

  .compact .image-model-option {
    min-height: 0;

    padding: var(--space-3) var(--space-4);

    border: 0;

    background: transparent;
  }

  .compact .image-model-option:hover,
  .compact .image-model-option:focus-within,
  .compact .image-model-option.chosen {
    background: var(--surface-hover);
  }

  .compact .model-copy {
    gap: 0;

    line-height: var(--line-height-tight);

    white-space: normal;
  }

  .compact label {
    font: inherit;
  }

  .model-error {
    margin: var(--space-8) var(--space-9);

    color: var(--danger);

    white-space: pre-wrap;

    overflow-wrap: anywhere;
  }
</style>
