<!--
  @component
  Full-media detail view: still images use a measured transform stage while video playback lives
  in VideoPlayer. Original files are requested through the restricted `original://` protocol.
-->
<script module lang="ts">
  export interface DetailViewStatus {
    filename: string;
    width: number | null;
    height: number | null;
    zoom: string | null;
    loading: boolean;
    failed: boolean;
  }
</script>

<script lang="ts">
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import Maximize from "@lucide/svelte/icons/maximize";
  import Minimize from "@lucide/svelte/icons/minimize";
  import Minus from "@lucide/svelte/icons/minus";
  import Plus from "@lucide/svelte/icons/plus";
  import Scan from "@lucide/svelte/icons/scan";
  import ScanEye from "@lucide/svelte/icons/scan-eye";
  import { getAbortSignal, onMount, type Snippet } from "svelte";

  import type { ImageQuery } from "../../../shared/backend";

  import { originalUrlOf, type GalleryItem } from "../lib/gallery/types";
  import { TURBO_GRADIENT } from "../lib/patch-features/colormap";
  import { loadMatchMap, type MatchMap } from "../lib/patch-features/match-map";
  import { similarityPixels } from "../lib/patch-features/similar";
  import { isRemote } from "../lib/platform";
  import { ViewerGestures } from "../lib/viewer-gestures.svelte";
  import VideoPlayer from "./VideoPlayer.svelte";

  type ZoomMode = "fit" | "actual" | "custom";

  type StagePoint = {
    x: number;
    y: number;
  };

  let {
    item,
    initialPlayback = null,
    hasPrev,
    hasNext,
    onclose,
    onprev,
    onnext,
    onstatuschange,
    onfilemenu,
    imageQuery = null,
    imageQueryLabel = "",
    imageModelName = null,
    imageModelVisualizes = true,
    backendReady = true,
    showMatchAreas = $bindable(false),
    toolbarEnd,
  }: {
    item: GalleryItem;
    initialPlayback?: { currentTime: number; muted: boolean } | null;
    hasPrev: boolean;
    hasNext: boolean;
    onclose: () => void;
    onprev: () => void;
    onnext: () => void;
    onstatuschange: (status: DetailViewStatus) => void;
    onfilemenu: () => void;
    /** The active visual search direction, when available. */
    imageQuery?: ImageQuery | null;
    /** The search as the user wrote it, shown while visualizing. */
    imageQueryLabel?: string;
    imageModelName?: string | null;
    /** False when the active image model's patch maps are not meaningful. */
    imageModelVisualizes?: boolean;
    /** Requests wait for a ready backend and repeat after it restarts. */
    backendReady?: boolean;
    showMatchAreas?: boolean;
    /** Trailing toolbar control supplied by the gallery. */
    toolbarEnd?: Snippet;
  } = $props();

  let failed = $state(false);
  let loading = $state(true);
  const src = $derived(originalUrlOf(item));
  const isStillImage = $derived(item.mediaKind === "image");
  let viewer = $state<HTMLElement>();
  let stage = $state<HTMLDivElement>();
  let imageFrame: HTMLDivElement | null = null;
  let hoveredPatch = $state<number | null>(null);
  let activeMap: MatchMap | null = null;
  let stageWidth = $state(0);
  let stageHeight = $state(0);
  let naturalWidth = $state(0);
  let naturalHeight = $state(0);
  let devicePixelRatio = $state(1);
  let zoomMode = $state<ZoomMode>("fit");
  let customScale = $state(1);
  let rawPanX = $state(0);
  let rawPanY = $state(0);
  let fullscreen = $state(false);

  const imageReady = $derived(
    naturalWidth > 0 && naturalHeight > 0 && stageWidth > 0 && stageHeight > 0,
  );
  const actualScale = $derived(1 / devicePixelRatio);
  const fitScale = $derived(
    imageReady ? Math.min(stageWidth / naturalWidth, stageHeight / naturalHeight) : 0,
  );
  const minScale = $derived(Math.min(fitScale, actualScale));
  const maxScale = $derived(Math.max(fitScale, actualScale * 16));
  const effectiveScale = $derived(
    !imageReady
      ? 0
      : zoomMode === "fit"
        ? fitScale
        : zoomMode === "actual"
          ? actualScale
          : clamp(customScale, minScale, maxScale),
  );
  const maxPanX = $derived(
    imageReady ? Math.max(0, (naturalWidth * effectiveScale - stageWidth) / 2) : 0,
  );
  const maxPanY = $derived(
    imageReady ? Math.max(0, (naturalHeight * effectiveScale - stageHeight) / 2) : 0,
  );
  const panX = $derived(clamp(rawPanX, -maxPanX, maxPanX));
  const panY = $derived(clamp(rawPanY, -maxPanY, maxPanY));
  const canPan = $derived(imageReady && (maxPanX > 0 || maxPanY > 0));
  const zoomLabel = $derived(
    zoomMode === "fit" ? "Fit" : `${Math.round((effectiveScale / actualScale) * 100)}%`,
  );
  $effect(() => {
    onstatuschange({
      filename: item.displayName,
      width: naturalWidth || item.sourceWidth || null,
      height: naturalHeight || item.sourceHeight || null,
      zoom: isStillImage && !failed ? (imageReady ? zoomLabel : null) : null,
      loading,
      failed,
    });
  });

  const visualizeUnavailable = $derived(
    !imageModelVisualizes
      ? `${imageModelName ?? "This image model"} does not visualize well`
      : null,
  );
  const canShowMatchAreas = $derived(isStillImage && !failed && visualizeUnavailable === null);

  // A new image, query, or toggle state starts a new request and aborts the superseded fetch.
  const matchRequest = $derived(
    showMatchAreas && canShowMatchAreas && backendReady
      ? loadMatchMap(item.id, imageQuery, getAbortSignal())
      : null,
  );

  function paintMatchMap(map: MatchMap) {
    return (canvas: HTMLCanvasElement): (() => void) => {
      activeMap = map;
      $effect(() => {
        const pixels =
          hoveredPatch === null || hoveredPatch >= map.rows * map.columns
            ? map.pixels
            : similarityPixels(map.patches, hoveredPatch);
        const context = canvas.getContext("2d");
        if (!context) return;
        if (hoveredPatch === null && map.pooled === null)
          context.clearRect(0, 0, map.columns, map.rows);
        else context.putImageData(new ImageData(pixels, map.columns, map.rows), 0, 0);
      });
      return () => {
        if (activeMap === map) activeMap = null;
      };
    };
  }

  function attachImageFrame(element: HTMLDivElement): () => void {
    imageFrame = element;
    return () => {
      if (imageFrame === element) imageFrame = null;
    };
  }

  function updateHoveredPatch(event: PointerEvent): void {
    const map = activeMap;
    const bounds = imageFrame?.getBoundingClientRect();
    if (!map || !bounds) {
      hoveredPatch = null;
      return;
    }
    const [x, y, width, height] = map.region;
    const gridX = ((event.clientX - bounds.left) / bounds.width - x) / width;
    const gridY = ((event.clientY - bounds.top) / bounds.height - y) / height;
    hoveredPatch =
      gridX >= 0 && gridX < 1 && gridY >= 0 && gridY < 1
        ? Math.floor(gridY * map.rows) * map.columns + Math.floor(gridX * map.columns)
        : null;
  }

  function toggleMatchAreas(): void {
    if (canShowMatchAreas) showMatchAreas = !showMatchAreas;
  }

  onMount(() => {
    syncDevicePixelRatio();
    updateFullscreenState();
    document.addEventListener("fullscreenchange", updateFullscreenState);
    return () => document.removeEventListener("fullscreenchange", updateFullscreenState);
  });

  $effect((): (() => void) | undefined => {
    const observedStage = stage;
    if (!observedStage) return undefined;

    const updateStageSize = (rect: DOMRectReadOnly): void => {
      stageWidth = rect.width;
      stageHeight = rect.height;
    };
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) updateStageSize(entry.contentRect);
    });

    updateStageSize(observedStage.getBoundingClientRect());
    resizeObserver.observe(observedStage);
    return () => resizeObserver.disconnect();
  });

  function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function clearPan(): void {
    rawPanX = 0;
    rawPanY = 0;
  }

  function selectFit(): void {
    if (!imageReady) return;
    zoomMode = "fit";
    clearPan();
  }

  function selectActual(): void {
    if (!imageReady) return;
    zoomMode = "actual";
    clearPan();
  }

  function stagePoint(clientX: number, clientY: number): StagePoint | undefined {
    const bounds = stage?.getBoundingClientRect();
    if (!bounds) return undefined;

    return {
      x: clientX - bounds.left - bounds.width / 2,
      y: clientY - bounds.top - bounds.height / 2,
    };
  }

  function setCustomScale(nextScale: number, anchor: StagePoint = { x: 0, y: 0 }): void {
    if (!imageReady || effectiveScale <= 0) return;
    const targetScale = clamp(nextScale, minScale, maxScale);
    const scaleRatio = targetScale / effectiveScale;

    rawPanX = anchor.x - (anchor.x - panX) * scaleRatio;
    rawPanY = anchor.y - (anchor.y - panY) * scaleRatio;
    customScale = targetScale;
    zoomMode = "custom";
  }

  function changeScale(factor: number): void {
    setCustomScale(effectiveScale * factor);
  }

  function syncDevicePixelRatio(): void {
    devicePixelRatio = window.devicePixelRatio || 1;
  }

  function updateFullscreenState(): void {
    fullscreen = document.fullscreenElement === viewer;
  }

  async function toggleFullscreen(): Promise<void> {
    if (!viewer) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await viewer.requestFullscreen();
    } catch {
      // Native fullscreen can be unavailable or denied; retain the current viewer state.
    }
  }

  /** Cached images can be ready before the component's load listener is installed. */
  function observeImage(image: HTMLImageElement): () => void {
    const loaded = (): void => {
      naturalWidth = image.naturalWidth;
      naturalHeight = image.naturalHeight;
      loading = false;
    };
    image.addEventListener("load", loaded);
    image.addEventListener("error", handleMediaError);
    if (image.complete) {
      if (image.naturalWidth > 0) loaded();
      else handleMediaError();
    }
    return () => {
      image.removeEventListener("load", loaded);
      image.removeEventListener("error", handleMediaError);
    };
  }

  function handleMediaError(): void {
    failed = true;
    loading = false;
  }

  function handleWheel(event: WheelEvent): void {
    if (!imageReady) return;
    event.preventDefault();

    const delta =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * stageHeight
          : event.deltaY;
    const anchor = stagePoint(event.clientX, event.clientY);
    if (!anchor || !Number.isFinite(delta)) return;

    setCustomScale(effectiveScale * 1.0015 ** -delta, anchor);
  }

  /** A remote browser keeps its own menu on videos, which offers save and picture-in-picture. */
  function keepsBrowserMenu(target: EventTarget | null): boolean {
    return isRemote() && target instanceof Element && target.closest("video") !== null;
  }

  const gestures = new ViewerGestures({
    isGestureTarget: (target) => !target.closest(".video-controls"),
    opensFileMenuAt: (target) => !keepsBrowserMenu(target),
    isReady: () => imageReady,
    canPan: () => canPan,
    pan: () => ({ x: panX, y: panY }),
    setPan: (x, y) => {
      rawPanX = x;
      rawPanY = y;
    },
    zoomBy: (ratio, clientX, clientY) => {
      const anchor = stagePoint(clientX, clientY);
      if (anchor) setCustomScale(effectiveScale * ratio, anchor);
    },
    hasPrev: () => hasPrev,
    hasNext: () => hasNext,
    onprev: () => onprev(),
    onnext: () => onnext(),
    onfilemenu: () => onfilemenu(),
    onengage: () => (hoveredPatch = null),
    onhover: updateHoveredPatch,
  });

  function handleDoubleClick(event: MouseEvent): void {
    if (!imageReady) return;
    event.preventDefault();
    if (zoomMode === "fit") selectActual();
    else selectFit();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (
      event.defaultPrevented ||
      (event.target instanceof Element && event.target.closest(".metadata-panel"))
    )
      return;
    if (
      item.mediaKind === "video" &&
      event.target instanceof Element &&
      event.target.closest(".video-player")
    )
      return;
    if (event.key === "ArrowLeft" && hasPrev) onprev();
    else if (event.key === "ArrowRight" && hasNext) onnext();
    else if (!isStillImage) return;
    else if (event.key === "0") {
      event.preventDefault();
      selectFit();
    } else if (event.key === "1") {
      event.preventDefault();
      selectActual();
    } else if (event.key.toLowerCase() === "f" && !event.repeat) {
      event.preventDefault();
      void toggleFullscreen();
    } else if (event.key.toLowerCase() === "h" && !event.repeat && canShowMatchAreas) {
      event.preventDefault();
      toggleMatchAreas();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} onresize={syncDevicePixelRatio} />

<section
  class="detail-viewer"
  aria-label={item.displayName}
  bind:this={viewer}
  oncontextmenu={(event) => {
    if (keepsBrowserMenu(event.target)) return;
    event.preventDefault();
    onfilemenu();
  }}
>
  <header class="detail-toolbar app-toolbar">
    <div class="app-toolbar-group" role="toolbar" aria-label="Media navigation">
      <button
        class="app-toolbar-button app-toolbar-text-button app-toolbar-keep-label"
        type="button"
        onclick={onclose}
        title="Return to gallery (Escape)"
        aria-label="Return to gallery (Escape)"
      >
        <ArrowLeft size={16} aria-hidden="true" />
        <span>Gallery</span>
      </button>
      <button
        class="app-toolbar-button step-button"
        type="button"
        onclick={onprev}
        title="Previous"
        aria-label="Previous"
        disabled={!hasPrev}
      >
        <ChevronLeft size={16} aria-hidden="true" />
      </button>
      <button
        class="app-toolbar-button step-button"
        type="button"
        onclick={onnext}
        title="Next"
        aria-label="Next"
        disabled={!hasNext}
      >
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </div>
    {#if isStillImage && !failed}
      <div class="app-toolbar-group image-tools" role="toolbar" aria-label="Image viewer controls">
        <button
          class={["app-toolbar-button", showMatchAreas && canShowMatchAreas && "active"]}
          type="button"
          onclick={toggleMatchAreas}
          title={visualizeUnavailable ??
            (showMatchAreas
              ? "Hide patch similarity and match areas (H)"
              : "Show patch similarity and match areas (H)")}
          aria-label="Visualize match areas (H)"
          aria-pressed={showMatchAreas && canShowMatchAreas}
          disabled={!canShowMatchAreas}
        >
          <ScanEye size={16} aria-hidden="true" />
        </button>
        <button
          class="app-toolbar-button"
          type="button"
          onclick={() => changeScale(1 / 1.25)}
          title="Zoom out"
          aria-label="Zoom out"
          disabled={!imageReady}
        >
          <Minus size={16} aria-hidden="true" />
        </button>
        <button
          class="app-toolbar-button"
          type="button"
          onclick={() => changeScale(1.25)}
          title="Zoom in"
          aria-label="Zoom in"
          disabled={!imageReady}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
        <button
          class="app-toolbar-button"
          type="button"
          onclick={selectFit}
          title="Fit to window (0)"
          aria-label="Fit to window (0)"
          disabled={!imageReady}
        >
          <Scan size={16} aria-hidden="true" />
        </button>
        <button
          class="app-toolbar-button actual-size-button"
          type="button"
          onclick={selectActual}
          title="Actual size (1)"
          aria-label="Actual size (1)"
          disabled={!imageReady}
        >
          1:1
        </button>
      </div>
      <div class="app-toolbar-group">
        <button
          class="app-toolbar-button"
          type="button"
          onclick={() => void toggleFullscreen()}
          title={fullscreen ? "Exit fullscreen (F)" : "Enter fullscreen (F)"}
          aria-label={fullscreen ? "Exit fullscreen (F)" : "Enter fullscreen (F)"}
        >
          {#if fullscreen}
            <Minimize size={16} aria-hidden="true" />
          {:else}
            <Maximize size={16} aria-hidden="true" />
          {/if}
        </button>
      </div>
    {/if}
    {#if toolbarEnd}<div class="toolbar-end">{@render toolbarEnd()}</div>{/if}
  </header>

  {#if matchRequest}
    <div class="match-bar" role="status">
      <span class="match-bar-query" title={imageQueryLabel}>
        {#if hoveredPatch !== null}Similar to the outlined area{:else if imageQuery}Matches for <q
            >{imageQueryLabel}</q
          >{:else}Hover an area to compare patches{/if}
      </span>
      {#if imageModelName}
        <span class="match-bar-item">{imageModelName}</span>
      {/if}
      <span class="match-bar-item match-legend">
        Weak <span class="match-legend-ramp" style:background={TURBO_GRADIENT}></span> Strong
      </span>
      {#await matchRequest}
        <span class="match-bar-item">Mapping…</span>
      {:then result}
        {#if result.status === "ready"}
          {#if result.map.pooled !== null && hoveredPatch === null}<span
              class="match-bar-item match-score"
              title="Cosine similarity of the whole image to the search. Colors span this image's own weakest to strongest areas."
              >Match {result.map.pooled.toFixed(4)}</span
            >{/if}
        {:else if result.status === "failed"}
          <span class="match-bar-item">{result.message}</span>
        {/if}
      {/await}
    </div>
  {/if}

  <div class="detail-media" {@attach gestures.attach}>
    {#if failed}
      <div class="detail-error">
        <CircleAlert size={28} aria-hidden="true" />
        <p>Couldn't load the original file. It may have moved or been deleted.</p>
      </div>
    {:else if item.mediaKind === "video"}
      <VideoPlayer
        {src}
        {initialPlayback}
        onready={() => (loading = false)}
        onerror={handleMediaError}
      />
    {:else}
      <div
        class="detail-image-stage"
        class:is-pannable={canPan}
        class:is-dragging={gestures.dragging}
        role="presentation"
        bind:this={stage}
        onwheel={handleWheel}
        onpointerleave={() => (hoveredPatch = null)}
        ondblclick={handleDoubleClick}
      >
        <div
          class="detail-image-frame"
          class:image-ready={imageReady}
          {@attach attachImageFrame}
          style:transform={`translate(${panX}px, ${panY}px) scale(${effectiveScale})`}
        >
          <img
            class="detail-image"
            {src}
            alt={item.displayName}
            draggable={false}
            {@attach observeImage}
          />
          {#if matchRequest}
            {#await matchRequest then result}
              {#if result.status === "ready"}
                {@const [x, y, width, height] = result.map.region}
                {#each ["match-map-tint", "match-map-cover"] as layer (layer)}
                  <canvas
                    class={["match-map", layer]}
                    width={result.map.columns}
                    height={result.map.rows}
                    style:left={`${x * 100}%`}
                    style:top={`${y * 100}%`}
                    style:width={`${width * 100}%`}
                    style:height={`${height * 100}%`}
                    aria-hidden="true"
                    {@attach paintMatchMap(result.map)}
                  ></canvas>
                {/each}
                {#if hoveredPatch !== null && hoveredPatch < result.map.rows * result.map.columns}
                  <div
                    class="match-map-hover-outline"
                    style:left={`${(x + ((hoveredPatch % result.map.columns) * width) / result.map.columns) * 100}%`}
                    style:top={`${(y + (Math.floor(hoveredPatch / result.map.columns) * height) / result.map.rows) * 100}%`}
                    style:width={`${(width / result.map.columns) * 100}%`}
                    style:height={`${(height / result.map.rows) * 100}%`}
                    aria-hidden="true"
                  ></div>
                {/if}
              {/if}
            {/await}
          {/if}
        </div>
      </div>
    {/if}
  </div>
</section>

<style>
  .toolbar-end {
    margin-left: auto;
  }
  .detail-viewer {
    position: absolute;
    z-index: var(--z-raised);
    inset: 0;
    display: flex;
    box-sizing: border-box;
    flex-direction: column;
    overflow: hidden;
    background: var(--surface-2);
  }

  .detail-viewer:fullscreen {
    max-width: none;
    max-height: none;
    background: var(--surface-2);
  }

  .image-tools {
    margin-left: auto;
  }

  .detail-media {
    display: flex;
    width: 100%;
    flex: 1;
    min-width: 0;
    min-height: 0;
    align-items: center;
    justify-content: center;
    /* Swipes step between items whatever the viewer shows, so the browser must not pan or zoom
       the page under them. */
    touch-action: none;
  }

  .detail-image-stage {
    -webkit-touch-callout: none;
    position: relative;
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .detail-image-stage.is-pannable {
    cursor: grab;
  }

  .detail-image-stage.is-dragging {
    cursor: grabbing;
  }

  /* Sized by the image; overlays position in fractions of it, so they follow zoom and pan. A
     match grid that includes a model's padding extends past the image and is clipped to it. */
  .detail-image-frame {
    position: absolute;
    overflow: hidden;
    transform-origin: center;
    will-change: transform;
  }

  .detail-image-frame:not(.image-ready) {
    visibility: hidden;
  }

  .detail-image {
    display: block;
    max-width: none;
    max-height: none;
    user-select: none;
    -webkit-user-drag: none;
  }

  /* One canvas pixel per patch; the browser's bilinear upscale smooths the grid. The tint layer
     recolors the photo at its own brightness; the cover layer above it partly occludes. */
  .match-map {
    position: absolute;
    pointer-events: none;
  }

  .match-map-tint {
    opacity: var(--match-map-opacity);
    mix-blend-mode: var(--match-map-blend);
  }

  .match-map-cover {
    opacity: var(--match-map-cover-opacity);
  }

  .match-map-hover-outline {
    position: absolute;
    box-sizing: border-box;
    border: 2px solid var(--match-map-hover-outline);
    pointer-events: none;
  }

  /* States the search being visualized, so a screenshot explains its own colors. */
  .match-bar {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: var(--space-8);
    padding: var(--space-3) var(--space-8);
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-1);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    white-space: nowrap;
  }

  .match-bar-query {
    overflow: hidden;
    min-width: 0;
    flex: 0 1 auto;
    text-overflow: ellipsis;
  }

  .match-bar-query q {
    color: var(--text-primary);
  }

  .match-bar-item {
    flex: none;
  }

  .match-legend {
    display: inline-flex;
    align-items: center;
    gap: var(--space-4);
  }

  .match-legend-ramp {
    width: 64px;
    height: 8px;
    border: 1px solid var(--border-subtle);
  }

  .match-score {
    font-variant-numeric: tabular-nums;
  }

  .detail-error {
    display: flex;
    max-width: 320px;
    flex-direction: column;
    align-items: center;
    gap: var(--space-8);
    color: var(--text-primary);
    text-align: center;
  }

  .actual-size-button {
    font-size: var(--font-size-xs);
    font-variant-numeric: tabular-nums;
  }
  /* Swipes (touch) and arrow keys step between items, so the buttons would only crowd the back
     button. */
  @media (max-width: 600px) {
    .step-button {
      display: none;
    }
  }
</style>
