<script lang="ts">
  import { onMount } from "svelte";

  import type { ExecutionProviderId } from "../../../shared/backend";
  import type { LanguageSettings } from "../../../shared/locale";
  import type { UpdatePreferences } from "../../../shared/updates";
  import type { SettingsPage } from "../lib/library-view.svelte";
  import type { RuntimeController } from "../lib/runtime.svelte";

  import { m } from "../../../shared/paraglide/messages.js";
  import { useApplication } from "../lib/application.svelte";
  import { jobBlocksRuntimeSwitch, runtimeSwitchJobNote } from "../lib/job-state";
  import { isRemote } from "../lib/platform";
  import { settings, settingsLimits, type GalleryTheme } from "../lib/settings.svelte";
  import AboutSettings from "./AboutSettings.svelte";
  import LanguageRestartDialog from "./LanguageRestartDialog.svelte";
  import RemoteAccessSettings from "./RemoteAccessSettings.svelte";
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

  // Theme names are the app's own labels, so they stay untranslated.
  const themes: { id: GalleryTheme; label: string }[] = [
    { id: "seven-a", label: "very" },
    { id: "seven-b", label: "Hospital" },
  ];
  const { catalog, jobs } = useApplication().services;
  const jobNote = $derived(runtimeSwitchJobNote(jobs));
  let languageSettings = $state<LanguageSettings | null>(null);
  let languageSaving = $state(false);
  let languageError = $state<string | null>(null);
  let languageRestartOpen = $state(false);
  let updatePreferences = $state<UpdatePreferences | null>(null);
  let updateSaving = $state(false);
  let updateError = $state<string | null>(null);
  onMount(() => {
    let disposed = false;
    if (!isRemote()) {
      void window.nicegal.language
        .getSettings()
        .then((value) => {
          if (!disposed) languageSettings = value;
        })
        .catch((error: unknown) => {
          if (!disposed) languageError = error instanceof Error ? error.message : String(error);
        });
    }
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

  /** Each language is listed under its own name, so someone who cannot read the current UI can
   * still find theirs. */
  function languageName(locale: string): string {
    return new Intl.DisplayNames([locale], { type: "language" }).of(locale) ?? locale;
  }

  async function setLanguage(event: Event & { currentTarget: HTMLSelectElement }): Promise<void> {
    const select = event.currentTarget;
    const preference = select.value || null;
    languageSaving = true;
    languageError = null;
    try {
      languageSettings = await window.nicegal.language.setPreference(preference);
      // Nothing to restart for when the app already runs in the chosen language.
      languageRestartOpen =
        (languageSettings.preference ?? languageSettings.system) !== languageSettings.active;
    } catch (error) {
      languageError = error instanceof Error ? error.message : String(error);
    } finally {
      select.value = languageSettings?.preference ?? "";
      languageSaving = false;
    }
  }

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
      <h1 id="settings-title">{m.common_settings()}</h1>
    </div>
    <button class="ui-button ui-button-compact" onclick={onclose}>{m.common_close()}</button>
  </header>

  <nav class="settings-pages" aria-label={m.settings_pages_nav_aria()}>
    <button class="ui-button" aria-pressed={page === "gallery"} onclick={() => (page = "gallery")}
      >{m.settings_page_general()}</button
    >
    <button class="ui-button" aria-pressed={page === "search"} onclick={() => (page = "search")}
      >{m.settings_page_search()}</button
    >
    {#if !isRemote()}
      <button class="ui-button" aria-pressed={page === "remote"} onclick={() => (page = "remote")}
        >{m.common_remote_access()}</button
      >
    {/if}
    <button class="ui-button" aria-pressed={page === "about"} onclick={() => (page = "about")}
      >{m.settings_page_about()}</button
    >
  </nav>
  <div class="settings-groups themed-scrollbar">
    {#if page === "gallery"}
      {#if !isRemote()}<section class="settings-group" aria-labelledby="language-title">
          <h2 id="language-title">{m.settings_language_heading()}</h2>
          <label class="row">
            <span>{m.settings_language_label()}</span>
            <select
              value={languageSettings?.preference ?? ""}
              disabled={!languageSettings || languageSaving}
              onchange={setLanguage}
            >
              <option value="">{m.settings_language_system()}</option>
              {#each languageSettings?.available ?? [] as locale (locale)}
                <option value={locale}>{languageName(locale)}</option>
              {/each}
            </select>
          </label>
          {#if languageError}<p class="settings-error" role="alert">{languageError}</p>{/if}
        </section>{/if}
      <section class="settings-group" aria-labelledby="appearance-title">
        <h2 id="appearance-title">{m.settings_appearance_heading()}</h2>
        <div class="row segmented-row">
          <span>{m.settings_theme_label()}</span>
          <div class="ui-choice-group" aria-label={m.settings_theme_label()}>
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
          ><span>{m.settings_play_animated_gifs()}</span><input
            type="checkbox"
            bind:checked={$settings.playAnimatedPreviews}
          /></label
        >
      </section>

      {#if !isRemote()}<section class="settings-group" aria-labelledby="updates-title">
          <h2 id="updates-title">{m.settings_updates_heading()}</h2>
          <label class="row">
            <span class="setting-label"
              >{updatePreferences?.mode === "notify"
                ? m.settings_update_notify_label()
                : m.settings_update_automatic_label()}</span
            >
            <input
              type="checkbox"
              checked={updatePreferences?.enabled ?? false}
              disabled={!updatePreferences || updateSaving || updatePreferences.mode === "none"}
              onchange={setAutomaticUpdates}
            />
          </label>
          {#if updatePreferences?.mode === "notify"}
            <p class="update-build-note">{m.settings_update_notify_note()}</p>
          {:else if updatePreferences?.mode === "none"}
            <p class="update-build-note">{m.settings_update_none_note()}</p>
          {/if}
          {#if updateError}<p class="settings-error" role="alert">{updateError}</p>{/if}
        </section>{/if}
    {:else if page === "about"}
      <AboutSettings />
    {:else if page === "remote"}
      <RemoteAccessSettings />
    {:else}
      <SearchModels onshowservicedetails={onclose} />
      <section class="settings-group" aria-labelledby="library-search-title">
        <h2 id="library-search-title">{m.settings_per_library_heading()}</h2>
        <div class="row">
          <span class="setting-label"
            >{m.settings_library_search_label()}<small>{m.settings_library_search_note()}</small
            ></span
          >
          <button class="ui-button" onclick={onmanagelibraries}
            >{m.common_library_manager_ellipsis()}</button
          >
        </div>
      </section>
      <section class="settings-group" aria-labelledby="tags-title">
        <h2 id="tags-title">{m.settings_tags_heading()}</h2>
        <label class="row"
          ><span class="setting-label"
            >{m.settings_hide_offensive_tags()}<small>{m.settings_hide_offensive_tags_note()}</small
            ></span
          ><input type="checkbox" bind:checked={$settings.hideOffensiveTags} /></label
        >
      </section>
      <section class="settings-group advanced-settings" aria-labelledby="advanced-search-title">
        <h2 id="advanced-search-title">{m.settings_advanced_heading()}</h2>
        <div class="row segmented-row">
          <span class="setting-label"
            >{m.settings_execution_provider_label()}<small
              >{runtime.stoppingJobs && runtime.saving
                ? m.search_stopping_indexing()
                : runtime.saving
                  ? m.settings_execution_switching()
                  : jobNote || m.settings_execution_provider_note()}</small
            ></span
          >
          <div class="ui-choice-group" aria-label={m.settings_execution_provider_label()}>
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
    <span>{m.settings_new_to_nicegal()}</span>
    <button class="ui-button" onclick={onshowintro}>{m.settings_getting_started()}</button>
  </footer>
</section>

{#if languageRestartOpen}
  <LanguageRestartDialog onclose={() => (languageRestartOpen = false)} />
{/if}

<style>
  .update-build-note {
    padding: 0 var(--space-9) var(--space-7);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .settings-panel {
    display: flex;
    width: 100%;
    flex: 1;
    max-width: var(--dialog-width);
    min-height: 0;
    flex-direction: column;
    padding: var(--space-16);
    overflow: hidden;
  }
  .settings-pages {
    display: flex;
    flex-wrap: wrap;
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
    flex: 1;
    align-content: start;
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
    min-width: 0;
    overflow-wrap: anywhere;
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

  @media (max-width: 600px) {
    .settings-panel {
      padding: var(--space-8);
    }
    .row {
      flex-wrap: wrap;
    }
    .segmented-row .setting-label {
      flex-basis: 100%;
    }
    .segmented-row :global(.ui-choice-group) {
      flex-wrap: wrap;
    }
  }
</style>
