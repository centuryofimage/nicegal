<script lang="ts">
  import type { Snippet } from "svelte";

  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import GitCompareArrows from "@lucide/svelte/icons/git-compare-arrows";
  import Settings from "@lucide/svelte/icons/settings";

  import type { LibraryViewController } from "../lib/library-view.svelte";
  import type ModelComparison from "./ModelComparison.svelte";

  import { useApplication } from "../lib/application.svelte";
  import { errorMessage } from "../lib/errors";
  import { parseQuery, withMediaFilter, type MediaFilter } from "../lib/search-query";
  import { settings } from "../lib/settings.svelte";
  import { addDroppedVisualFiles, chooseVisualFile } from "../lib/visual-search-input";
  import JobIndicator from "./JobIndicator.svelte";
  import Modal from "./Modal.svelte";
  import SearchBar from "./SearchBar.svelte";
  import SearchOptions from "./SearchOptions.svelte";
  import ViewControls from "./ViewControls.svelte";

  let {
    view,
    onsection,
    start,
  }: {
    view: LibraryViewController;
    onsection: (key: string) => void;
    /** Controls at the start of the actions row. */
    start?: Snippet;
  } = $props();
  const {
    services: { catalog, ocrSearch, jobs, orchestrator },
    commands,
  } = useApplication();

  let searchBar = $state<SearchBar>();
  let comparisonOpen = $state(false);
  let comparison = $state<ModelComparison>();
  export function focusSearch(): void {
    searchBar?.focus();
  }

  function addSelectedImages(): void {
    ocrSearch.addLibraryReferences(
      catalog.items
        .filter((item) => view.gallerySelection.ids.has(item.id))
        .map((item) => ({ id: item.id, displayName: item.displayName })),
    );
  }
  function dropImages(files: File[]): void {
    void addDroppedVisualFiles(ocrSearch, files).catch((error: unknown) => {
      ocrSearch.error = errorMessage(error);
    });
  }
  const mediaFilter = $derived(parseQuery(ocrSearch.query).media);
  function chooseMedia(value: MediaFilter | null): void {
    ocrSearch.query = withMediaFilter(ocrSearch.query, value);
  }
</script>

{#if !view.detailItem}
  <div class="search-row app-toolbar">
    <SearchBar
      bind:this={searchBar}
      bind:value={ocrSearch.query}
      bind:composerOpen={ocrSearch.composerOpen}
      message={ocrSearch.queryHint || (ocrSearch.allMode ? ocrSearch.allError : ocrSearch.error)}
      querySyntaxError={!ocrSearch.queryHint && !ocrSearch.allMode && ocrSearch.querySyntaxError}
      setupNotice={ocrSearch.setupMessage}
      limitNotice={ocrSearch.limitNotice}
      semanticSuggestion={ocrSearch.shouldSuggestSemantic}
      onsemanticsearch={view.switchToMeaningSearch}
      onopenlibrarymanager={() =>
        catalog.selectedId !== null && view.editLibrary(catalog.selectedId)}
      onopensearchsettings={() => view.openSettingsDialog("search")}
      visualReferences={ocrSearch.visualReferences}
      onvisualreferenceschange={(references) => ocrSearch.setVisualReferences(references)}
      onchoosevisualfile={() => void chooseVisualFile(ocrSearch)}
      selectedPhotoCount={view.gallerySelection.count}
      onaddlibraryvisual={addSelectedImages}
      ondropvisualfiles={dropImages}
    />
    <div class="toolbar-actions">
      {#if start}<div class="toolbar-start">{@render start()}</div>{/if}
      {#if orchestrator.restartingIndex}
        <span role="status">Switching to OpenVINO…</span>
        <button class="ui-button" onclick={() => orchestrator.cancel()}>Stop indexing</button>
      {:else if jobs.active}
        <JobIndicator
          job={jobs.active}
          running={view.jobRunning}
          oncancel={() => orchestrator.cancel()}
          ondismiss={commands.dismissJobResult}
        />
      {/if}
      <ViewControls
        ranked={view.rankedView}
        {mediaFilter}
        onmediachange={chooseMedia}
        bind:layoutMode={$settings.layoutMode}
        bind:sortField={$settings.sortField}
        bind:dateHeaders={$settings.dateHeaders}
      />
      <button
        class="app-toolbar-button app-toolbar-text-button"
        class:active={view.activeDialog === "manageLibraries"}
        onclick={view.openManageLibraries}
        title="Library manager"
        aria-label="Library manager"
        aria-haspopup="dialog"
        aria-expanded={view.activeDialog === "manageLibraries"}
      >
        <FolderOpen size={13} aria-hidden="true" />
        <span>Library manager</span>
      </button>
      <button
        class="app-toolbar-button app-toolbar-text-button"
        class:active={view.activeDialog === "settings"}
        onclick={() => view.openSettingsDialog()}
        title="Settings"
        aria-label="Settings"
        aria-haspopup="dialog"
        aria-expanded={view.activeDialog === "settings"}
      >
        <Settings size={13} aria-hidden="true" />
        <span>Settings</span>
      </button>
      {#if import.meta.env.DEV}
        <button
          class="app-toolbar-button app-toolbar-text-button"
          onclick={() => (comparisonOpen = true)}
          disabled={catalog.selectedId === null}
          title="Compare models"
          aria-label="Compare models"
          aria-haspopup="dialog"
        >
          <GitCompareArrows size={13} aria-hidden="true" />
          <span>Compare models</span>
        </button>
      {/if}
    </div>
  </div>
  {#if ocrSearch.rankable}
    <SearchOptions
      bind:sortMode={ocrSearch.sortMode}
      bind:minMatchPercentile={ocrSearch.minMatchPercentile}
      showSlider={ocrSearch.sliderApplicable}
      sliderDisabled={ocrSearch.sliderDisabled}
      shownCount={view.filteredItems.length}
      matchTotal={view.searchView.matchTotal}
      truncated={false}
      sliderLabel={ocrSearch.sliderLabel}
      sections={view.searchView.sections}
      {onsection}
    />
  {/if}
{/if}

{#if import.meta.env.DEV && comparisonOpen}
  <Modal
    labelledby="model-comparison-title"
    onclose={() => comparison?.requestClose()}
    --modal-width="1100px"
  >
    {#await import("./ModelComparison.svelte") then { default: ModelComparison }}
      <ModelComparison bind:this={comparison} onclose={() => (comparisonOpen = false)} />
    {/await}
  </Modal>
{/if}

<style>
  /* Actions share the search row until the field would drop below its minimum width, then wrap
     together onto a second row, still right-aligned. */
  .search-row {
    flex-wrap: wrap;
    align-items: flex-start;
  }
  .search-row :global(.search-bar) {
    flex: 1 1 320px;
  }
  .toolbar-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: flex-start;
    gap: var(--space-6);
    margin-left: auto;
  }
  .toolbar-start {
    margin-right: auto;
  }
  /* Phones: search on the first row, actions spanning the second. */
  @media (max-width: 600px) {
    .search-row :global(.search-bar) {
      flex-basis: 100%;
    }
    .toolbar-actions {
      flex: 1;
    }
  }
</style>
