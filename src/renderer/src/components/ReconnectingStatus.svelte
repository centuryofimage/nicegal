<script lang="ts">
  import { onMount } from "svelte";

  import { m } from "../../../shared/paraglide/messages.js";
  import ActivitySpinner from "./ActivitySpinner.svelte";

  let reconnecting = $state(false);

  onMount(() => window.nicegal.connection.onReconnectingChanged((value) => (reconnecting = value)));
</script>

<!-- A remote browser that lost the PC, e.g. after the phone woke up. The gallery stays usable. -->
{#if reconnecting}
  <span class="status-segment reconnecting" role="status" title={m.reconnecting_status_title()}>
    <ActivitySpinner />{m.reconnecting_status_label()}
  </span>
{/if}

<style>
  .reconnecting {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: var(--space-4);
    color: var(--text-secondary);
  }
</style>
