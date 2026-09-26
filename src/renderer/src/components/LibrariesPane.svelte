<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Folder from "@lucide/svelte/icons/folder";
  import Folders from "@lucide/svelte/icons/folders";
  import { tick } from "svelte";

  import type { FolderEntry, LibraryId } from "../../../shared/backend";

  import { useApplication } from "../lib/application.svelte";
  import {
    buildFolderTree,
    formatFolderDate,
    isInside,
    visibleFolderRows,
    type FolderRow,
  } from "../lib/folder-tree";
  import { folderStatus, libraryOptionsSummary } from "../lib/library-status";
  import { popoverDismiss } from "../lib/popover-dismiss";
  import { parseQuery, withFolder } from "../lib/search-query";
  import {
    settings,
    settingsDefaults,
    settingsLimits,
    type FolderSort,
  } from "../lib/settings.svelte";
  import SegmentedControl from "./SegmentedControl.svelte";

  let {
    hidden = false,
    onselect,
    onmanage,
    onscan,
  }: {
    /** Kept mounted but out of the layout, e.g. while the image viewer is open. */
    hidden?: boolean;
    onselect: (libraryId: LibraryId) => void;
    onmanage: () => void;
    onscan: () => void;
  } = $props();

  const SORT_OPTIONS: ReadonlyArray<{ value: FolderSort; label: string; title: string }> = [
    { value: "name", label: "Name", title: "Sort folders by name" },
    { value: "newest", label: "Newest", title: "Most recently changed folders first" },
  ];
  /** The "All folders" row's place in the keyboard cursor, beside real folder paths. */
  const ALL = "";

  const { catalog, ocrSearch, jobs } = useApplication().services;
  const selected = $derived(catalog.selectedLibrary);
  const ready = $derived(catalog.backendStatus.ready);
  let menuOpen = $state(false);
  let folders = $state.raw<FolderEntry[]>([]);
  let folderError = $state("");
  let expanded = $state<Record<string, boolean>>({});
  let filter = $state("");
  let cursor = $state(ALL);
  let filterInput = $state<HTMLInputElement>();
  let treeElement = $state<HTMLElement>();
  const focused = $derived(parseQuery(ocrSearch.query).folder);
  const filtering = $derived(filter.trim() !== "");

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
      .then((entries) => {
        if (current) {
          folders = entries;
          folderError = "";
        }
      })
      .catch(() => {
        if (current) folderError = "Couldn't load folders.";
      });
    return () => {
      current = false;
    };
  });

  const roots = $derived(selected?.include.map((folder) => folder.path) ?? []);
  const imagePaths = $derived(
    catalog.items.filter((item) => item.mediaKind === "image").map((item) => item.path),
  );
  const tree = $derived(buildFolderTree(roots, folders, $settings.folderSort, imagePaths));
  const rows = $derived(visibleFolderRows(tree, expanded, focused, filter));
  /** Cursor order: the All folders row, then every visible folder. */
  const order = $derived([ALL, ...rows.map((row) => row.node.path)]);
  const cursorIndex = $derived(Math.max(0, order.indexOf(cursor)));

  function rowId(index: number): string {
    return `folder-row-${index}`;
  }

  function focus(path: string | null): void {
    ocrSearch.query = withFolder(ocrSearch.query, path);
  }

  function activate(path: string): void {
    cursor = path;
    focus(path === ALL ? null : path);
  }

  function setExpanded(row: FolderRow, open: boolean): void {
    if (filtering || !row.node.children.length) return;
    expanded = { ...expanded, [row.node.path]: open };
  }

  async function moveCursor(index: number): Promise<void> {
    cursor = order[Math.min(Math.max(index, 0), order.length - 1)];
    await tick();
    document.getElementById(rowId(cursorIndex))?.scrollIntoView({ block: "nearest" });
  }

  /** The row under a pointer event, by its position in the cursor order; -1 when between rows. */
  function rowAt(event: MouseEvent): number {
    const item = (event.target as Element).closest<HTMLElement>("[role=treeitem]");
    return item ? Number(item.dataset.index) : -1;
  }

  function onTreeClick(event: MouseEvent): void {
    const index = rowAt(event);
    if (index < 0) return;
    const row: FolderRow | undefined = rows[index - 1];
    if (row && (event.target as Element).closest(".expander")) {
      cursor = row.node.path;
      setExpanded(row, !row.expanded);
    } else activate(order[index]);
  }

  function onTreeDblclick(event: MouseEvent): void {
    const row: FolderRow | undefined = rows[rowAt(event) - 1];
    if (row && !(event.target as Element).closest(".expander")) setExpanded(row, !row.expanded);
  }

  function onTreeKeydown(event: KeyboardEvent): void {
    const row: FolderRow | undefined = rows[cursorIndex - 1];
    switch (event.key) {
      case "ArrowDown":
        void moveCursor(cursorIndex + 1);
        break;
      case "ArrowUp":
        void moveCursor(cursorIndex - 1);
        break;
      case "Home":
        void moveCursor(0);
        break;
      case "End":
        void moveCursor(order.length - 1);
        break;
      case "ArrowRight":
        if (!row?.node.children.length) break;
        if (row.expanded) void moveCursor(cursorIndex + 1);
        else setExpanded(row, true);
        break;
      case "ArrowLeft":
        if (!row) break;
        if (row.expanded && !filtering) setExpanded(row, false);
        else {
          let parent = cursorIndex - 1;
          while (parent > 0 && rows[parent - 1].depth >= row.depth) parent--;
          void moveCursor(parent);
        }
        break;
      case "Enter":
      case " ":
        activate(order[cursorIndex]);
        break;
      default:
        // Typing in the tree starts a filter, as type-to-find does in Explorer.
        if (event.key.length !== 1 || event.ctrlKey || event.altKey || event.metaKey) return;
        filter += event.key;
        filterInput?.focus();
    }
    event.preventDefault();
  }

  function onFilterKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && filter) clearFilter();
    else if (event.key === "ArrowDown" || event.key === "Enter") {
      const first = rows.find((row) => row.match);
      if (!first) return;
      if (event.key === "Enter") activate(first.node.path);
      else cursor = first.node.path;
      treeElement?.focus();
    } else return;
    event.preventDefault();
  }

  /** Leaves the filter with the chosen folder in view, reopening any branch hiding it. */
  function clearFilter(): void {
    filter = "";
    if (focused) {
      const reopened = { ...expanded };
      for (const path of Object.keys(reopened)) if (isInside(focused, path)) delete reopened[path];
      expanded = reopened;
      cursor = focused;
    }
    void moveCursor(order.indexOf(cursor));
  }

  const WIDTH = settingsLimits.librariesPaneWidth;
  /** Width while the edge is dragged; saved to settings once, when the drag ends. */
  let dragWidth = $state<number | null>(null);
  let dragStart: { x: number; width: number } | null = null;
  const width = $derived(dragWidth ?? $settings.librariesPaneWidth);

  function saveWidth(value: number): void {
    const librariesPaneWidth = Math.round(Math.min(WIDTH.max, Math.max(WIDTH.min, value)));
    settings.update((current) => ({ ...current, librariesPaneWidth }));
  }

  function onSplitterPointerdown(event: PointerEvent): void {
    if (event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragStart = { x: event.clientX, width };
    event.preventDefault();
  }

  function onSplitterPointermove(event: PointerEvent): void {
    if (!dragStart) return;
    const next = dragStart.width + event.clientX - dragStart.x;
    dragWidth = Math.min(WIDTH.max, Math.max(WIDTH.min, next));
  }

  function onSplitterRelease(): void {
    if (dragWidth !== null) saveWidth(dragWidth);
    dragStart = null;
    dragWidth = null;
  }

  function onSplitterKeydown(event: KeyboardEvent): void {
    const next = {
      ArrowLeft: width - WIDTH.step,
      ArrowRight: width + WIDTH.step,
      Home: WIDTH.min,
      End: WIDTH.max,
    }[event.key];
    if (next === undefined) return;
    saveWidth(next);
    event.preventDefault();
  }

  function choose(action: () => void): void {
    menuOpen = false;
    action();
  }
</script>

<aside
  id="libraries-pane"
  class="libraries-pane"
  aria-label="Libraries"
  {hidden}
  style:--libraries-pane-width={`${width}px`}
>
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

  {#if selected}
    <div class="folder-tools">
      <input
        bind:this={filterInput}
        bind:value={filter}
        class="folder-filter"
        type="search"
        placeholder="Filter"
        aria-label="Filter folders"
        spellcheck="false"
        onkeydown={onFilterKeydown}
      />
      <SegmentedControl
        bind:value={
          () => $settings.folderSort,
          (folderSort) => settings.update((value) => ({ ...value, folderSort }))
        }
        options={SORT_OPTIONS}
        label="Sort folders"
        --segment-height="var(--tree-row-height)"
      />
    </div>
  {/if}

  <div
    bind:this={treeElement}
    class="folders themed-scrollbar"
    role="tree"
    aria-label="Folders"
    tabindex="0"
    aria-activedescendant={selected ? rowId(cursorIndex) : undefined}
    onkeydown={onTreeKeydown}
    onclick={onTreeClick}
    ondblclick={onTreeDblclick}
  >
    {#if selected}
      <div
        id={rowId(0)}
        class={["tree-row", { selected: focused === null, cursor: cursorIndex === 0 }]}
        role="treeitem"
        aria-level={1}
        aria-selected={focused === null}
        tabindex="-1"
        data-index={0}
      >
        <span class="expander"></span>
        <span class="root-icon"><Folders size={14} aria-hidden="true" /></span>
        <span class="folder-name">All folders</span>
      </div>
      {#each rows as row, index (row.node.path)}
        {@const root = selected.include.find((folder) => folder.path === row.node.path)}
        {@const status = root ? folderStatus(root) : null}
        <div
          id={rowId(index + 1)}
          class={[
            "tree-row",
            {
              selected: focused === row.node.path,
              cursor: cursorIndex === index + 1,
              context: filtering && !row.match,
            },
          ]}
          style:--depth={row.depth}
          role="treeitem"
          aria-level={row.depth + 2}
          aria-expanded={row.node.children.length ? row.expanded : undefined}
          aria-selected={focused === row.node.path}
          tabindex="-1"
          title={[row.node.path, status?.detail].filter(Boolean).join("\n")}
          data-index={index + 1}
          >
          <span class="expander" aria-hidden="true">
            {#if !row.node.children.length}
              <span class="leaf"></span>
            {:else if row.expanded}
              <svg width="9" height="9" viewBox="0 0 9 9"
                ><path d="M7.5 2v5.5H2z" fill="currentColor" /></svg
              >
            {:else}
              <svg width="9" height="9" viewBox="0 0 9 9"
                ><path d="M2.5 1.5 6.5 4.5l-4 3z" fill="none" stroke="currentColor" /></svg
              >
            {/if}
          </span>
          {#if root}<span class="root-icon"><Folder size={14} aria-hidden="true" /></span>{/if}
          <span class="folder-name"
            >{#if row.match}{row.node.name.slice(0, row.match.start)}<mark
                >{row.node.name.slice(row.match.start, row.match.end)}</mark
              >{row.node.name.slice(row.match.end)}{:else}{row.node.name}{/if}</span
          >
          {#if status?.text}
            <span class={["meta", status.tone]}>{status.text}</span>
          {:else if $settings.folderSort === "newest" && row.node.newestMs !== null}
            <span class="meta">{formatFolderDate(row.node.newestMs)}</span>
          {/if}
        </div>
      {/each}
      {#if filtering && !rows.length}
        <p class="folder-note" role="status">No folders match.</p>
      {/if}
      {#if jobs.scanState(selected.id) && folders.length <= selected.include.length}
        <p class="folder-note" role="status">Discovering folders…</p>
      {/if}
      {#if folderError}<p class="folder-note" role="status">{folderError}</p>{/if}
    {:else if catalog.librariesLoaded}
      <p class="folder-note">
        {catalog.librariesError
          ? "Couldn't load libraries."
          : "Use Library manager to add a folder."}
      </p>
    {/if}
  </div>
  <!-- A focusable separator is the ARIA window-splitter widget; Svelte treats the role as static. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class={["splitter", { dragging: dragWidth !== null }]}
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize libraries pane"
    aria-valuenow={width}
    aria-valuemin={WIDTH.min}
    aria-valuemax={WIDTH.max}
    tabindex="0"
    title="Drag to resize. Double-click to reset."
    onpointerdown={onSplitterPointerdown}
    onpointermove={onSplitterPointermove}
    onlostpointercapture={onSplitterRelease}
    ondblclick={() => saveWidth(settingsDefaults.librariesPaneWidth)}
    onkeydown={onSplitterKeydown}
  ></div>
</aside>

<style>
  .libraries-pane[hidden] {
    display: none;
  }
  .libraries-pane {
    position: relative;
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
  .folder-tools {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
  }
  .folder-filter {
    flex: 1;
    min-width: 0;
    height: var(--tree-row-height);
    padding: 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: var(--text-primary);
    font: inherit;
  }
  .folder-filter::placeholder {
    color: var(--text-tertiary);
  }
  .folder-filter:focus {
    border-color: var(--btn-border-hover);
    outline: none;
  }
  .folders {
    flex: 1;
    min-height: 0;
    overflow: auto;
    margin: 0;
    padding: var(--space-2) var(--space-2);
    outline: none;
  }
  .tree-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
    height: var(--tree-row-height);
    padding: 0 var(--space-3) 0 calc(var(--space-1) + var(--depth, 0) * var(--tree-indent));
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    cursor: default;
  }
  .tree-row:hover {
    border-color: var(--tree-hover-border);
    background: var(--tree-hover-face);
  }
  .tree-row.selected {
    border-color: var(--tree-selected-border);
    background: var(--tree-selected-face);
  }
  /* Keyboard position, shown only while the tree has focus: an edge on an unselected row, the
     dotted focus rectangle inside a selected one. */
  .folders:focus .tree-row.cursor:not(.selected) {
    border-color: var(--tree-cursor-border);
  }
  .folders:focus-visible .tree-row.cursor {
    outline: var(--focus-ring);
    outline-offset: -3px;
  }
  .tree-row.context {
    color: var(--text-tertiary);
  }
  .expander {
    display: inline-flex;
    flex: none;
    width: 11px;
    height: 100%;
    align-items: center;
    justify-content: center;
    color: var(--tree-glyph);
  }
  .tree-row[aria-expanded="true"] .expander {
    color: var(--tree-glyph-open);
  }
  .tree-row[aria-expanded] .expander:hover {
    color: var(--tree-glyph-hover);
  }
  .leaf {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--tree-leaf);
  }
  .root-icon {
    display: inline-flex;
    flex: none;
    color: var(--tree-root-icon);
  }
  .root-icon :global(svg) {
    fill: var(--tree-root-icon-fill);
  }
  .folder-note {
    margin: 0;
    padding: var(--space-4) var(--space-6);
    color: var(--text-secondary);
  }
  .folder-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  mark {
    background: var(--search-highlight-bg);
    color: var(--search-highlight-fg);
  }
  .meta {
    flex: none;
    max-width: 50%;
    overflow: hidden;
    color: var(--text-tertiary);
    font-size: var(--font-size-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta.attention {
    color: var(--danger);
  }
  .library-menu-button:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
  /* Win32 splitters are invisible until used: a few pixels straddling the pane's edge. */
  .splitter {
    position: absolute;
    top: 0;
    right: -3px;
    bottom: 0;
    z-index: var(--z-raised);
    width: 6px;
    cursor: col-resize;
    touch-action: none;
  }
  .splitter.dragging {
    background: linear-gradient(
      to right,
      transparent 2px,
      var(--border-strong) 2px,
      var(--border-strong) 4px,
      transparent 4px
    );
  }
  .splitter:focus-visible {
    outline: var(--focus-ring);
    outline-offset: -1px;
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
