<script lang="ts">
  import type { ThumbnailFailure } from "../lib/gallery/thumbnail-scheduler";
  import type { LibraryViewController } from "../lib/library-view.svelte";

  import { useApplication } from "../lib/application.svelte";
  import GettingStarted from "./GettingStarted.svelte";
  import LibrariesManager from "./LibrariesManager.svelte";
  import Modal from "./Modal.svelte";
  import SearchProblemDialog from "./SearchProblemDialog.svelte";
  import SettingsPanel from "./SettingsPanel.svelte";

  let {
    view,
    thumbnailFailures,
    onretrythumbnails,
  }: {
    view: LibraryViewController;
    thumbnailFailures: readonly (ThumbnailFailure & { name?: string })[];
    onretrythumbnails: () => void;
  } = $props();
  const application = useApplication();
  const { runtime, catalog } = application.services;
  const commands = application.commands;
  let manager = $state.raw<LibrariesManager>();
</script>

{#if application.welcomeVisible}
  <Modal
    labelledby="welcome-splash-title"
    describedby="welcome-splash-description"
    onclose={commands.dismissWelcome}
    --modal-width="640px"
  >
    <GettingStarted onclose={commands.dismissWelcome} onadd={view.startWelcomeLibraryPicker} />
  </Modal>
{/if}

{#if view.activeDialog === "manageLibraries"}
  <Modal labelledby="libraries-manager-title" onclose={() => manager?.requestClose()} --modal-width="920px">
    <LibrariesManager
      bind:this={manager}
      {view}
      onclose={view.closeDialog}
      {thumbnailFailures}
      {onretrythumbnails}
    />
  </Modal>
{:else if view.activeDialog === "settings"}
  <Modal labelledby="settings-title" onclose={view.closeDialog}>
    <div class="settings-dialog">
      <SettingsPanel
        {runtime}
        bind:page={view.settingsPage}
        onclose={view.closeDialog}
        onmanagelibraries={view.openManageLibraries}
        onshowintro={() => {
          view.closeDialog();
          commands.showWelcome();
        }}
      />
    </div>
  </Modal>
{:else if view.activeDialog === "searchProblem" && view.searchProblem}
  <SearchProblemDialog
    issue={view.searchProblem}
    canRescan={catalog.selectedId !== null && catalog.backendStatus.ready}
    onrescan={() => {
      if (catalog.selectedId !== null) commands.scanLibrary(catalog.selectedId);
      view.closeDialog();
    }}
    onsettings={() => view.openSettingsDialog("search")}
    onretry={() => {
      void runtime.refreshModels();
      view.closeDialog();
    }}
    onclose={view.closeDialog}
  />
{/if}

<style>
  .settings-dialog {
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    max-height: min(var(--dialog-max-height), calc(100vh - var(--space-16) * 2));
    overflow: hidden;
    border: 1px solid var(--border-strong);
    background: var(--surface-0);
    box-shadow: var(--shadow-overlay);
  }
</style>
