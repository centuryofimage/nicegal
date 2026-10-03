<script lang="ts">
  import { onMount } from "svelte";

  import { connectionLabel, type RemoteConnection } from "../../../shared/remote";

  let { onopen }: { onopen: () => void } = $props();
  let connected = $state.raw<RemoteConnection[]>([]);

  onMount(() => {
    // Subscribe before reading the snapshot; an intervening event is newer than that read.
    let receivedEvent = false;
    let disposed = false;
    const unsubscribe = window.nicegal.remote.onStatusChanged((status) => {
      receivedEvent = true;
      connected = status.connected;
    });
    void window.nicegal.remote.getStatus().then(
      (status) => {
        if (!disposed && !receivedEvent) connected = status.connected;
      },
      () => {},
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  });
</script>

<!-- Shown while a paired device has the gallery open, so remote use is never invisible. -->
{#if connected.length}
  <button
    class="status-pane-toggle remote-indicator"
    title={`Connected: ${connected.map(connectionLabel).join(", ")}. Open remote access settings.`}
    onclick={onopen}
  >
    <span class="dot" aria-hidden="true"></span><span
      >{connected.length === 1
        ? connectionLabel(connected[0])
        : `${connected.length} devices`}</span
    >
  </button>
{/if}

<style>
  /* Sits between the status details and the size slider, so it is ruled on both sides. */
  .remote-indicator {
    gap: var(--space-6);
    margin-right: var(--space-8);
    border-right-color: var(--border-subtle);
  }
  .dot {
    box-sizing: border-box;
    width: 7px;
    height: 7px;
    border: 1px solid var(--status-connected-edge);
    background: var(--status-connected);
  }
</style>
