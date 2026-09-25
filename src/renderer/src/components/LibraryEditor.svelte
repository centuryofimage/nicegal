<script lang="ts">
  import Folder from "@lucide/svelte/icons/folder";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";

  import type { LibraryId } from "../../../shared/backend";
  import type { ThumbnailFailure } from "../lib/gallery/thumbnail-scheduler";

  import { useApplication } from "../lib/application.svelte";
  import { derivedLibraryName } from "../lib/catalog.svelte";
  import { cleanDiagnostic, errorMessage } from "../lib/errors";
  import {
    localDateToExclusiveNs,
    localDateToNs,
    type ThumbnailBackfillOptions,
  } from "../lib/job-params";
  import { folderStatus, isWithin } from "../lib/library-status";
  import ThumbnailFailures from "./ThumbnailFailures.svelte";

  let {
    libraryId,
    embedded = false,
    thumbnailFailures = [],
    onretrythumbnails,
  }: {
    libraryId: LibraryId;
    embedded?: boolean;
    thumbnailFailures?: readonly (ThumbnailFailure & { name?: string })[];
    onretrythumbnails: () => void;
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
  let saving = $state(false);
  let error = $state("");
  let copyStatus = $state("");
  let removingFolder = $state<string | null>(null);
  let purgeFolders = $state.raw<string[]>([]);

  function resetDraft(): void {
    if (!library) return;
    name = library.name ?? "";
    include = library.include.map((folder) => folder.path);
    exclude = [...library.exclude];
    ocr = library.ocr;
    image = library.image;
    removingFolder = null;
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
      Number((name.trim() || null) !== library.name)
    );
  });
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
        error = "That folder is excluded. Include it again instead.";
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
        error = "Choose a subfolder of one of this library's folders.";
        return;
      }
      if (!exclude.some((path) => isWithin(folder, path))) exclude = [...exclude, folder];
    } catch (cause) {
      error = errorMessage(cause);
    }
  }

  async function apply(): Promise<boolean> {
    if (!library || saving) return false;
    if (!include.length) {
      error =
        "A library needs at least one folder. To delete it, use Remove library in this dialog.";
      return false;
    }
    if (purgeFolders.length && jobs.running) {
      error = "Wait for the current job to finish before deleting indexed folder data.";
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
        },
        name.trim() || null,
      );
      if (purgeFolders.length && !(await orchestrator.purgeRemovedFolders(libraryId, purgeFolders))) {
        error = "The folder was removed, but deleting its indexed data could not start. Try saving again.";
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

  async function scan(options: { pendingOnly?: boolean; retryFailed?: boolean } = {}): Promise<void> {
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

  async function copyDetails(): Promise<void> {
    try {
      await navigator.clipboard.writeText(diagnostic);
      copyStatus = "Copied";
    } catch {
      copyStatus = "Select the details and copy them manually.";
    }
  }
</script>

<section class="library-editor" class:embedded aria-labelledby="library-editor-title">
  <header>
    <h1 id="library-editor-title" tabindex="-1">Edit “{library?.displayName ?? "library"}”</h1>
  </header>

  {#if library}
    <div class="scan-actions" aria-label="Library scan actions">
      <button
        class="ui-button ui-button-compact"
        onclick={() => void scan()}
        disabled={!ready || saving}>Rescan library</button
      >
      <button
        class="ui-button ui-button-compact"
        onclick={() => void scan({ retryFailed: true })}
        disabled={!ready || saving}>Retry failed files</button
      >
    </div>
  {/if}

  {#if !library}
    <p class="attention">This library no longer exists.</p>
  {:else}
    <div class="body">
      <label class="name-row">
        <span>Name</span>
        <input type="text" bind:value={name} {placeholder} maxlength="200" />
      </label>

      <fieldset>
        <legend>Folders</legend>
        <ul class="folder-list" aria-label="Included folders">
          {#each include as path (path)}
            {@const saved = library.include.find((folder) => folder.path === path)}
            {@const status = folderStatus(saved)}
            <li>
              <div class="folder-value">
                <Folder size={13} aria-hidden="true" />
                <span class="path" title={path}>{path}</span>
                <span class={["status", status.tone]} title={status.detail}>{status.text}</span>
              </div>
              {#if saved?.scanOutcome === "unavailable"}
                <button
                  class="ui-button ui-button-compact"
                  onclick={() => void scan({ pendingOnly: true })}
                  disabled={!ready}>Retry</button
                >
              {/if}
              <button
                class="folder-remove"
                aria-label={`Remove ${path} from this library`}
                title={include.length === 1
                  ? "Remove the library to remove its last folder"
                  : "Remove folder from this library"}
                disabled={include.length === 1}
                onclick={() => (removingFolder = path)}
                ><X size={14} aria-hidden="true" /></button
              >
            </li>
          {:else}
            <li class="empty">No folders. Add one to keep this library.</li>
          {/each}
        </ul>
        {#if removingFolder}
          <div class="remove-folder-confirmation" role="group" aria-label="Remove folder">
            <span>Remove {removingFolder} from this library?</span>
            <button class="ui-button ui-button-compact" onclick={() => removeFolder(removingFolder!, false)}
              >Keep indexed data</button
            >
            <button class="ui-button ui-button-compact" onclick={() => removeFolder(removingFolder!, true)}
              >Delete indexed data</button
            >
            <button class="ui-button ui-button-compact" onclick={() => (removingFolder = null)}
              >Cancel</button
            >
          </div>
        {/if}
        <div class="list-actions">
          <button class="ui-button ui-button-compact" onclick={addFolder}
            ><Plus size={13} aria-hidden="true" /> Add folder…</button
          >
          {#if include.length === 1}
            <span class="hint">You can add another folder to this library.</span>
          {/if}
        </div>
      </fieldset>

      <fieldset>
        <legend>Excluded folders</legend>
        <p class="hint">Hidden from this library and skipped by future scans.</p>
        {#if exclude.length}
          <ul class="folder-list" aria-label="Excluded folders">
            {#each exclude as path (path)}
              <li>
                <div class="folder-value">
                  <Folder size={13} aria-hidden="true" />
                  <span class="path" title={path}>{path}</span>
                  {#if !library.exclude.includes(path)}<span class="status">Added</span>{/if}
                </div>
                <button
                  class="folder-remove"
                  aria-label={`Include ${path} again`}
                  title="Remove exclusion and include this folder again"
                  onclick={() => (exclude = exclude.filter((candidate) => candidate !== path))}
                  ><X size={14} aria-hidden="true" /></button
                >
              </li>
            {/each}
          </ul>
        {/if}
        <div class="list-actions">
          <button
            class="ui-button ui-button-compact"
            onclick={excludeFolder}
            disabled={!include.length}><Plus size={13} aria-hidden="true" /> Exclude folder…</button
          >
        </div>
      </fieldset>

      <fieldset>
        <legend>Search</legend>
        <label class="check"><input type="checkbox" bind:checked={image} /> Image search</label>
        <label class="check"
          ><input type="checkbox" bind:checked={ocr} aria-describedby={hintId} /> Text recognition</label
        >
        <p class="hint indent" id={hintId}>
          About 10× slower than image search, but good for precise text searches. Models download
          automatically; pictures stay on your computer.
        </p>
      </fieldset>

      <details>
        <summary>Advanced</summary>
        <div class="advanced">
          <section aria-labelledby="thumbnail-heading">
            <h2 id="thumbnail-heading">Thumbnails</h2>
            <p class="hint">
              Thumbnails are generated on demand. Pre-generate only if you need them.
            </p>
            <div class="advanced-row">
              {#each bucketOptions as bucket (bucket)}
                <label class="check">
                  <input
                    type="checkbox"
                    checked={selectedBuckets.includes(bucket)}
                    onchange={() => toggleBucket(bucket)}
                  />
                  {bucket}px
                </label>
              {/each}
              <label class="check"
                ><input type="checkbox" bind:checked={limitToRange} /> Date range</label
              >
            </div>
            {#if limitToRange}
              <div class="advanced-row">
                <label>From <input type="date" bind:value={fromDate} /></label>
                <label>To <input type="date" bind:value={toDate} /></label>
              </div>
            {/if}
            <button
              class="ui-button ui-button-compact"
              onclick={startBackfill}
              disabled={!ready || jobs.running || selectedBuckets.length === 0}>Generate</button
            >
          </section>
          <ThumbnailFailures failures={thumbnailFailures} onretry={onretrythumbnails} />
          {#if diagnostic}
            <details class="diagnostics">
              <summary>Scan error details</summary>
              <textarea aria-label="Scan error details" readonly value={diagnostic}></textarea>
              <button class="ui-button ui-button-compact" onclick={copyDetails}>Copy details</button
              >
              <span role="status">{copyStatus}</span>
            </details>
          {/if}
        </div>
      </details>
    </div>
  {/if}

  {#if error || changeCount}
    <footer>
      <span class={["footer-status", { attention: Boolean(error) }]} role="status">
        {error || `${changeCount} ${changeCount === 1 ? "change" : "changes"} · saves when you leave this view`}
      </span>
    </footer>
  {/if}
</section>

<style>
  .library-editor {
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    width: 100%;
    max-height: min(var(--dialog-max-height), 100%);
    border: 1px solid var(--border-strong);
    background: var(--surface-0);
    box-shadow: var(--shadow-overlay);
    color: var(--text-primary);
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
  textarea {
    display: block;
    box-sizing: border-box;
    width: 100%;
    height: min(180px, 30vh);
    margin-block: var(--space-6);
    resize: none;
    overflow: auto;
    border: 1px solid var(--border);
    background: var(--surface-1);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
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
