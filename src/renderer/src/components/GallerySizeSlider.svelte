<!--
  @component
  The gallery's image size control, in the status bar the way Explorer and Photos keep zoom at the
  bottom edge. A thin track filled up to the value and a small round thumb; the setting it drives
  follows the layout (row height, column width, or cell width).
-->
<script lang="ts">
  import { m } from "../../../shared/paraglide/messages.js";
  import { settings, settingsLimits } from "../lib/settings.svelte";

  let { menu = false }: { menu?: boolean } = $props();
  const marks = $derived.by(() => {
    const ticks: { value: number; fraction: number }[] = [];
    for (let at = Math.ceil(limits.min / 16) * 16; at <= limits.max; at += 16) {
      ticks.push({ value: at, fraction: (at - limits.min) / (limits.max - limits.min) });
    }
    return ticks;
  });

  const sizeKey = $derived(
    $settings.layoutMode === "justified"
      ? "targetRowHeight"
      : $settings.layoutMode === "masonry"
        ? "masonryColumnWidth"
        : "gridCellWidth",
  );
  const limits = $derived(settingsLimits[sizeKey]);
  const value = $derived($settings[sizeKey]);
  const fill = $derived(`${((value - limits.min) / (limits.max - limits.min)) * 100}%`);
  const title = $derived(
    $settings.layoutMode === "grid" && $settings.gridColumns > 0
      ? m.gallery_size_slider_title_auto_columns()
      : m.gallery_size_slider_title({ value }),
  );

  function setSize(next: number): void {
    settings.update((current) => ({
      ...current,
      [sizeKey]: next,
      ...(current.layoutMode === "grid" ? { gridColumns: 0 } : {}),
    }));
  }
</script>

{#snippet slider()}
  <input
    class={menu ? "ui-trackbar" : "size-slider"}
    type="range"
    aria-label={m.gallery_size_slider_label()}
    aria-valuetext={m.gallery_size_slider_value_text({ value })}
    {title}
    min={limits.min}
    max={limits.max}
    step={limits.step}
    style:--fill={fill}
    bind:value={() => value, setSize}
  />
{/snippet}

{#if menu}
  <div class="menu-size">
    <div class="head">
      <span>{m.gallery_size_slider_label()}</span><span class="readout"
        >{m.gallery_size_slider_value_text({ value })}</span
      >
    </div>
    <div class="ruler" aria-hidden="true">
      {#each marks as mark (mark.value)}
        <span
          class="tick"
          class:major={mark.value % 80 === 0}
          style:left={`calc(${mark.fraction} * (100% - var(--thumb-width)) + var(--thumb-width) / 2)`}
        ></span>
      {/each}
    </div>
    {@render slider()}
  </div>
{:else}
  {@render slider()}
{/if}

<style>
  .menu-size {
    color: var(--text-primary);
  }
  .head {
    display: flex;
    justify-content: space-between;
    padding-bottom: var(--space-3);
  }
  .readout {
    font-variant-numeric: tabular-nums;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }
  .ruler {
    position: relative;
    height: var(--space-7);
  }
  .tick {
    position: absolute;
    bottom: 0;
    width: var(--space-1);
    height: var(--space-3);
    background: var(--tick-mark);
    transform: translateX(-0.5px);
  }
  .tick.major {
    height: var(--space-6);
    background: var(--tick-mark-major);
  }
  .size-slider {
    -webkit-appearance: none;
    appearance: none;
    flex: none;
    align-self: center;
    width: var(--size-slider-width);
    height: 14px;
    margin: 0 var(--space-6);
    padding: 0;
    background: transparent;
    cursor: pointer;
  }

  .size-slider::-webkit-slider-runnable-track {
    height: var(--size-slider-track);
    border-radius: var(--size-slider-track);
    background: linear-gradient(
      to right,
      var(--size-slider-fill) var(--fill),
      var(--size-slider-rail) var(--fill)
    );
  }

  .size-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    box-sizing: border-box;
    width: var(--size-slider-thumb);
    height: var(--size-slider-thumb);
    margin-top: calc((var(--size-slider-track) - var(--size-slider-thumb)) / 2);
    border: 1px solid var(--size-slider-thumb-border);
    border-radius: 50%;
    background: var(--surface-0);
  }

  .size-slider:hover::-webkit-slider-thumb {
    border-color: var(--size-slider-fill);
  }

  .size-slider:active::-webkit-slider-thumb {
    border-color: var(--size-slider-fill);
    background: radial-gradient(var(--size-slider-fill) 35%, var(--surface-0) 40%);
  }

  .size-slider:focus-visible {
    outline: var(--focus-ring);
    outline-offset: 1px;
  }
</style>
