<script lang="ts">
  import { onMount } from "svelte";

  let { onopen }: { onopen: () => void } = $props();

  import { connectionLabel, type RemoteConnection } from "../../../shared/remote";

  let connected = $state.raw<RemoteConnection[]>([]);

  onMount(() => {
    let disposed = false;
    const unsubscribe = window.nicegal.remote.onStatusChanged(
      (status) => (connected = status.connected),
    );
    void window.nicegal.remote.getStatus().then(
      (status) => {
        if (!disposed) connected = status.connected;
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
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: radial-gradient(
      circle at 35% 35%,
      var(--status-connected-highlight) 0,
      var(--status-connected) 55%,
      var(--status-connected-edge) 100%
    );
    box-shadow: 0 0 2px 1px var(--status-connected-glow);
  }
</style>
