<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";

  import type { RuntimeController } from "../lib/runtime.svelte";

  import { errorMessage } from "../lib/errors";
  import { groupImageModels, imageModels, shortModelName } from "../lib/image-models";

  let {
    runtime,
    disabled,
    compact = false,
  }: { runtime: RuntimeController; disabled: boolean; compact?: boolean } = $props();

  const id = $props.id();
  const popupWidth = 350;

  let popup = $state<HTMLDivElement>();
  let trigger = $state<HTMLButtonElement>();
  let open = $state(false);
  let linkError = $state<string | null>(null);

  const groups = $derived(groupImageModels(runtime.imageModel?.models ?? []));
  const activeModel = $derived(runtime.imageModel?.activeModel);

  /** Opens above the status bar trigger, kept inside the window. */
  function position(): void {
    if (!trigger || !popup) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(popupWidth, window.innerWidth - 16);
    popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    popup.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    popup.style.maxHeight = `${Math.max(0, rect.top - 12)}px`;
  }

  async function choose(event: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const input = event.currentTarget;
    const fieldset = input.closest("fieldset");
    if (compact) {
      popup?.hidePopover();
      trigger?.focus();
    }
    await runtime.setImageModel(input.value);
    // The native radio group changes before the request; a failed switch keeps the old model.
    for (const radio of fieldset?.querySelectorAll<HTMLInputElement>("input[type=radio]") ?? []) {
      radio.checked = radio.value === runtime.imageModel?.activeModel;
    }
  }

  async function openLink(event: MouseEvent & { currentTarget: HTMLAnchorElement }): Promise<void> {
    event.preventDefault();
    linkError = null;
    try {
      await window.nicegal.native.openExternalUrl(event.currentTarget.href);
    } catch (cause) {
      linkError = errorMessage(cause);
    }
  }
</script>

{#snippet options()}
  <fieldset class={["picker", { compact }]} {disabled}>
    <legend>Image search model</legend>
    {#if !compact}
      <p class="intro">
        Chooses how pictures are compared with example images and descriptions. It does not change
        OCR or related-text search.
      </p>
    {/if}
    <div class="options">
      {#each groups as group (group.id)}
        <div class="tier" role="group" aria-labelledby={`${id}-${group.id}`}>
          <div class="tier-heading" id={`${id}-${group.id}`}>
            {group.label}{#if !compact}<span class="tier-description">{group.description}</span
              >{/if}
          </div>
          {#each group.models as model (model.id)}
            {@const info = imageModels[model.id]}
            <div class={["option", { chosen: model.id === activeModel }]}>
              <label title={compact ? info?.description : undefined}>
                <input
                  type="radio"
                  name={`${id}-image-model`}
                  value={model.id}
                  checked={model.id === activeModel}
                  disabled={!model.available}
                  onchange={choose}
                />
                <span class="copy">
                  <span class="name">
                    {compact
                      ? shortModelName(model.name)
                      : model.name}{#if compact && !model.available}
                      · Unavailable{/if}{#if !compact && info?.recommended}<span class="recommended"
                        >Recommended</span
                      >{/if}
                  </span>
                  <span class="description">
                    {(compact ? info?.compactDescription : info?.description) ??
                      "Image search model."}
                  </span>
                </span>
              </label>
              {#if !compact}
                {#if info?.license}
                  <a href={model.url} title="Model page" onclick={openLink}>{info.license}</a>
                {/if}
                {#if !model.available}<span class="unavailable">Unavailable</span>{/if}
              {/if}
            </div>
          {/each}
        </div>
      {/each}
    </div>
  </fieldset>
  {#if linkError}<p class="error" role="alert">{linkError}</p>{/if}
{/snippet}

<svelte:window onresize={() => popup?.hidePopover()} />

{#if compact}
  <button
    class="trigger"
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
    class="popup"
    style:width={`min(${popupWidth}px, calc(100vw - 16px))`}
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
  .picker {
    margin: var(--space-8) var(--space-9);
    padding: 0;
    border: 0;
  }
  legend {
    padding: 0;
    color: var(--text-primary);
    font-weight: var(--font-weight-semibold);
  }
  .intro {
    margin: var(--space-3) 0 var(--space-6);
  }
  .options {
    border: 1px solid var(--border);
  }
  .tier + .tier {
    border-top: 1px solid var(--border);
  }
  .tier-heading {
    display: flex;
    align-items: baseline;
    gap: var(--space-5);
    padding: var(--space-3) var(--space-5);
    background: var(--surface-0);
    color: var(--text-primary);
    font-weight: var(--font-weight-semibold);
  }
  .tier-description {
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    font-weight: normal;
  }
  .option {
    display: flex;
    align-items: center;
    gap: var(--space-6);
    min-height: 43px;
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--border-subtle);
    background: var(--surface-1);
  }
  .option.chosen {
    background: var(--surface-hover);
  }
  label {
    display: flex;
    align-items: start;
    gap: var(--space-5);
    flex: 1;
    min-width: 0;
    cursor: pointer;
  }
  input {
    flex: none;
    margin: 2px 0 0;
    accent-color: var(--accent);
  }
  .copy {
    display: grid;
    gap: var(--space-2);
    min-width: 0;
  }
  .name {
    color: var(--text-primary);
    font-weight: var(--font-weight-semibold);
  }
  .recommended {
    display: inline-block;
    margin-left: var(--space-8);
    padding: 0 var(--space-3);
    border: 1px solid var(--success);
    border-radius: 6px;
    color: var(--success);
    font-size: 10px;
    font-weight: normal;
    vertical-align: 1px;
  }
  .description,
  .unavailable {
    color: var(--text-secondary);
  }
  a,
  .unavailable {
    flex: none;
    font-size: var(--font-size-sm);
  }
  a:focus-visible,
  input:focus-visible,
  .trigger:focus-visible {
    outline: var(--focus-ring);
  }
  .error {
    margin: var(--space-8) var(--space-9);
    color: var(--danger);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  @media (max-width: 550px) {
    .option {
      flex-wrap: wrap;
    }
    a {
      margin-left: 24px;
    }
  }

  .trigger {
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
  .popup {
    box-sizing: border-box;
    position: fixed;
    inset: auto;
    margin: 0;
    padding: var(--space-2);
    overflow: hidden auto;
    white-space: normal;
    border: 1px solid var(--border-strong);
    background: var(--surface-0);
    color: var(--text-primary);
    box-shadow: var(--shadow-overlay);
    font-size: var(--font-size-sm);
  }
  .compact {
    margin: 0;
  }
  .compact legend {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .compact .options,
  .compact .tier + .tier {
    border: 0;
  }
  .compact .tier + .tier {
    margin-top: var(--space-2);
    border-top: 1px solid var(--border-subtle);
  }
  .compact .tier-heading {
    padding: var(--space-3) var(--space-4) var(--space-2);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .compact .option {
    min-height: 0;
    padding: var(--space-3) var(--space-4);
    border: 0;
    background: transparent;
  }
  .compact .option:hover,
  .compact .option:focus-within,
  .compact .option.chosen {
    background: var(--surface-hover);
  }
  .compact .copy {
    gap: 0;
    line-height: var(--line-height-tight);
  }
</style>
