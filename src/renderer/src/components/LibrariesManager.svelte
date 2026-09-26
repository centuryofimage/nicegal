<script lang="ts">
  import type { LibraryId } from "../../../shared/backend";
  import type { ThumbnailFailure } from "../lib/gallery/thumbnail-scheduler";
  import type { LibraryViewController } from "../lib/library-view.svelte";

  import { useApplication } from "../lib/application.svelte";
  import type { LibraryRecord } from "../lib/catalog.svelte";
  import { sameFolder } from "../lib/library-root";
  import { libraryOptionsSummary } from "../lib/library-status";
  import LibraryEditor from "./LibraryEditor.svelte";

  let {
    view,
    onclose,
    thumbnailFailures,
    onretrythumbnails,
  }: {
    view: LibraryViewController;
    onclose: () => void;
    thumbnailFailures: readonly (ThumbnailFailure & { name?: string })[];
    onretrythumbnails: () => void;
  } = $props();

  const { catalog, jobs, orchestrator } = useApplication().services;
  let managingId = $state<LibraryId | null | undefined>(undefined);
  const currentId = $derived(managingId === undefined ? (view.editingLibraryId ?? catalog.selectedId) : managingId);
  let editor = $state.raw<LibraryEditor>();
  let createBusy = $state(false);
  let createError = $state("");
  let removing = $state.raw<LibraryRecord | null>(null);
  let removeBusy = $state(false);
  let removeError = $state("");
  let stoppingJob = $state(false);
  let navigationBusy = $state(false);

  const selected = $derived(catalog.libraries.find((library) => library.id === currentId));

  function duplicateOf(library: LibraryRecord): LibraryRecord | undefined {
    return catalog.libraries.find(
      (other) =>
        other.id !== library.id &&
        library.include.some((folder) =>
          other.include.some((candidate) => sameFolder(folder.path, candidate.path)),
        ),
    );
  }

  export async function requestClose(): Promise<void> {
    if (removeBusy || createBusy || navigationBusy) return;
    navigationBusy = true;
    try {
      if (editor && !(await editor.saveChanges())) return;
      onclose();
    } finally {
      navigationBusy = false;
    }
  }

  /** Saves the draft, then switches to Settings → Search without releasing the scan hold. */
  async function openSearchSettings(): Promise<void> {
    if (removeBusy || createBusy || navigationBusy) return;
    navigationBusy = true;
    try {
      if (editor && !(await editor.saveChanges())) return;
      view.openSettingsDialog("search");
    } finally {
      navigationBusy = false;
    }
  }

  async function select(id: LibraryId): Promise<void> {
    if (id === currentId || navigationBusy) return;
    navigationBusy = true;
    try {
      if (editor && !(await editor.saveChanges())) return;
      managingId = id;
      createError = "";
      void view.selectLibrary(id);
    } finally {
      navigationBusy = false;
    }
  }

  async function add(): Promise<void> {
    if (createBusy || navigationBusy) return;
    if (editor && !(await editor.saveChanges())) return;
    createBusy = true;
    createError = "";
    try {
      const result = await view.addLibrary();
      if (result.status === "created") managingId = result.id;
      else if (result.status === "error") createError = result.message;
    } finally {
      createBusy = false;
    }
  }

  async function prepareRemoval(): Promise<void> {
    if (!selected || navigationBusy) return;
    navigationBusy = true;
    try {
      if (editor && !(await editor.saveChanges())) return;
      removeError = "";
      removing = selected;
    } finally {
      navigationBusy = false;
    }
  }

  async function stopJob(): Promise<void> {
    if (stoppingJob) return;
    stoppingJob = true;
    try {
      await orchestrator.cancel();
    } finally {
      stoppingJob = false;
    }
  }

  async function remove(purge: boolean): Promise<void> {
    if (!removing || removeBusy || jobs.running) return;
    removeBusy = true;
    removeError = "";
    try {
      if (await view.removeLibrary(removing.id, purge)) {
        const next = catalog.libraries.find((library) => library.id !== removing?.id);
        managingId = next?.id ?? null;
        removing = null;
      } else {
        removeError = "Wait for the current job to stop, then try again.";
      }
    } catch (error) {
      removeError = error instanceof Error ? error.message : String(error);
    } finally {
      removeBusy = false;
    }
  }
</script>

<section class="manager" aria-labelledby="libraries-manager-title">
  <header class="manager-header">
    <h1 id="libraries-manager-title" tabindex="-1">Libraries</h1>
    <button class="ui-button ui-button-compact" onclick={requestClose}>Close</button>
  </header>

  <div class="manager-main">
    <aside class="library-list" aria-label="Libraries to manage">
      <div class="library-rows">
        {#each catalog.libraries as library (library.id)}
          {@const duplicate = duplicateOf(library)}
          {@const status = catalog.libraryStatuses.get(library.id)}
          <button
            class:selected={library.id === currentId}
            aria-pressed={library.id === currentId}
            onclick={() => void select(library.id)}
          >
            <span class="library-label">
              <strong>{library.displayName}</strong>
              {#if duplicate}<span class="duplicate">Duplicate folder</span>{/if}
            </span>
            <span class="library-paths">{library.include.map((folder) => folder.path).join(" · ")}</span>
            <span class="library-summary">
              {status && !status.loading ? `${status.cataloged.toLocaleString()} files · ` : ""}{libraryOptionsSummary(library)}
            </span>
          </button>
        {:else}
          <p class="empty">No libraries yet. Choose a folder to create one.</p>
        {/each}
      </div>
      <div class="list-actions">
        <button class="ui-button" onclick={() => void add()} disabled={createBusy || !catalog.backendStatus.ready}
          >New library…</button
        >
        <button
          class="ui-button"
          onclick={() => void prepareRemoval()}
          disabled={!selected || navigationBusy}
          >Remove library…</button
        >
        {#if createError}<p class="error" role="alert">{createError}</p>{/if}
      </div>
    </aside>

    <div class="manager-details">
      {#if removing}
        <section class="remove-confirmation" aria-labelledby="remove-library-title">
          <h2 id="remove-library-title">Remove “{removing.displayName}”?</h2>
          <p>{removing.include.map((folder) => folder.path).join(" · ")}</p>
          <p>Original files are never touched. Indexed data another library uses is kept.</p>
          {#if jobs.running}
            <p role="status">A job is running. Stop it before removing this library.</p>
            <button class="ui-button stop-job" onclick={() => void stopJob()} disabled={stoppingJob || jobs.active?.status === "cancelling"}
              >{stoppingJob || jobs.active?.status === "cancelling" ? "Stopping jobs…" : "Stop running and queued jobs"}</button
            >
          {/if}
          {#if removeError}<p class="error" role="alert">{removeError}</p>{/if}
          <div class="remove-actions">
            <button class="ui-button" onclick={() => void remove(false)} disabled={removeBusy || jobs.running}
              >Remove, keep indexed data</button
            >
            <button class="ui-button" onclick={() => void remove(true)} disabled={removeBusy || jobs.running}
              >Remove and delete indexed data</button
            >
            <button class="ui-button" onclick={() => (removing = null)} disabled={removeBusy}
              >Cancel</button
            >
          </div>
        </section>
      {:else if selected}
        {#key selected.id}
          <LibraryEditor
            bind:this={editor}
            libraryId={selected.id}
            embedded
            {thumbnailFailures}
            {onretrythumbnails}
            onopensearchsettings={openSearchSettings}
          />
        {/key}
      {:else}
        <p class="empty details-empty">Choose a library from the list, or create one.</p>
      {/if}
    </div>
  </div>

</section>

<style>
  .manager {
    position: relative;
    display: flex;
    box-sizing: border-box;
    width: 100%;
    height: min(700px, calc(100vh - var(--space-16) * 2));
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--border-strong);
    background: var(--surface-0);
    box-shadow: var(--shadow-overlay);
    color: var(--text-primary);
    font-size: var(--font-size-md);
  }
  .manager-header {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-8) var(--space-12);
    border-bottom: 1px solid var(--border-subtle);
  }
  h1, h2, p { margin: 0; }
  h1, h2 { font-size: var(--dialog-title-size); }
  .manager-main {
    display: grid;
    flex: 1;
    grid-template-columns: minmax(220px, 31%) minmax(0, 1fr);
    min-height: 0;
  }
  .library-list {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border-subtle);
    background: var(--surface-1);
  }
  .library-rows { flex: 1; min-height: 0; overflow: auto; }
  .library-rows button {
    display: grid;
    width: 100%;
    gap: var(--space-2);
    padding: var(--space-6) var(--space-8);
    border: 0;
    border-bottom: 1px solid var(--border-subtle);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .library-rows button:hover, .library-rows button:focus-visible { background: var(--surface-hover); }
  .library-rows button.selected { background: var(--btn-face-active); color: var(--text-primary); }
  .library-label { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-4); }
  .library-paths, .library-summary { color: var(--text-secondary); font-size: var(--font-size-sm); overflow-wrap: anywhere; }
  .duplicate { color: var(--danger); font-size: var(--font-size-sm); }
  .list-actions { display: grid; justify-items: start; gap: var(--space-6); padding: var(--space-8); border-top: 1px solid var(--border-subtle); }
  .manager-details { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .empty { padding: var(--space-8); color: var(--text-secondary); }
  .details-empty { padding: var(--space-12); }
  .error { color: var(--danger); overflow-wrap: anywhere; }
  .remove-confirmation { display: grid; align-content: start; gap: var(--space-8); padding: var(--space-12); }
  .remove-confirmation p { overflow-wrap: anywhere; }
  .remove-actions { display: flex; flex-wrap: wrap; gap: var(--space-6); }
  .stop-job { justify-self: start; }
  @media (max-width: 650px) {
    .manager-main { display: flex; flex-direction: column; }
    .library-list { flex: 0 0 auto; max-height: 35%; border-right: 0; border-bottom: 1px solid var(--border-subtle); }
    .list-actions { display: flex; flex-wrap: wrap; }
    .manager-details { flex: 1; }
  }
</style>
