<script lang="ts">
  import CircleArrowUp from "@lucide/svelte/icons/circle-arrow-up";

  import type { UpdateStatus } from "../../../shared/updates";

  import { m } from "../../../shared/paraglide/messages.js";

  let { status, onopen }: { status: UpdateStatus; onopen: () => void } = $props();
</script>

{#if status.phase === "downloading"}
  <span class="update-status update-download" role="status" aria-live="polite">
    <CircleArrowUp size={13} aria-hidden="true" />{m.update_status_downloading()}
  </span>
{:else if status.phase === "ready" || status.phase === "available"}
  <span class="update-status" role="status">
    <button
      onclick={onopen}
      title={status.phase === "ready"
        ? m.update_status_ready_tooltip({ version: status.version })
        : m.update_status_available_tooltip({ version: status.version })}
    >
      <CircleArrowUp size={13} aria-hidden="true" />{status.phase === "ready"
        ? m.update_status_ready()
        : m.common_update_available()}
    </button>
  </span>
{/if}

<style>
  .update-status {
    display: flex;
    flex: none;
    align-self: stretch;
    margin-right: var(--space-8);
    border-right: 1px solid var(--border-subtle);
  }

  .update-download {
    align-items: center;
    gap: var(--space-4);
    padding: 0 var(--space-10);
    color: var(--text-secondary);
    white-space: nowrap;
  }

  button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-4);
    padding: 0 var(--space-10);
    border: 0;
    background: var(--update-ready-background);
    color: var(--update-ready-text);
    font: inherit;
    cursor: pointer;
    white-space: nowrap;
  }

  button:hover {
    background: var(--update-ready-hover);
  }

  button:focus-visible {
    outline: 1px dotted var(--update-ready-text);
    outline-offset: -2px;
  }
</style>
