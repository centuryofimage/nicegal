<!--
  @component
  The gallery's image size control, in the status bar the way Explorer and Photos keep zoom at the
  bottom edge. A thin track filled up to the value and a small round thumb; the setting it drives
  follows the layout (row height, column width, or cell width).
-->
<script lang="ts">
  import { settings, settingsLimits } from "../lib/settings.svelte";

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
      ? "Image size: adjusting returns to automatic columns"
      : `Image size: ${value} px`,
  );

  function setSize(next: number): void {
    settings.update((current) => ({
      ...current,
      [sizeKey]: next,
      ...(current.layoutMode === "grid" ? { gridColumns: 0 } : {}),
    }));
  }
</script>

<input
  class="size-slider"
  type="range"
  aria-label="Image size"
  aria-valuetext={`${value} px`}
  {title}
  min={limits.min}
  max={limits.max}
  step={limits.step}
  style:--fill={fill}
  bind:value={() => value, setSize}
/>

<style>
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
