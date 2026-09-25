<script lang="ts">
  import PanelLeft from "@lucide/svelte/icons/panel-left";
  import PanelRight from "@lucide/svelte/icons/panel-right";
  import { onDestroy } from "svelte";

  import AppMessage from "./components/AppMessage.svelte";
  import AppShell from "./components/AppShell.svelte";
  import BackendFailureMessage from "./components/BackendFailureMessage.svelte";
  import DetailView from "./components/DetailView.svelte";
  import GalleryDialogs from "./components/GalleryDialogs.svelte";
  import GallerySizeSlider from "./components/GallerySizeSlider.svelte";
  import GalleryToolbar from "./components/GalleryToolbar.svelte";
  import LibrariesPane from "./components/LibrariesPane.svelte";
  import MetadataPanel from "./components/MetadataPanel.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import TimelineScrollbar from "./components/TimelineScrollbar.svelte";
  import VirtualGallery from "./components/VirtualGallery.svelte";
  import { useApplication } from "./lib/application.svelte";
  import { offlineFolders } from "./lib/library-status";
  import { createGalleryShortcutHandler } from "./lib/gallery-shortcuts";
  import { originalUrlOf } from "./lib/gallery/types";
  import { createGalleryWheelZoom } from "./lib/gallery/wheel-zoom";
  import { createLibraryViewController } from "./lib/library-view.svelte";
  import { galleryLayoutState, settings } from "./lib/settings.svelte";

  const application = useApplication();
  const commands = application.commands;
  const { catalog, runtime, ocrSearch, jobs } = application.services;
  // Offline folders would leave blank tiles, so the whole gallery explains them instead.
  const offline = $derived(offlineFolders(catalog.selectedLibrary));
  let infoOpen = $state(false);
  let infoButton: HTMLButtonElement;
  function toggleInfo(): void {
    if (infoOpen) closeInfo();
    else infoOpen = true;
  }
  function closeInfo(): void {
    infoOpen = false;
    infoButton?.focus();
  }
  let gallery = $state<VirtualGallery>();
  let initialVideoPlayback = $state<{ id: string; currentTime: number; muted: boolean } | null>(
    null,
  );
  let toolbarControls = $state<GalleryToolbar>();
  const thumbnailFailures = $derived(gallery?.getThumbnailFailures(catalog.items) ?? []);
  let settingsPage = $state<"gallery" | "search" | "about">("gallery");
  const view = createLibraryViewController(application, (y) => gallery?.scrollTo(y));
  const inspectedAsset = $derived(
    view.detailItem ??
      (view.gallerySelection.count === 1
        ? (catalog.items.find((item) => view.gallerySelection.ids.has(item.id)) ?? null)
        : null),
  );

  function observeGallery(element: HTMLDivElement): () => void {
    const observer = new ResizeObserver(([entry]) => {
      view.galleryScroll.height = entry.contentRect.height;
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }
  const galleryWheelZoom = createGalleryWheelZoom(() =>
    Boolean(view.detailItem || view.activeDialog),
  );
  const handleKeydown = createGalleryShortcutHandler({
    focusSearch: () => toolbarControls?.focusSearch(),
    toggleInfo,
    closeInfo,
    dismissView: view.dismissSelectionOrDetail,
  });
  function openDetail(index: number): void {
    const item = view.filteredItems[index];
    // Visual-search results open from the beginning even if a hover preview was playing.
    const playback =
      item?.mediaKind === "video" && !ocrSearch.matchingFrameTimes.has(item.id)
        ? gallery?.captureVideoPlayback(item.id)
        : null;
    initialVideoPlayback = item && playback ? { id: item.id, ...playback } : null;
    view.openDetail(index);
  }
  onDestroy(() => view.dispose());
</script>

<svelte:window onkeydown={handleKeydown} />

{#snippet toolbar()}
  <GalleryToolbar
    bind:this={toolbarControls}
    {view}
    onsection={(key) => gallery?.scrollToSection(key)}
  />
{/snippet}

{#snippet workspace()}
  <div class="workspace-row">
    {#if view.librariesPaneOpen}
      <!-- Hidden, not unmounted, while viewing: the viewer then spans the window like the search
           toolbar does, and the tree keeps its filter, expansion and scroll for the return. -->
      <LibrariesPane
        hidden={Boolean(view.detailItem)}
        onselect={view.selectLibrary}
        onmanage={view.openManageLibraries}
        onscan={() => catalog.selectedId !== null && commands.scanLibrary(catalog.selectedId)}
      />
    {/if}
    <div class="content-row" {@attach observeGallery}>
      <div class="gallery-workspace" inert={Boolean(view.detailItem)} {@attach galleryWheelZoom}>
        <VirtualGallery
          bind:this={gallery}
          items={view.filteredItems}
          sections={view.searchView.sections}
          ontogglesection={view.toggleSection}
          viewKey={ocrSearch.sortMode}
          oninteractionchange={(active) => ocrSearch.setInteracting(active)}
          layoutOptions={view.galleryLayoutOptions}
          imagePoolSize={galleryLayoutState.imagePoolSize}
          playAnimatedPreviews={$settings.playAnimatedPreviews}
          previewSuspended={Boolean(view.detailItem)}
          snippets={ocrSearch.displaySnippets}
          matchTimes={ocrSearch.matchingFrameTimes}
          snippetQuery={ocrSearch.query}
          searchQuery={ocrSearch.query}
          selectedIds={view.gallerySelection.ids}
          hideNativeScrollbar
          onScroll={view.handleGalleryScroll}
          onselect={view.selectGalleryItem}
          onmarqueestart={view.beginGalleryMarquee}
          onmarqueechange={view.updateGalleryMarquee}
          onmarqueeend={view.endGalleryMarquee}
          onopen={openDetail}
          onfilemenu={view.openFileMenu}
          onfiledrag={view.startFileDrag}
          onclear={() => view.gallerySelection.clear()}
        /><TimelineScrollbar
          items={view.filteredItems}
          layout={view.galleryScroll.layout}
          scrollTop={view.galleryScroll.scrollTop}
          viewportHeight={view.galleryScroll.height}
          showTicks={!view.rankedView}
          onSeek={view.handleSeek}
        />
      </div>
      {#if !catalog.backendStatus.ready && !catalog.backendStatus.error}<AppMessage
          title="Starting gallery…"
          message="Opening your local catalog."
          placement="overlay"
          tone="neutral"
        />{:else if !catalog.backendStatus.ready && catalog.backendStatus.error}<BackendFailureMessage
          error={catalog.backendStatus.error}
        />{:else if catalog.loadError}<AppMessage
          title="Catalog read failed"
          guidance="The library could not be read. Check that its drive is connected and accessible, then retry."
          actionLabel="Retry"
          onaction={() => catalog.refresh()}
          message={catalog.loadError}
          placement="overlay"
        />{:else if offline.length}<AppMessage
          title={offline.length === 1 ? "Folder not connected" : "Folders not connected"}
          message={offline.map((folder) => folder.path).join(", ")}
          guidance="This library's photos can't be shown while its folders are unavailable. Connect the drive or restore the folder, then retry."
          actionLabel="Retry"
          onaction={() =>
            catalog.selectedId !== null &&
            commands.scanLibrary(catalog.selectedId, { pendingOnly: true })}
          placement="overlay"
        />{:else if catalog.librariesLoaded && catalog.selectedId === null}<AppMessage
          title="No library yet"
          message="Choose a folder of photos or videos to get started."
          placement="overlay"
          tone="neutral"
          actionLabel="Choose media folder…"
          onaction={view.addLibrary}
        />{:else if !catalog.loading && catalog.items.length === 0 && catalog.selectedLibrary}<AppMessage
          title="The catalog is empty."
          message={jobs.scanState(catalog.selectedLibrary.id)
            ? "Scanning this library's folders…"
            : "No photos or videos were found in this library's folders. Add a folder, or check its exclusions."}
          placement="overlay"
          tone="neutral"
          actionLabel="Edit library…"
          onaction={() => view.editLibrary(catalog.selectedLibrary!.id)}
        />{/if}
      {#if jobs.error && catalog.backendStatus.ready && !catalog.loadError}
        <AppMessage
          title="Job error"
          message={jobs.error}
          placement="overlay"
          actionLabel="Dismiss"
          onaction={() => jobs.dismiss()}
        />
      {:else if jobs.connectionError && catalog.backendStatus.ready}
        <AppMessage
          title="Progress updates interrupted"
          message={jobs.connectionError}
          guidance="The job may still be running. Nicegal is reconnecting; its last reported progress is retained."
          placement="overlay"
        />
      {/if}
      {#if view.detailItem}
        {#key originalUrlOf(view.detailItem)}
          <DetailView
            item={view.detailItem}
            initialPlayback={initialVideoPlayback?.id === view.detailItem.id
              ? initialVideoPlayback
              : null}
            hasPrev={view.detailIndex !== null && view.detailIndex > 0}
            hasNext={view.detailIndex !== null && view.detailIndex < view.filteredItems.length - 1}
            onclose={() => {
              initialVideoPlayback = null;
              view.closeDetail();
            }}
            onprev={() => {
              initialVideoPlayback = null;
              view.showPrevDetail();
            }}
            onnext={() => {
              initialVideoPlayback = null;
              view.showNextDetail();
            }}
            onstatuschange={(status) => (view.detailStatus = status)}
            onfilemenu={() => view.detailIndex !== null && view.openFileMenu(view.detailIndex)}
          />
        {/key}
      {/if}
    </div>
    {#if infoOpen}
      <MetadataPanel
        asset={inspectedAsset}
        selectedCount={view.gallerySelection.count}
        ready={catalog.backendStatus.ready}
        onclose={closeInfo}
      />
    {/if}
  </div>
{/snippet}

{#snippet status()}
  <button
    class="status-pane-toggle status-pane-toggle-start"
    aria-controls="libraries-pane"
    aria-pressed={view.librariesPaneOpen}
    disabled={Boolean(view.detailItem)}
    title="Show or hide libraries"
    onclick={view.toggleLibrariesPane}
  >
    <PanelLeft size={13} aria-hidden="true" /><span>Libraries</span>
  </button>
  <div class="status-details">
    {#if !view.detailItem}
      <StatusBar
        libraryName={view.libraryName}
        libraryTitle={catalog.selectedLibrary?.include.map((folder) => folder.path).join("\n") ??
          ""}
        hasLibrary={catalog.selectedId !== null}
        matchedCount={view.searchView.matchTotal}
        totalCount={catalog.items.length}
        filtering={view.searchView.filtering}
        searching={ocrSearch.pending}
        selectedCount={view.gallerySelection.count}
        status={catalog.selectedStatus}
        job={jobs.active}
        message={view.statusMessage}
        backendReady={catalog.backendStatus.ready}
        backendError={catalog.backendStatus.error}
        {runtime}
        onsettings={() => {
          settingsPage = "search";
          view.openSettingsDialog();
        }}
      />
    {:else}
      <span class="status-segment viewer-name" title={view.detailItem.displayName}>
        {view.detailStatus?.filename ?? view.detailItem.displayName}
      </span>
      {#if view.detailStatus?.width && view.detailStatus.height}
        <span class="status-segment viewer-meta">
          {view.detailStatus.width}×{view.detailStatus.height}
        </span>
      {/if}
      {#if view.detailStatus?.loading}
        <span class="status-segment viewer-meta" role="status">Loading…</span>
      {:else if view.detailStatus?.failed}
        <span class="status-segment viewer-error" role="status">Load failed</span>
      {:else if view.detailStatus?.zoom}
        <span class="status-segment viewer-meta" aria-live="polite">{view.detailStatus.zoom}</span>
      {/if}
    {/if}
  </div>
  {#if !view.detailItem}<GallerySizeSlider />{/if}
  <button
    bind:this={infoButton}
    class="status-pane-toggle"
    aria-controls="metadata-panel"
    aria-pressed={infoOpen}
    title="Show or hide file info (I / Ctrl+I / Cmd+I)"
    onclick={toggleInfo}
  >
    <PanelRight size={13} aria-hidden="true" /><span>Info</span>
  </button>
{/snippet}

{#snippet modals()}
  <GalleryDialogs
    {view}
    bind:settingsPage
    {thumbnailFailures}
    onretrythumbnails={() =>
      gallery?.retryThumbnails(thumbnailFailures.map((failure) => failure.assetId))}
  />
{/snippet}

<AppShell theme={$settings.theme} {toolbar} {workspace} {status} {modals} />

<style>
  .status-details {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }
  .workspace-row {
    display: flex;
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .content-row {
    min-width: 0;
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .gallery-workspace {
    display: flex;
    min-width: 0;
    flex: 1;
  }
  .content-row :global(.gallery-viewport) {
    flex: 1;
    min-width: 0;
  }
</style>
