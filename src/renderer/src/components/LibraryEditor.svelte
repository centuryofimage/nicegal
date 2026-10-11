<script lang="ts">
  import Folder from "@lucide/svelte/icons/folder";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";

  import type { LibraryId } from "../../../shared/backend";
  import type { ThumbnailFailure } from "../lib/gallery/thumbnail-scheduler";

  import { m } from "../../../shared/paraglide/messages.js";
  import { useApplication } from "../lib/application.svelte";
  import { derivedLibraryName } from "../lib/catalog.svelte";
  import { cleanDiagnostic, errorMessage } from "../lib/errors";
  import {
    localDateToExclusiveNs,
    localDateToNs,
    type ThumbnailBackfillOptions,
  } from "../lib/job-params";
  import { folderStatus, isWithin } from "../lib/library-status";
  import { desktopOnlyTitle, isRemote } from "../lib/platform";
  import TechnicalDetails from "./TechnicalDetails.svelte";
  import ThumbnailFailures from "./ThumbnailFailures.svelte";

  let {
    libraryId,
    embedded = false,
    thumbnailFailures = [],
    onretrythumbnails,
    onopensearchsettings,
  }: {
    libraryId: LibraryId;
    embedded?: boolean;
    thumbnailFailures?: readonly (ThumbnailFailure & { name?: string })[];
    onretrythumbnails: () => void;
    onopensearchsettings: () => void;
  } = $props();

  const { services, commands } = useApplication();
  const { catalog, jobs, orchestrator } = services;
  const library = $derived(catalog.libraries.find((candidate) => candidate.id === libraryId));
  const ready = $derived(catalog.backendStatus.ready);
  const hintId = $props.id();

  // The draft is saved when leaving this editor or before a scan action.
  let name = $state("");
  // Raw: the lists are only ever replaced, and they cross IPC, which cannot clone a proxy.
  let include = $state.raw<string[]>([]);
  let exclude = $state.raw<string[]>([]);
  let ocr = $state(false);
  let image = $state(true);
  let videos = $state(true);
  let saving = $state(false);
  let error = $state("");
  let removingFolder = $state<string | null>(null);
  /** A chosen folder waiting for the keep-or-delete answer before it joins `exclude`. */
  let excludingFolder = $state<string | null>(null);
  let purgeFolders = $state.raw<string[]>([]);

  function resetDraft(): void {
    if (!library) return;
    name = library.name ?? "";
    include = library.include.map((folder) => folder.path);
    exclude = [...library.exclude];
    ocr = library.ocr;
    image = library.image;
    videos = library.videos;
    removingFolder = null;
    excludingFolder = null;
    purgeFolders = [];
  }
  resetDraft();

  const savedInclude = $derived(library?.include.map((folder) => folder.path) ?? []);
  const changeCount = $derived.by(() => {
    if (!library) return 0;
    const added = (next: string[], saved: string[]): number =>
      next.filter((path) => !saved.includes(path)).length +
      saved.filter((path) => !next.includes(path)).length;
    return (
      added(include, savedInclude) +
      added(exclude, library.exclude) +
      Number(ocr !== library.ocr) +
      Number(image !== library.image) +
      Number(videos !== library.videos) +
      Number((name.trim() || null) !== library.name)
    );
  });
  // Library definitions change only on the PC; phones can still scan and make thumbnails.
  const readOnly = isRemote();
  export async function saveChanges(): Promise<boolean> {
    return changeCount === 0 && purgeFolders.length === 0 ? true : apply();
  }
  const scanJob = $derived(
    jobs.active?.type === "libraryScan" && jobs.libraryId === libraryId ? jobs.active : null,
  );
  const placeholder = $derived(derivedLibraryName(include.map((path) => ({ path }))));
  const diagnostic = $derived(
    cleanDiagnostic(
      [
        ...(library?.include.flatMap((folder) =>
          folder.scanError ? [`${folder.path}\n${folder.scanError}`] : [],
        ) ?? []),
        scanJob?.error,
        ...(scanJob?.errors.map((failure) => `${failure.path ?? ""}\n${failure.message}`) ?? []),
      ]
        .filter(Boolean)
        .join("\n\n"),
    ),
  );

  async function addFolder(): Promise<void> {
    try {
      const folder = await window.nicegal.native.chooseDirectory();
      if (!folder) return;
      error = "";
      if (include.some((path) => isWithin(path, folder) && isWithin(folder, path))) return;
      if (exclude.some((path) => isWithin(folder, path))) {
        error = m.library_editor_folder_excluded();
        return;
      }
      include = [...include, folder];
      purgeFolders = purgeFolders.filter((path) => path !== folder);
    } catch (cause) {
      error = errorMessage(cause);
    }
  }

  function removeFolder(path: string, deleteIndexedData: boolean): void {
    include = include.filter((candidate) => candidate !== path);
    purgeFolders = deleteIndexedData
      ? [...new Set([...purgeFolders, path])]
      : purgeFolders.filter((candidate) => candidate !== path);
    removingFolder = null;
    error = "";
  }

  async function excludeFolder(): Promise<void> {
    try {
      const folder = await window.nicegal.native.chooseDirectory(include[0]);
      if (!folder) return;
      error = "";
      if (!include.some((path) => isWithin(folder, path) && !isWithin(path, folder))) {
        error = m.library_editor_choose_subfolder();
        return;
      }
      if (!exclude.some((path) => isWithin(folder, path))) excludingFolder = folder;
    } catch (cause) {
      error = errorMessage(cause);
    }
  }

  /** Like removing a folder, excluding one can also delete its indexed data once saved. */
  function addExclusion(path: string, deleteIndexedData: boolean): void {
    exclude = [...exclude, path];
    purgeFolders = deleteIndexedData
      ? [...new Set([...purgeFolders, path])]
      : purgeFolders.filter((candidate) => candidate !== path);
    excludingFolder = null;
  }

  function includeAgain(path: string): void {
    exclude = exclude.filter((candidate) => candidate !== path);
    purgeFolders = purgeFolders.filter((candidate) => candidate !== path);
  }

  async function apply(): Promise<boolean> {
    if (!library || saving) return false;
    if (!include.length) {
      error = m.library_editor_needs_folder();
      return false;
    }
    if (purgeFolders.length && jobs.running) {
      error = m.library_editor_wait_for_job();
      return false;
    }
    saving = true;
    error = "";
    try {
      await commands.saveLibrary(
        libraryId,
        {
          include,
          exclude: exclude.filter((path) => include.some((root) => isWithin(path, root))),
          ocr,
          image,
          videos,
        },
        name.trim() || null,
      );
      if (
        purgeFolders.length &&
        !(await orchestrator.purgeRemovedFolders(libraryId, purgeFolders))
      ) {
        error = m.library_editor_purge_failed();
        return false;
      }
      resetDraft();
      return true;
    } catch (cause) {
      error = errorMessage(cause);
      return false;
    } finally {
      saving = false;
    }
  }

  async function scan(
    options: { pendingOnly?: boolean; retryFailed?: boolean } = {},
  ): Promise<void> {
    if (await saveChanges()) commands.scanLibrary(libraryId, options);
  }

  // Thumbnail pre-generation, carried over from the retired Libraries dialog.
  const bucketOptions = [128, 256, 512, 1024] as const;
  let selectedBuckets = $state.raw<number[]>([128, 256, 512, 1024]);
  let limitToRange = $state(false);
  let fromDate = $state("");
  let toDate = $state("");

  function toggleBucket(bucket: number): void {
    selectedBuckets = selectedBuckets.includes(bucket)
      ? selectedBuckets.filter((value) => value !== bucket)
      : [...selectedBuckets, bucket].sort((left, right) => left - right);
  }

  function startBackfill(): void {
    if (selectedBuckets.length === 0 || jobs.running || !ready) return;
    const options: ThumbnailBackfillOptions = {
      buckets: selectedBuckets,
      fromNs: limitToRange ? localDateToNs(fromDate) : undefined,
      toNs: limitToRange ? localDateToExclusiveNs(toDate) : undefined,
    };
    void commands.startThumbnailBackfill(libraryId, options);
  }
</script>

<section class="dialog-shell library-editor" class:embedded aria-labelledby="library-editor-title">
  <header>
    <h1 id="library-editor-title">
      {m.library_editor_title({ name: library?.displayName ?? m.library_editor_fallback_name() })}
    </h1>
  </header>

  {#if library}
    <div class="scan-actions" aria-label={m.library_editor_scan_actions_label()}>
      <button
        class="ui-button ui-button-compact"
        onclick={() => void scan()}
        disabled={!ready || saving}>{m.common_rescan_library()}</button
      >
      <button
        class="ui-button ui-button-compact"
        onclick={() => void scan({ retryFailed: true })}
        disabled={!ready || saving}>{m.library_editor_retry_failed()}</button
      >
    </div>
  {/if}

  {#if !library}
    <p class="attention">{m.library_editor_missing()}</p>
  {:else}
    <div class="body">
      <label class="name-row">
        <span>{m.library_editor_name_label()}</span>
        <input
          type="text"
          bind:value={name}
          {placeholder}
          maxlength="200"
          disabled={readOnly}
          title={readOnly ? desktopOnlyTitle() : undefined}
        />
      </label>

      <fieldset disabled={readOnly} title={readOnly ? desktopOnlyTitle() : undefined}>
        <legend>{m.library_editor_folders_legend()}</legend>
        <ul class="folder-list" aria-label={m.library_editor_included_list_label()}>
          {#each include as path (path)}
            {@const saved = library.include.find((folder) => folder.path === path)}
            {@const status = folderStatus(saved)}
            <li>
              <div class="folder-value">
                <Folder size={13} aria-hidden="true" />
                <span class="path" title={saved?.hostPath ?? path}>{saved?.hostPath ?? path}</span>
                <span class={["status", status.tone]} title={status.detail}>{status.text}</span>
              </div>
              {#if saved?.scanOutcome === "unavailable"}
                <button
                  class="ui-button ui-button-compact"
                  onclick={() => void scan({ pendingOnly: true })}
                  disabled={!ready}>{m.library_editor_retry()}</button
                >
              {/if}
              <button
                class="folder-remove"
                aria-label={m.library_editor_remove_folder_label({ path })}
                title={include.length === 1
                  ? m.library_editor_remove_last_folder_title()
                  : m.library_editor_remove_folder_title()}
                disabled={include.length === 1}
                onclick={() => (removingFolder = path)}><X size={14} aria-hidden="true" /></button
              >
            </li>
          {:else}
            <li class="empty">{m.library_editor_no_folders()}</li>
          {/each}
        </ul>
        {#if removingFolder}
          <div
            class="remove-folder-confirmation"
            role="group"
            aria-label={m.library_editor_remove_folder_group()}
          >
            <span>{m.library_editor_remove_folder_confirm({ path: removingFolder })}</span>
            <button
              class="ui-button ui-button-compact"
              onclick={() => removeFolder(removingFolder!, false)}
              >{m.library_editor_keep_indexed_data()}</button
            >
            <button
              class="ui-button ui-button-compact"
              onclick={() => removeFolder(removingFolder!, true)}
              >{m.library_editor_delete_indexed_data()}</button
            >
            <button class="ui-button ui-button-compact" onclick={() => (removingFolder = null)}
              >{m.common_cancel()}</button
            >
          </div>
        {/if}
        <div class="list-actions">
          <button
            class="ui-button ui-button-compact"
            onclick={addFolder}
            title={readOnly ? desktopOnlyTitle() : undefined}
            disabled={readOnly}
            ><Plus size={13} aria-hidden="true" /> {m.library_editor_add_folder()}</button
          >
          {#if include.length === 1}
            <span class="hint">{m.library_editor_add_another_hint()}</span>
          {/if}
        </div>
      </fieldset>

      <fieldset disabled={readOnly} title={readOnly ? desktopOnlyTitle() : undefined}>
        <legend>{m.library_editor_excluded_legend()}</legend>
        <p class="hint">{m.library_editor_excluded_hint()}</p>
        {#if exclude.length}
          <ul class="folder-list" aria-label={m.library_editor_excluded_legend()}>
            {#each exclude as path (path)}
              <li>
                <div class="folder-value">
                  <Folder size={13} aria-hidden="true" />
                  <span class="path" title={path}>{path}</span>
                  {#if !library.exclude.includes(path)}<span class="status"
                      >{m.library_editor_added_status()}</span
                    >{/if}
                </div>
                <button
                  class="folder-remove"
                  aria-label={m.library_editor_include_again_label({ path })}
                  title={m.library_editor_include_again_title()}
                  onclick={() => includeAgain(path)}><X size={14} aria-hidden="true" /></button
                >
              </li>
            {/each}
          </ul>
        {/if}
        {#if excludingFolder}
          <div
            class="remove-folder-confirmation"
            role="group"
            aria-label={m.library_editor_exclude_folder_group()}
          >
            <span>{m.library_editor_exclude_confirm({ path: excludingFolder })}</span>
            <button
              class="ui-button ui-button-compact"
              onclick={() => addExclusion(excludingFolder!, false)}
              >{m.library_editor_keep_indexed_data()}</button
            >
            <button
              class="ui-button ui-button-compact"
              onclick={() => addExclusion(excludingFolder!, true)}
              >{m.library_editor_delete_indexed_data()}</button
            >
            <button class="ui-button ui-button-compact" onclick={() => (excludingFolder = null)}
              >{m.common_cancel()}</button
            >
          </div>
        {/if}
        <div class="list-actions">
          <button
            class="ui-button ui-button-compact"
            onclick={excludeFolder}
            title={readOnly ? desktopOnlyTitle() : undefined}
            disabled={!include.length || readOnly}
            ><Plus size={13} aria-hidden="true" /> {m.library_editor_exclude_folder()}</button
          >
        </div>
      </fieldset>

      <fieldset disabled={readOnly} title={readOnly ? desktopOnlyTitle() : undefined}>
        <legend>{m.library_editor_search_legend()}</legend>
        <label class="check"
          ><input type="checkbox" bind:checked={image} /> {m.library_status_image_search()}</label
        >
        <label class="check indent"
          ><input type="checkbox" bind:checked={videos} disabled={!image} />
          {m.library_editor_include_videos()}</label
        >
        <label class="check"
          ><input type="checkbox" bind:checked={ocr} aria-describedby={hintId} />
          {m.library_status_text_recognition()}</label
        >
        <p class="hint indent" id={hintId}>
          {m.library_editor_ocr_hint()}
        </p>
        <div class="list-actions">
          <button class="ui-button ui-button-compact" onclick={onopensearchsettings}
            >{m.common_search_settings_ellipsis()}</button
          >
          <span class="hint">{m.library_editor_search_settings_hint()}</span>
        </div>
      </fieldset>

      <details>
        <summary>{m.library_editor_advanced()}</summary>
        <div class="advanced">
          <section aria-labelledby="thumbnail-heading">
            <h2 id="thumbnail-heading">{m.library_editor_thumbnails_heading()}</h2>
            <p class="hint">
              {m.library_editor_thumbnails_hint()}
            </p>
            <div class="advanced-row">
              {#each bucketOptions as bucket (bucket)}
                <label class="check">
                  <input
                    type="checkbox"
                    checked={selectedBuckets.includes(bucket)}
                    onchange={() => toggleBucket(bucket)}
                  />
                  {m.library_editor_thumbnail_size({ size: bucket })}
                </label>
              {/each}
              <label class="check"
                ><input type="checkbox" bind:checked={limitToRange} />
                {m.library_editor_date_range()}</label
              >
            </div>
            {#if limitToRange}
              <div class="advanced-row">
                <label>{m.library_editor_from()} <input type="date" bind:value={fromDate} /></label>
                <label>{m.library_editor_to()} <input type="date" bind:value={toDate} /></label>
              </div>
            {/if}
            <button
              class="ui-button ui-button-compact"
              onclick={startBackfill}
              disabled={!ready || jobs.running || selectedBuckets.length === 0}
              >{m.library_editor_generate()}</button
            >
          </section>
          <ThumbnailFailures failures={thumbnailFailures} onretry={onretrythumbnails} />
          {#if diagnostic}
            <TechnicalDetails text={diagnostic} summary={m.library_editor_scan_error_details()} />
          {/if}
        </div>
      </details>
    </div>
  {/if}

  {#if error || changeCount}
    <footer>
      <span class={["footer-status", { attention: Boolean(error) }]} role="status">
        {error || m.library_editor_changes_status({ count: changeCount })}
      </span>
    </footer>
  {/if}
</section>

<style>
  .library-editor {
    display: flex;
    flex-direction: column;
    max-height: min(var(--dialog-max-height), 100%);
    font-size: var(--font-size-md);
  }
  .library-editor.embedded {
    height: 100%;
    max-height: none;
    border: 0;
    box-shadow: none;
  }
  header {
    padding: var(--space-8) var(--space-12);
    border-bottom: 1px solid var(--border-subtle);
  }
  .scan-actions {
    flex: none;
    padding: var(--space-6) var(--space-12);
    border-bottom: 1px solid var(--border-subtle);
  }
  h1 {
    margin: 0;
    font-size: var(--dialog-title-size);
  }
  h2 {
    margin: 0;
    font-size: var(--font-size-md);
    font-weight: var(--font-weight-semibold);
  }
  .body {
    display: grid;
    flex: 1;
    align-content: start;
    gap: var(--space-8);
    min-height: 0;
    overflow: auto;
    padding: var(--space-8) var(--space-12);
  }
  .name-row {
    display: flex;
    align-items: center;
    gap: var(--space-8);
  }
  .name-row input {
    flex: 1;
    min-width: 0;
  }
  input[type="text"],
  input[type="date"] {
    padding: var(--space-2) var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: var(--text-primary);
    font: inherit;
  }
  fieldset {
    display: grid;
    gap: var(--space-4);
    min-width: 0;
    margin: 0;
    padding: var(--space-4) var(--space-8) var(--space-8);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  legend {
    padding: 0 var(--space-3);
  }
  .folder-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .folder-list li {
    display: flex;
    align-items: center;
    gap: var(--space-6);
    min-width: 0;
    padding: var(--space-2) 0;
  }
  .folder-value {
    display: flex;
    flex: 1;
    align-items: center;
    gap: var(--space-5);
    min-width: 0;
    min-height: var(--control-height);
    box-sizing: border-box;
    padding: 0 var(--space-6);
    border: 1px solid var(--border);
    background: var(--surface-1);
  }
  .folder-value :global(svg) {
    flex: none;
    color: var(--text-secondary);
  }
  .folder-remove {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: var(--control-height);
    height: var(--control-height);
    border: 1px solid var(--btn-border);
    border-radius: var(--radius-sm);
    background: var(--btn-face);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .folder-remove:hover {
    border-color: var(--btn-border-hover);
    background: var(--btn-face-hover);
    color: var(--danger);
  }
  .folder-remove:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .remove-folder-confirmation {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-4);
  }
  .remove-folder-confirmation span {
    flex-basis: 100%;
    overflow-wrap: anywhere;
  }
  .folder-remove:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status,
  .hint,
  .empty,
  .footer-status {
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .status {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .attention {
    color: var(--danger);
  }
  p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .indent {
    padding-left: calc(var(--space-14) + var(--space-6));
  }
  .list-actions,
  .advanced-row,
  .scan-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-6);
  }
  .list-actions .ui-button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-4);
  }
  .check {
    display: flex;
    align-items: center;
    gap: var(--space-6);
  }
  input[type="checkbox"] {
    width: var(--space-14);
    height: var(--space-14);
    margin: 0;
    accent-color: var(--accent);
  }
  summary {
    cursor: pointer;
  }
  .advanced {
    display: grid;
    gap: var(--space-8);
    padding-top: var(--space-6);
  }
  .advanced section {
    display: grid;
    gap: var(--space-4);
    justify-items: start;
  }
  footer {
    display: flex;
    align-items: center;
    gap: var(--space-6);
    padding: var(--space-8) var(--space-12);
    border-top: 1px solid var(--border-subtle);
  }
  .footer-status {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  input:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
</style>
