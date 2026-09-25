<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Grid3X3 from "@lucide/svelte/icons/grid-3x3";
  import LayoutDashboard from "@lucide/svelte/icons/layout-dashboard";
  import Rows3 from "@lucide/svelte/icons/rows-3";
  import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";

  import type { Timeline } from "../../../shared/backend";
  import type { DividerGranularity, LayoutMode } from "../lib/gallery/types";
  import type { MediaFilter } from "../lib/search-query";

  import { popoverDismiss } from "../lib/popover-dismiss";
  import { settings, settingsLimits } from "../lib/settings.svelte";
  let {
    layoutMode = $bindable(),
    sortField = $bindable(),
    dateHeaders = $bindable(),
    ranked = false,
    mediaFilter = null,
    onmediachange = () => {},
  }: {
    layoutMode: LayoutMode;
    sortField: Timeline;
    dateHeaders: DividerGranularity;
    ranked?: boolean;
    mediaFilter?: MediaFilter | null;
    onmediachange?: (media: MediaFilter | null) => void;
  } = $props();
  type LayoutOption = {
    value: LayoutMode;
    label: string;
    title: string;
    icon: typeof Rows3;
  };
  const layoutOptions: readonly LayoutOption[] = [
    {
      value: "justified",
      label: "Justified",
      title: "Justified layout — image rows with a shared height",
      icon: Rows3,
    },
    {
      value: "masonry",
      label: "Masonry",
      title: "Masonry layout — variable-height image columns",
      icon: LayoutDashboard,
    },
    {
      value: "grid",
      label: "Grid",
      title: "Grid layout — uniform image cells",
      icon: Grid3X3,
    },
  ];
  const headerOptions: readonly { value: DividerGranularity; label: string }[] = [
    { value: "none", label: "None" },
    { value: "day", label: "Day" },
    { value: "month", label: "Month" },
  ];
  const mediaOptions: readonly { value: MediaFilter | null; label: string }[] = [
    { value: null, label: "All" },
    { value: "image", label: "Images" },
    { value: "video", label: "Videos" },
  ];
  let openMenu = $state(false);
  function chooseLayout(mode: LayoutMode): void {
    layoutMode = mode;
  }
  function chooseSort(field: Timeline): void {
    sortField = field;
  }
  function chooseHeaders(granularity: DividerGranularity): void {
    dateHeaders = granularity;
  }
</script>

{#snippet layoutChoices()}
  <div class="menu-choices" role="radiogroup" aria-label="Gallery layout">
    {#each layoutOptions as option (option.value)}
      <button
        class:selected={layoutMode === option.value}
        type="button"
        role="radio"
        aria-checked={layoutMode === option.value}
        aria-label={`${option.label} layout`}
        title={option.title}
        onclick={() => chooseLayout(option.value)}
      >
        <option.icon size={13} strokeWidth={1.75} aria-hidden="true" />
        <span>{option.label}</span>
      </button>
    {/each}
  </div>
{/snippet}
{#snippet organizationChoices()}
  <div class="organization-menu" aria-label="Media and date organization">
    <div class="organization-group" role="radiogroup" aria-label="Show media">
      <h3>Show media</h3>
      <div class="choice-row">
        {#each mediaOptions as option (option.label)}
          <button
            type="button"
            role="radio"
            aria-label={option.label}
            aria-checked={mediaFilter === option.value}
            onclick={() => onmediachange(option.value)}
          >
            <span class="choice-mark" aria-hidden="true"
              >{#if mediaFilter === option.value}<Check size={12} />{/if}</span
            >{option.label}
          </button>
        {/each}
      </div>
    </div>
    {#if ranked}<p>Date options apply when sorting by Date.</p>{/if}
    <div class="organization-group" role="radiogroup" aria-label="Sort by">
      <h3>Sort by</h3>
      <div class="choice-row">
        <button
          type="button"
          role="radio"
          aria-checked={sortField === "modified"}
          disabled={ranked}
          onclick={() => chooseSort("modified")}
        >
          <span class="choice-mark" aria-hidden="true"
            >{#if sortField === "modified"}<Check size={12} />{/if}</span
          >File date
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={sortField === "capture"}
          disabled={ranked}
          onclick={() => chooseSort("capture")}
        >
          <span class="choice-mark" aria-hidden="true"
            >{#if sortField === "capture"}<Check size={12} />{/if}</span
          >Photo date
        </button>
      </div>
    </div>
    <div class="organization-group" role="radiogroup" aria-label="Date headers">
      <h3>Date headers</h3>
      <div class="choice-row">
        {#each headerOptions as option (option.value)}
          <button
            type="button"
            role="radio"
            aria-checked={dateHeaders === option.value}
            disabled={ranked}
            onclick={() => chooseHeaders(option.value)}
          >
            <span class="choice-mark" aria-hidden="true"
              >{#if dateHeaders === option.value}<Check size={12} />{/if}</span
            >{option.label}
          </button>
        {/each}
      </div>
    </div>
  </div>
{/snippet}
<div class="view-controls" {@attach popoverDismiss(openMenu, () => (openMenu = false))}>
  <button
    class={[
      "app-toolbar-button",
      "app-toolbar-text-button",
      openMenu && "selected",
      mediaFilter && "active",
    ]}
    type="button"
    aria-haspopup="dialog"
    aria-expanded={openMenu}
    onclick={() => (openMenu = !openMenu)}
    ><SlidersHorizontal size={13} aria-hidden="true" /><span>View</span>
    <ChevronDown size={13} aria-hidden="true" /></button
  >
  {#if openMenu}
    <div class="view-menu" role="dialog" aria-label="View options">
      <section>
        <h2>Layout</h2>
        {@render layoutChoices()}
      </section>
      <div class="numeric-options">
        <label
          >Spacing <input type="number" bind:value={$settings.gap} {...settingsLimits.gap} /></label
        >
        {#if layoutMode === "grid"}
          <label
            >Columns <input
              type="number"
              title="0 = automatic columns"
              bind:value={$settings.gridColumns}
              {...settingsLimits.gridColumns}
            /></label
          >
          <p>0 = automatic columns. Adjusting image size restores automatic columns.</p>
        {/if}
      </div>
      <div class="menu-rule" role="separator"></div>
      {@render organizationChoices()}
    </div>
  {/if}
</div>

<style>
  .view-controls,
  .choice-row {
    display: flex;
    align-items: center;
  }
  .view-controls {
    position: relative;
    gap: var(--space-6);
    flex: none;
    align-self: flex-start;
    height: var(--toolbar-control-height);
  }
  .organization-menu button:focus-visible,
  .menu-choices button:focus-visible {
    position: relative;
    z-index: var(--z-raised);
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
  .view-menu {
    position: absolute;
    z-index: var(--z-popover);
    top: calc(100% + var(--space-2));
    display: grid;
    width: 300px;
    max-width: calc(100vw - var(--space-16));
    max-height: calc(100vh - 100px);
    overflow: auto;
    right: 0;
    gap: var(--space-6);
    padding: var(--space-6);
    border: 1px solid var(--border);
    background: var(--surface-0);
    box-shadow: var(--shadow-overlay);
    color: var(--text-primary);
    font-size: var(--font-size-md);
  }
  .view-menu h2,
  .view-menu h3 {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
  }
  .view-menu h2 {
    color: var(--text-primary);
    font-size: var(--font-size-md);
  }
  .view-menu section {
    display: grid;
    gap: var(--space-4);
  }
  .organization-group {
    display: grid;
    gap: var(--space-4);
  }
  .menu-rule {
    height: 1px;
    margin: 0 calc(var(--space-6) * -1);
    background: var(--border-subtle);
  }
  .organization-menu {
    display: grid;
    min-width: 220px;
    gap: var(--space-6);
  }
  .organization-menu p {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .organization-menu button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .choice-row {
    gap: var(--space-4);
  }
  .organization-menu button,
  .menu-choices button {
    display: inline-flex;
    min-height: 22px;
    align-items: center;
    border: 1px solid var(--btn-border);
    border-radius: var(--radius-sm);
    background: var(--btn-face);
    box-shadow: var(--bevel-raised);
    color: var(--text-secondary);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .organization-menu button {
    padding: 0 var(--space-4) 0 var(--space-2);
  }
  .organization-menu button:hover,
  .menu-choices button:hover {
    border-color: var(--btn-border-hover);
    background: var(--btn-face-hover);
    color: var(--text-primary);
  }
  .organization-menu button[aria-checked="true"] {
    border-color: var(--btn-border-active);
    background: var(--btn-face-active);
    box-shadow: var(--bevel-sunken);
    color: var(--text-primary);
  }
  .choice-mark {
    display: inline-flex;
    width: 13px;
    justify-content: center;
    color: var(--accent-active);
  }
  .menu-choices {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-3);
  }
  .menu-choices button {
    justify-content: center;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-3);
    white-space: nowrap;
  }
  .menu-choices button.selected {
    border-color: var(--btn-border-active);
    background: var(--btn-face-active);
    box-shadow: var(--bevel-sunken);
    color: var(--text-primary);
  }
  .numeric-options {
    display: grid;
    gap: var(--space-6);
  }
  .numeric-options label {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .numeric-options input {
    width: 64px;
    padding: var(--space-2) var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: var(--text-primary);
    font: inherit;
  }
  .numeric-options input:focus-visible {
    outline: var(--focus-ring);
  }
  .numeric-options p {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
</style>
