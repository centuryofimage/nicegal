<script lang="ts">
  import { onMount, type Snippet } from "svelte";

  import type { UpdateStatus as UpdateState } from "../../../shared/updates";

  import UpdateAvailableDialog from "./UpdateAvailableDialog.svelte";
  import UpdateStatus from "./UpdateStatus.svelte";

  let update = $state<UpdateState>({ phase: "disabled", version: null });
  let showingUpdateDialog = $state(false);
  function receiveUpdateStatus(status: UpdateState): void {
    update = status;
    if (status.phase !== "ready" && status.phase !== "available") showingUpdateDialog = false;
  }
  onMount(() => {
    // Subscribe before reading the snapshot; an intervening event is newer than that read.
    let receivedEvent = false;
    let disposed = false;
    const unsubscribe = window.nicegal.updates.onStatusChanged((status) => {
      receivedEvent = true;
      receiveUpdateStatus(status);
    });
    void window.nicegal.updates
      .getStatus()
      .then((status) => {
        if (!disposed && !receivedEvent) receiveUpdateStatus(status);
      })
      .catch((error: unknown) => console.error("Could not read update status", error));
    return () => {
      disposed = true;
      unsubscribe();
    };
  });

  let {
    theme,
    toolbar,
    workspace,
    status,
    modals,
  }: {
    theme: string;
    toolbar?: Snippet;
    workspace: Snippet;
    status: Snippet;
    modals?: Snippet;
  } = $props();
</script>

<main data-theme={theme}>
  {#if toolbar}
    <header class="shell-toolbar">
      {@render toolbar()}
    </header>
  {/if}
  <section class="shell-workspace">
    {@render workspace()}
  </section>
  <footer class="status-bar">
    <UpdateStatus status={update} onopen={() => (showingUpdateDialog = true)} />
    {@render status()}
  </footer>
</main>

{#if modals}
  <div class="modal-layer" data-theme={theme}>
    {@render modals()}
  </div>
{/if}

{#if showingUpdateDialog && (update.phase === "ready" || update.phase === "available")}
  <div class="modal-layer update-modal-layer" data-theme={theme}>
    <UpdateAvailableDialog
      version={update.version}
      installReady={update.phase === "ready"}
      onclose={() => (showingUpdateDialog = false)}
      onnotes={() => window.nicegal.updates.openReleaseNotes()}
      onrestart={() => window.nicegal.updates.restartAndInstall()}
    />
  </div>
{/if}

<style>
  main {
    display: flex;
    height: 100%;
    flex-direction: column;
    background: var(--surface-0);
  }

  .shell-toolbar,
  .shell-workspace {
    display: contents;
  }

  .status-bar {
    display: flex;
    height: var(--statusbar-height);
    flex: none;
    align-items: center;
    padding: 0 var(--space-4);
    border-top: 1px solid var(--border-subtle);
    background: var(--surface-1);
    color: var(--text-tertiary);
    font-size: var(--font-size-sm);
  }

  .status-bar:has(:global(.update-status)) {
    padding-left: 0;
  }

  .status-bar :global(.status-segment) {
    overflow: hidden;
    padding-right: var(--space-8);
    margin-right: var(--space-8);
    border-right: 1px solid var(--border-subtle);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-bar :global(.status-segment:last-child) {
    border-right: 0;
  }

  .modal-layer {
    display: contents;
  }

  .update-modal-layer {
    --modal-width: 410px;
  }
</style>
