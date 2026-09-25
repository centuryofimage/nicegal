<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Folder from "@lucide/svelte/icons/folder";
  import Folders from "@lucide/svelte/icons/folders";

  import type { LibraryId } from "../../../shared/backend";

  import { useApplication } from "../lib/application.svelte";
  import { folderName } from "../lib/catalog.svelte";
  import { folderStatus, libraryOptionsSummary } from "../lib/library-status";
  import { popoverDismiss } from "../lib/popover-dismiss";
  import { parseQuery, withFolder } from "../lib/search-query";

  let {
    onselect,
    onmanage,
    onscan,
  }: {
    onselect: (libraryId: LibraryId) => void;
    onmanage: () => void;
    onscan: () => void;
  } = $props();

  const { catalog, ocrSearch, jobs } = useApplication().services;
  const selected = $derived(catalog.selectedLibrary);
  const ready = $derived(catalog.backendStatus.ready);
  let menuOpen = $state(false);
  let folders = $state.raw<string[]>([]);
  let folderError = $state("");
  let expanded = $state<Record<string, boolean>>({});
  const focused = $derived(parseQuery(ocrSearch.query).folder);

  $effect(() => {
    const libraryId = catalog.selectedId;
    void jobs.completedScanRevision;
    if (libraryId === null || !ready) {
      folders = [];
      return () => {};
    }
    let current = true;
    void window.nicegal.backend
      .listFolders(libraryId)
      .then((paths) => {
        if (current) {
          folders = paths;
          folderError = "";
        }
      })
      .catch(() => {
        if (current) folderError = "Folders could not be loaded.";
      });
    return () => {
      current = false;
    };
  });

  function parentOf(path: string): string | null {
    const trimmed = path.replace(/[\\/]+$/, "");
    const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    return index < 0 ? null : trimmed.slice(0, index);
  }

  type FolderRow = { path: string; depth: number; children: boolean };
  const rows = $derived.by((): FolderRow[] => {
    const paths = [
      ...new Set([...(selected?.include.map((folder) => folder.path) ?? []), ...folders]),
    ];
    const set = new Set(paths);
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- temporary lookup rebuilt by this derived calculation
    const children = new Map<string | null, string[]>();
    for (const path of paths) {
      let parent = parentOf(path);
      while (parent && !set.has(parent)) parent = parentOf(parent);
      const siblings = children.get(parent) ?? [];
      siblings.push(path);
      children.set(parent, siblings);
    }
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    for (const siblings of children.values())
      siblings.sort((a, b) => collator.compare(folderName(a), folderName(b)));
    const visible: FolderRow[] = [];
    const visit = (parent: string | null, depth: number): void => {
      for (const path of children.get(parent) ?? []) {
        const hasChildren = Boolean(children.get(path)?.length);
        visible.push({ path, depth, children: hasChildren });
        const onFocusedBranch =
          focused?.startsWith(`${path.replace(/[\\/]+$/, "")}/`) ||
          focused?.startsWith(`${path.replace(/[\\/]+$/, "")}\\`);
        if (hasChildren && (expanded[path] ?? (depth === 0 || Boolean(onFocusedBranch))))
          visit(path, depth + 1);
      }
    };
    visit(null, 0);
    return visible;
  });

  function focus(path: string | null): void {
    ocrSearch.query = withFolder(ocrSearch.query, path);
  }

  function choose(action: () => void): void {
    menuOpen = false;
    action();
  }
</script>

<aside id="libraries-pane" class="libraries-pane" aria-label="Libraries">
  <header {@attach popoverDismiss(menuOpen, () => (menuOpen = false))}>
    <button
      class="library-menu-button"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      title={selected?.include.map((folder) => folder.path).join("\n")}
      onclick={() => (menuOpen = !menuOpen)}
      disabled={!catalog.libraries.length}
    >
      <span class="library-name">{selected?.displayName ?? "No library"}</span>
      <ChevronDown size={12} aria-hidden="true" />
    </button>
    {#if menuOpen}
      <div class="library-menu" role="menu" aria-label="Libraries">
        {#each catalog.libraries as library (library.id)}
          <button
            role="menuitemradio"
            aria-checked={library.id === catalog.selectedId}
            onclick={() => choose(() => onselect(library.id))}
          >
            <span class="mark" aria-hidden="true">
              {#if library.id === catalog.selectedId}<Check size={11} />{/if}
            </span>
            <span class="menu-label"
              ><span class="label">{library.displayName}</span>
              <span class="menu-path"
                >{library.include.map((folder) => folder.path).join(" · ")}</span
              >
              <span class="menu-path">{libraryOptionsSummary(library)}</span></span
            >
          </button>
        {/each}
        <div class="separator" role="separator"></div>
        <button role="menuitem" onclick={() => choose(onscan)} disabled={!ready || !selected}>
          <span class="mark" aria-hidden="true"></span>
          <span class="label">Rescan library</span>
        </button>
        <button role="menuitem" onclick={() => choose(onmanage)}>
          <span class="mark" aria-hidden="true"></span>
          <span class="label">Library manager</span>
        </button>
      </div>
    {/if}
  </header>

  <div class="folders themed-scrollbar" aria-label="Folders">
    {#if selected}
      <button
        class="tree-row"
        class:active={focused === null}
        aria-current={focused === null ? "page" : undefined}
        onclick={() => focus(null)}
      >
        <span class="expander"></span><Folders size={14} aria-hidden="true" /><span
          class="folder-name">All folders</span
        >
      </button>
      {#each rows as row (row.path)}
        {@const root = selected.include.find((folder) => folder.path === row.path)}
        {@const status = root ? folderStatus(root) : null}
        <div
          class="tree-row"
          class:active={focused === row.path}
          style:padding-left={`calc(var(--space-4) + ${row.depth * 14}px)`}
          title={[row.path, status?.detail].filter(Boolean).join("\n")}
        >
          {#if row.children}
            <button
              class="expander"
              aria-label={`${(expanded[row.path] ?? row.depth === 0) ? "Collapse" : "Expand"} ${folderName(row.path)}`}
              aria-expanded={expanded[row.path] ?? row.depth === 0}
              onclick={() =>
                (expanded = { ...expanded, [row.path]: !(expanded[row.path] ?? row.depth === 0) })}
            >
              {#if expanded[row.path] ?? row.depth === 0}<ChevronDown
                  size={12}
                />{:else}<ChevronRight size={12} />{/if}
            </button>
          {:else}<span class="expander"></span>{/if}
          <button
            class="folder-action"
            aria-current={focused === row.path ? "page" : undefined}
            onclick={() => focus(row.path)}
          >
            <Folder size={14} aria-hidden="true" /><span class="folder-name"
              >{folderName(row.path)}</span
            >
            {#if status?.text}<span class={["status", status.tone]}>{status.text}</span>{/if}
          </button>
        </div>
      {/each}
      {#if jobs.scanState(selected.id) && rows.length <= selected.include.length}
        <p class="folder-error" role="status">Discovering folders…</p>
      {/if}
      {#if folderError}<p class="folder-error" role="status">{folderError}</p>{/if}
    {:else if catalog.librariesLoaded}
      <p class="folder-error">
        {catalog.librariesError
          ? "Libraries could not be loaded."
          : "Use Library manager to add a folder."}
      </p>
    {/if}
  </div>
</aside>

<style>
  .libraries-pane {
    display: flex;
    flex-direction: column;
    flex: 0 0 var(--libraries-pane-width);
    min-width: 0;
    min-height: 0;
    border-right: 1px solid var(--border);
    background: var(--surface-1);
    color: var(--text-primary);
    font-size: var(--font-size-md);
  }
  header {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
  }
  .library-menu-button {
    display: inline-flex;
    align-items: center;
    height: 24px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: inherit;
    font: inherit;
  }
  .library-menu-button {
    flex: 1;
    min-width: 0;
    gap: var(--space-4);
    padding: 0 var(--space-4);
    font-weight: var(--font-weight-semibold);
    text-align: left;
  }
  .library-menu-button:hover:not(:disabled),
  .library-menu-button[aria-expanded="true"] {
    border-color: var(--border);
    background: var(--surface-hover);
  }
  .library-menu-button:disabled {
    color: var(--text-tertiary);
  }
  .library-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .library-menu {
    position: absolute;
    top: calc(100% - var(--space-2));
    left: var(--space-4);
    z-index: var(--z-popover);
    display: grid;
    min-width: calc(100% - var(--space-8));
    max-width: 320px;
    padding: var(--space-2);
    border: 1px solid var(--border);
    background: var(--surface-0);
    box-shadow: var(--shadow-overlay);
  }
  .library-menu button {
    display: flex;
    min-height: 22px;
    align-items: center;
    gap: var(--space-6);
    min-width: 0;
    padding: 0 var(--space-6) 0 var(--space-2);
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-primary);
    font: inherit;
    font-size: 12px;
    text-align: left;
  }
  .library-menu button:hover:not(:disabled),
  .library-menu button:focus-visible {
    border-color: var(--border);
    background: var(--surface-hover);
    outline: none;
  }
  .library-menu button:disabled {
    color: var(--text-tertiary);
  }
  .mark {
    display: inline-flex;
    flex: none;
    width: 13px;
    justify-content: center;
    color: var(--accent-active);
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu-label {
    display: grid;
    min-width: 0;
    padding: var(--space-2) 0;
  }
  .menu-path {
    overflow: hidden;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .separator {
    height: 1px;
    margin: var(--space-2) var(--space-2) var(--space-2) 21px;
    background: var(--border-subtle);
  }
  .folders {
    flex: 1;
    min-height: 0;
    overflow: auto;
    margin: 0;
    padding: var(--space-3) 0;
  }
  .tree-row {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    min-width: 0;
    height: 22px;
    width: 100%;
    padding: 0 var(--space-4);
    color: var(--text-secondary);
    border: 0;
    background: transparent;
    font: inherit;
    text-align: left;
  }
  .tree-row:hover,
  .tree-row.active {
    background: var(--surface-hover);
  }
  .tree-row.active {
    color: var(--accent-active);
  }
  .expander {
    display: inline-flex;
    flex: none;
    width: 16px;
    height: 20px;
    align-items: center;
    justify-content: center;
    border: 0;
    background: transparent;
    color: inherit;
    padding: 0;
  }
  .folder-action {
    display: flex;
    flex: 1;
    min-width: 0;
    height: 22px;
    align-items: center;
    gap: var(--space-4);
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    padding: 0;
  }
  .tree-row button:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
  .folder-error {
    padding: var(--space-4) var(--space-8);
    color: var(--text-secondary);
  }
  .folder-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--text-primary);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status {
    flex: none;
    max-width: 50%;
    overflow: hidden;
    font-size: var(--font-size-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status.attention {
    color: var(--danger);
  }
  .library-menu-button:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
  @media (max-width: 600px) {
    .libraries-pane {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      width: min(var(--libraries-pane-width), 100%);
      z-index: var(--z-popover);
      box-shadow: var(--shadow-overlay);
    }
  }
</style>
