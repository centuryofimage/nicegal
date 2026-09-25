<script lang="ts">
  import Modal from "./Modal.svelte";

  let {
    version,
    installReady,
    onclose,
    onnotes,
    onrestart,
  }: {
    version: string | null;
    installReady: boolean;
    onclose: () => void;
    onnotes: () => Promise<void>;
    onrestart: () => Promise<void>;
  } = $props();

  let restarting = $state(false);
  let error = $state<string | null>(null);

  async function openNotes(): Promise<void> {
    error = null;
    try {
      await onnotes();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function restart(): Promise<void> {
    error = null;
    restarting = true;
    try {
      await onrestart();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      restarting = false;
    }
  }
</script>

<Modal labelledby="update-dialog-title" describedby="update-dialog-description" {onclose}>
  <section class="update-dialog">
    <h1 id="update-dialog-title">Update available</h1>
    <p id="update-dialog-description">
      {#if installReady}
        Nicegal{version ? ` ${version}` : ""} is ready to install. Restart now, or keep working and install
        it when you quit.
      {:else}
        Nicegal{version ? ` ${version}` : ""} is available. Open its release page to download and install
        it manually.
      {/if}
    </p>
    {#if error}<p class="update-error" role="alert">{error}</p>{/if}
    <footer>
      <button class="ui-button ui-button-compact" onclick={openNotes} disabled={restarting}
        >{installReady ? "Release notes" : "Open release page"}</button
      >
      <button class="ui-button ui-button-compact" onclick={onclose} disabled={restarting}
        >Later</button
      >
      {#if installReady}
        <button
          class="ui-button ui-button-compact ui-button-primary"
          onclick={restart}
          disabled={restarting}
        >
          {restarting ? "Restarting…" : "Restart and install"}
        </button>
      {/if}
    </footer>
  </section>
</Modal>

<style>
  .update-dialog {
    box-sizing: border-box;
    width: min(410px, 100%);
    padding: var(--space-16);
    border: 1px solid var(--border-strong);
    background: var(--surface-0);
    color: var(--text-primary);
    box-shadow: var(--shadow-overlay);
  }

  h1,
  p {
    margin: 0;
  }

  h1 {
    font-size: var(--dialog-title-size);
  }

  p {
    margin-top: var(--space-10);
    line-height: var(--line-height-normal);
  }

  .update-error {
    color: var(--danger);
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-5);
    margin-top: var(--space-16);
  }
</style>
