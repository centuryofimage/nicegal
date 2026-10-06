<script lang="ts">
  import Maximize from "@lucide/svelte/icons/maximize";
  import Minimize from "@lucide/svelte/icons/minimize";
  import Pause from "@lucide/svelte/icons/pause";
  import Play from "@lucide/svelte/icons/play";
  import Volume2 from "@lucide/svelte/icons/volume-2";
  import VolumeX from "@lucide/svelte/icons/volume-x";

  import { formatDuration } from "../lib/duration";

  let {
    src,
    initialPlayback = null,
    onready,
    onerror,
  }: {
    src: string;
    initialPlayback?: { currentTime: number; muted: boolean } | null;
    onready: () => void;
    onerror: () => void;
  } = $props();

  let player: HTMLDivElement;
  let video: HTMLVideoElement;
  let currentTime = $state(0);
  let duration = $state(0);
  let playing = $state(false);
  let muted = $state(false);
  let volume = $state(1);
  let fullscreen = $state(false);
  let scrubbing = false;
  let resumeAfterScrub = false;
  const seekPercent = $derived(duration > 0 ? `${(currentTime / duration) * 100}%` : "0%");
  const volumePercent = $derived(`${(muted ? 0 : volume) * 100}%`);

  function updatePlayback(): void {
    if (!scrubbing) currentTime = video.currentTime;
    playing = !video.paused && !video.ended;
  }

  function updateVolume(): void {
    muted = video.muted;
    volume = video.volume;
  }

  function togglePlayback(): void {
    if (video.paused || video.ended) void video.play().catch(() => {});
    else video.pause();
  }

  function seek(event: Event & { currentTarget: HTMLInputElement }): void {
    if (duration <= 0) return;
    currentTime = event.currentTarget.valueAsNumber;
    if (scrubbing) previewSeek();
    else video.currentTime = currentTime;
  }

  function previewSeek(): void {
    if (!scrubbing || video.seeking || Math.abs(video.currentTime - currentTime) < 0.05) return;
    // Keep at most one decode in flight; the next completed seek uses the latest slider value.
    video.currentTime = currentTime;
  }

  function beginScrubbing(): void {
    if (duration <= 0) return;
    resumeAfterScrub = !video.paused && !video.ended;
    scrubbing = true;
    if (resumeAfterScrub) video.pause();
  }

  function finishScrubbing(): void {
    if (!scrubbing) return;
    scrubbing = false;
    video.currentTime = currentTime;
    if (resumeAfterScrub) void video.play().catch(() => {});
    resumeAfterScrub = false;
  }

  function setVolume(event: Event & { currentTarget: HTMLInputElement }): void {
    video.volume = event.currentTarget.valueAsNumber / 100;
    video.muted = video.volume === 0;
    updateVolume();
  }

  function toggleMute(): void {
    video.muted = !video.muted;
    updateVolume();
  }

  function updateFullscreen(): void {
    fullscreen = document.fullscreenElement === player;
  }

  async function toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement === player) await document.exitFullscreen();
      else await player.requestFullscreen();
    } catch {
      // Fullscreen may be denied by the host window; keep the player usable.
    }
  }

  function observeVideo(element: HTMLVideoElement): () => void {
    video = element;
    let loadedOnce = false;
    let pendingResume = Boolean(initialPlayback);
    const resume = (): void => {
      void element.play().then(
        () => {
          pendingResume = false;
        },
        () => {
          if (!document.hidden) pendingResume = false;
        },
      );
    };
    const resumeWhenVisible = (): void => {
      if (pendingResume && !document.hidden && loadedOnce && !element.seeking) resume();
    };
    const loaded = (): void => {
      if (loadedOnce) return;
      loadedOnce = true;
      duration = Number.isFinite(element.duration) ? element.duration : 0;
      updatePlayback();
      onready();
      if (initialPlayback) {
        element.muted = initialPlayback.muted;
        updateVolume();
        if (Number.isFinite(initialPlayback.currentTime) && initialPlayback.currentTime > 0) {
          element.addEventListener("seeked", resume, { once: true });
          element.currentTime = Math.min(
            initialPlayback.currentTime,
            duration > 0 ? Math.max(0, duration - 0.05) : initialPlayback.currentTime,
          );
          return;
        }
        resume();
      }
    };
    element.addEventListener("loadedmetadata", loaded);
    element.addEventListener("timeupdate", updatePlayback);
    element.addEventListener("seeked", previewSeek);
    element.addEventListener("play", updatePlayback);
    element.addEventListener("pause", updatePlayback);
    element.addEventListener("ended", updatePlayback);
    element.addEventListener("volumechange", updateVolume);
    element.addEventListener("error", onerror);
    document.addEventListener("visibilitychange", resumeWhenVisible);
    document.addEventListener("fullscreenchange", updateFullscreen);
    if (element.error) onerror();
    else if (element.readyState >= HTMLMediaElement.HAVE_METADATA) loaded();
    return () => {
      element.removeEventListener("loadedmetadata", loaded);
      element.removeEventListener("seeked", resume);
      element.removeEventListener("timeupdate", updatePlayback);
      element.removeEventListener("seeked", previewSeek);
      element.removeEventListener("play", updatePlayback);
      element.removeEventListener("pause", updatePlayback);
      element.removeEventListener("ended", updatePlayback);
      element.removeEventListener("volumechange", updateVolume);
      element.removeEventListener("error", onerror);
      document.removeEventListener("visibilitychange", resumeWhenVisible);
      document.removeEventListener("fullscreenchange", updateFullscreen);
    };
  }
</script>

<div class="video-player" bind:this={player}>
  <button
    class="video-surface"
    type="button"
    aria-label={playing ? "Pause video" : "Play video"}
    title={playing ? "Pause" : "Play"}
    onclick={togglePlayback}
  >
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      class="video-picture"
      {src}
      autoplay={!initialPlayback}
      playsinline
      {@attach observeVideo}
    ></video>
  </button>
  <div class="video-controls" role="group" aria-label="Video controls">
    <button
      class="player-button"
      type="button"
      onclick={togglePlayback}
      aria-label={playing ? "Pause" : "Play"}
      title={playing ? "Pause" : "Play"}
    >
      {#if playing}<Pause size={13} fill="currentColor" aria-hidden="true" />{:else}<Play
          size={13}
          fill="currentColor"
          aria-hidden="true"
        />{/if}
    </button>
    <input
      class="player-range seek-range"
      type="range"
      min="0"
      max={duration > 0 ? duration : 1}
      step="0.01"
      value={currentTime}
      style:--range-progress={seekPercent}
      aria-label="Seek video"
      disabled={duration <= 0}
      onpointerdown={beginScrubbing}
      onpointerup={finishScrubbing}
      onpointercancel={finishScrubbing}
      oninput={seek}
    />
    <span
      class="time-readout"
      aria-label={`Time ${formatDuration(currentTime)} of ${formatDuration(duration)}`}
      >{formatDuration(currentTime)} / {formatDuration(duration)}</span
    >
    <button
      class="player-button"
      type="button"
      onclick={toggleMute}
      aria-label={muted ? "Unmute" : "Mute"}
      title={muted ? "Unmute" : "Mute"}
    >
      {#if muted || volume === 0}<VolumeX size={14} aria-hidden="true" />{:else}<Volume2
          size={14}
          aria-hidden="true"
        />{/if}
    </button>
    <input
      class="player-range volume-range"
      type="range"
      min="0"
      max="100"
      step="1"
      value={muted ? 0 : Math.round(volume * 100)}
      style:--range-progress={volumePercent}
      aria-label="Volume"
      oninput={setVolume}
    />
    <button
      class="player-button fullscreen-button"
      type="button"
      onclick={() => void toggleFullscreen()}
      aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
      title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
    >
      {#if fullscreen}<Minimize size={13} aria-hidden="true" />{:else}<Maximize
          size={13}
          aria-hidden="true"
        />{/if}
    </button>
  </div>
</div>

<style>
  .video-player {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--player-border);
    background: var(--player-screen);
    box-sizing: border-box;
  }

  .video-player:fullscreen {
    width: 100vw;
    height: 100vh;
  }

  .video-surface {
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    background: var(--player-screen);
    cursor: pointer;
  }

  .video-surface:focus-visible,
  .player-button:focus-visible,
  .player-range:focus-visible {
    outline: 1px dotted var(--player-text);
    outline-offset: -3px;
  }

  .video-picture {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    pointer-events: none;
  }

  .video-controls {
    position: absolute;
    inset: auto 0 0;
    display: flex;
    height: 31px;
    min-width: 0;
    align-items: center;
    gap: 5px;
    padding: 0 5px;
    border-top: 1px solid var(--player-border-light);
    background: var(--player-bar-background);
    box-sizing: border-box;
    color: var(--player-text);
  }

  .player-button {
    display: inline-flex;
    width: 23px;
    height: 23px;
    flex: none;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 2px;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  .player-button:hover {
    border-color: var(--player-border-light);
    background: var(--player-button-hover);
  }

  .player-button:active {
    background: var(--player-button-active);
  }

  .player-range {
    -webkit-appearance: none;
    appearance: none;
    display: block;
    height: 16px;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
  }

  .seek-range {
    flex: 1;
  }
  .volume-range {
    width: 58px;
    flex: none;
  }

  .player-range::-webkit-slider-runnable-track {
    height: 5px;
    border: 1px solid var(--player-track-border);
    border-radius: 2px;
    background: linear-gradient(
      to right,
      var(--player-progress) var(--range-progress),
      var(--player-track) var(--range-progress)
    );
    box-shadow: inset 0 1px 1px rgb(0 0 0 / 35%);
  }

  .player-range::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 11px;
    height: 11px;
    margin-top: -4px;
    border: 1px solid var(--player-thumb-border);
    border-radius: 50%;
    background: var(--player-thumb);
  }

  .player-range:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .time-readout {
    flex: none;
    min-width: 69px;
    color: var(--player-text);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    text-align: center;
    white-space: nowrap;
  }

  @media (max-width: 420px) {
    .volume-range {
      width: 38px;
    }
    .video-controls {
      gap: 3px;
      padding-inline: 3px;
    }
  }
</style>
