<!--
  @component
  Paints a tile's visual-match map over the part of the tile the image occupies. The map's region
  is in source-image fractions, so it is placed by the same contain/cover fit as the `<img>`.
-->
<script lang="ts">
  import type { TileMatchMap } from "../lib/patch-features/tile-match-areas.svelte";

  let {
    map,
    sourceWidth,
    sourceHeight,
    cover,
    fade,
  }: {
    map: TileMatchMap;
    /** Natural image size; 0 when unknown, in which case the image fills the tile. */
    sourceWidth: number;
    sourceHeight: number;
    /** Matches `object-fit: cover` on the tile image; otherwise `contain`. */
    cover: boolean;
    /** Opacity multiplier from the tile's score within the result set. */
    fade: number;
  } = $props();

  let boxWidth = $state(0);
  let boxHeight = $state(0);
  const image = $derived(new ImageData(map.pixels, map.columns, map.rows));
  const placement = $derived.by(() => {
    const width = sourceWidth || boxWidth;
    const height = sourceHeight || boxHeight;
    const scale = (cover ? Math.max : Math.min)(boxWidth / width, boxHeight / height);
    const imageWidth = width * scale;
    const imageHeight = height * scale;
    const [x, y, regionWidth, regionHeight] = map.region;
    return {
      left: (boxWidth - imageWidth) / 2 + x * imageWidth,
      top: (boxHeight - imageHeight) / 2 + y * imageHeight,
      width: regionWidth * imageWidth,
      height: regionHeight * imageHeight,
    };
  });

  function paint(canvas: HTMLCanvasElement): void {
    canvas.getContext("2d")?.putImageData(image, 0, 0);
  }
</script>

<div
  class="tile-match-clip"
  aria-hidden="true"
  style:--match-fade={fade}
  bind:clientWidth={boxWidth}
  bind:clientHeight={boxHeight}
>
  {#if boxWidth && boxHeight}
    {#each ["tint", "cover"] as layer (layer)}
      <canvas
        class={["tile-match-map", `tile-match-${layer}`]}
        width={map.columns}
        height={map.rows}
        style:left={`${placement.left}px`}
        style:top={`${placement.top}px`}
        style:width={`${placement.width}px`}
        style:height={`${placement.height}px`}
        {@attach paint}
      ></canvas>
    {/each}
  {/if}
</div>

<style>
  /* The frame's content box, where the image is drawn. */
  .tile-match-clip {
    position: absolute;
    inset: var(--space-2);
    overflow: hidden;
    pointer-events: none;
  }

  .tile-match-map {
    position: absolute;
  }

  .tile-match-tint {
    opacity: calc(var(--tile-match-map-opacity) * var(--match-fade));
    mix-blend-mode: var(--match-map-blend);
  }

  .tile-match-cover {
    opacity: calc(var(--tile-match-map-cover-opacity) * var(--match-fade));
  }
</style>
