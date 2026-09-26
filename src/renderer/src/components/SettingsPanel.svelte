<script lang="ts">
  import { onMount } from "svelte";

  import type { ExecutionProviderId } from "../../../shared/backend";
  import type { UpdatePreferences } from "../../../shared/updates";
  import type { SettingsPage } from "../lib/library-view.svelte";
  import type { RuntimeController } from "../lib/runtime.svelte";

  import { useApplication } from "../lib/application.svelte";
  import { jobBlocksRuntimeSwitch, runtimeSwitchJobNote } from "../lib/job-state";
  import { settings, settingsLimits, type GalleryTheme } from "../lib/settings.svelte";
  import AboutSettings from "./AboutSettings.svelte";
  import SearchModels from "./SearchModels.svelte";

  let {
    runtime,
    onclose,
    onshowintro,
    onmanagelibraries,
    page = $bindable<SettingsPage>("gallery"),
  }: {
    runtime: RuntimeController;
    onclose: () => void;
    onshowintro: () => void;
    onmanagelibraries: () => void;
    page?: SettingsPage;
  } = $props();

  const themes: { id: GalleryTheme; label: string }[] = [
    { id: "seven-a", label: "very" },
    { id: "seven-b", label: "Hospital" },
  ];
  const { catalog, jobs } = useApplication().services;
  const jobNote = $derived(runtimeSwitchJobNote(jobs));
  let updatePreferences = $state<UpdatePreferences | null>(null);
  let updateSaving = $state(false);
  let updateError = $state<string | null>(null);
  onMount(() => {
    let disposed = false;
    void window.nicegal.updates
      .getPreferences()
      .then((value) => {
        if (!disposed) updatePreferences = value;
      })
      .catch((error: unknown) => {
        if (!disposed) updateError = error instanceof Error ? error.message : String(error);
      });
    return () => {
      disposed = true;
    };
  });

  async function setAutomaticUpdates(
    event: Event & { currentTarget: HTMLInputElement },
  ): Promise<void> {
    const checkbox = event.currentTarget;
    updateSaving = true;
    updateError = null;
    try {
      updatePreferences = await window.nicegal.updates.setEnabled(checkbox.checked);
    } catch (error) {
      updateError = error instanceof Error ? error.message : String(error);
    } finally {
      checkbox.checked = updatePreferences?.enabled ?? false;
      updateSaving = false;
    }
  }

  const isLinux = navigator.userAgent.includes("Linux");
  const isMac = navigator.userAgent.includes("Macintosh");
  const executionProviders: { id: ExecutionProviderId; label: string }[] = [
    { id: "directml", label: "DirectML" },
    { id: "cuda", label: "CUDA" },
    { id: "openvino", label: "OpenVINO (CPU)" },
    { id: "webgpu", label: "WebGPU" },
    { id: "coreml", label: "CoreML" },
    { id: "cpu", label: "CPU" },
  ];

  const availableExecutionProviders = $derived(
    executionProviders.filter((provider) =>
      (
        runtime.status?.availableExecutionProviders ??
        (isMac ? ["coreml", "cpu"] : isLinux ? ["webgpu", "cpu"] : ["directml", "openvino", "cpu"])
      ).includes(provider.id),
    ),
  );
  const executionProviderDisabled = $derived(
    runtime.loading ||
      runtime.saving ||
      runtime.imageModelSaving ||
      !catalog.backendStatus.ready ||
      jobBlocksRuntimeSwitch(jobs),
  );
</script>

<section class="settings-panel" aria-labelledby="settings-title">
  <header>
    <div>
      <h1 id="settings-title">Settings</h1>
    </div>
    <button class="ui-button ui-button-compact" onclick={onclose}>Close</button>
  </header>

  <nav class="settings-pages" aria-label="Settings pages">
    <button class="ui-button" aria-pressed={page === "gallery"} onclick={() => (page = "gallery")}
      >General</button
    >
    <button class="ui-button" aria-pressed={page === "search"} onclick={() => (page = "search")}
      >Search</button
    >
    <button class="ui-button" aria-pressed={page === "about"} onclick={() => (page = "about")}
      >About</button
    >
  </nav>
  {#if !catalog.backendStatus.ready && catalog.backendStatus.error}
    <div class="settings-error" role="alert">
      The gallery service is unavailable.
      <button class="ui-button" onclick={onclose}>Show error details</button>
    </div>
  {/if}
  <div class="settings-groups themed-scrollbar">
    {#if page === "gallery"}
      <section class="settings-group" aria-labelledby="appearance-title">
        <h2 id="appearance-title">Appearance</h2>
        <div class="row segmented-row">
          <span>Theme</span>
          <div class="ui-choice-group" aria-label="Theme">
            {#each themes as theme (theme.id)}
              <button
                class="ui-button"
                aria-pressed={$settings.theme === theme.id}
                onclick={() => ($settings.theme = theme.id)}>{theme.label}</button
              >
            {/each}
          </div>
        </div>
        <label class="row"
          ><span>Play animated GIFs in the grid</span><input
            type="checkbox"
            bind:checked={$settings.playAnimatedPreviews}
          /></label
        >
      </section>

      <section class="settings-group" aria-labelledby="updates-title">
        <h2 id="updates-title">Updates</h2>
        <label class="row">
          <span class="setting-label"
            >{isMac ? "Notify me about updates" : "Automatic updates"}</span
          >
          <input
            type="checkbox"
            checked={updatePreferences?.enabled ?? false}
            disabled={!updatePreferences || updateSaving || updatePreferences.mode === "none"}
            onchange={setAutomaticUpdates}
          />
        </label>
        {#if updatePreferences?.mode === "notify"}
          <p class="update-build-note">
            Check once when Nicegal opens. Download updates from the release page.
          </p>
        {:else if updatePreferences?.mode === "none"}
          <p class="update-build-note">This build does not check for updates.</p>
        {/if}
        {#if updateError}<p class="settings-error" role="alert">{updateError}</p>{/if}
      </section>
    {:else if page === "about"}
      <AboutSettings />
    {:else}
      <SearchModels />
      <section class="settings-group" aria-labelledby="library-search-title">
        <h2 id="library-search-title">Per library</h2>
        <div class="row">
          <span class="setting-label"
            >Image search, text recognition, and videos<small
              >Chosen for each library in Library manager.</small
            ></span
          >
          <button class="ui-button" onclick={onmanagelibraries}>Library manager…</button>
        </div>
      </section>
      <section class="settings-group advanced-settings" aria-labelledby="advanced-search-title">
        <h2 id="advanced-search-title">Advanced search settings</h2>
        <div class="row segmented-row">
          <span class="setting-label"
            >Execution provider<small
              >{runtime.stoppingJobs && runtime.saving
                ? "Stopping indexing…"
                : runtime.saving
                  ? "Switching…"
                  : jobNote || "Leave this unless indexing fails."}</small
            ></span
          >
          <div class="ui-choice-group" aria-label="Execution provider">
            {#each availableExecutionProviders as provider (provider.id)}
              <button
                class="ui-button"
                aria-pressed={runtime.status?.configuredExecutionProvider === provider.id}
                disabled={executionProviderDisabled}
                onclick={() => runtime.setExecutionProvider(provider.id)}>{provider.label}</button
              >
            {/each}
          </div>
        </div>
        {#if runtime.error}
          <p class="settings-error" role="alert">{runtime.error}</p>
        {/if}
        {#if import.meta.env.DEV}<label class="row">
            <span class="setting-label"
              >Index limit (debug)<small>0 indexes the complete library.</small></span
            ><input
              class="number-input"
              type="number"
              title="0 = no limit"
              min={settingsLimits.debugIndexLimit.min}
              max={settingsLimits.debugIndexLimit.max}
              step={settingsLimits.debugIndexLimit.step}
              bind:value={$settings.debugIndexLimit}
            />
          </label>{/if}
      </section>
    {/if}
  </div>
  <footer class="settings-help">
    <span>New to Nicegal?</span>
    <button class="ui-button" onclick={onshowintro}>Getting started</button>
  </footer>
</section>

<style>
  .update-build-note {
    padding: 0 var(--space-9) var(--space-7);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .settings-panel {
    display: flex;
    width: 100%;
    max-width: var(--dialog-width);
    min-height: 0;
    flex-direction: column;
    padding: var(--space-16);
    overflow: hidden;
  }
  .settings-pages {
    display: flex;
    flex: none;
    gap: var(--space-4);
    padding-top: var(--space-10);
  }
  .settings-help {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
    margin-top: var(--space-12);
    padding-top: var(--space-10);
    border-top: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    font-size: var(--font-size-md);
  }
  header {
    flex: none;
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: var(--space-12);
    padding-bottom: var(--space-12);
    border-bottom: 1px solid var(--border-subtle);
  }
  h1,
  h2,
  p {
    margin: 0;
  }
  h1 {
    color: var(--text-primary);
    font-size: var(--dialog-title-size);
    font-weight: var(--font-weight-semibold);
  }
  .settings-groups {
    display: grid;
    min-height: 0;
    gap: var(--space-14);
    padding-top: var(--space-14);
    overflow: auto;
  }
  .settings-group {
    border: 1px solid var(--border);
    background: var(--surface-1);
  }
  .advanced-settings {
    color: var(--text-primary);
  }
  h2 {
    padding: var(--space-7) var(--space-9);
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-primary);
    font-size: var(--font-size-md);
    font-weight: var(--font-weight-semibold);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
    min-height: var(--control-height);
    padding: var(--space-5) var(--space-9);
    color: var(--text-primary);
    font-size: var(--font-size-md);
  }
  .setting-label {
    display: grid;
    gap: var(--space-2);
  }
  .setting-label small {
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .settings-error {
    margin: 0;
    padding: var(--space-5) var(--space-9);
    border-top: 1px solid var(--border-subtle);
    color: var(--danger);
    font-size: var(--font-size-sm);
  }

  input[type="checkbox"] {
    width: 14px;
    height: 14px;
    accent-color: var(--accent);
  }
  .number-input {
    width: 64px;
    padding: var(--space-2) var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--font-size-sm);
  }
  input:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
</style>
