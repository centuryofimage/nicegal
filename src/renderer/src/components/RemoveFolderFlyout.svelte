<!--
  @component
  Confirms removing a folder from a library, opened where its context menu was so the choice
  continues the gesture instead of jumping to a centered dialog.
-->
<script lang="ts">
  import type { Attachment } from "svelte/attachments";

  import { errorMessage } from "../lib/errors";
  import { popoverDismiss } from "../lib/popover-dismiss";

  let {
    name,
    x,
    y,
    onremove,
    onclose,
  }: {
    name: string;
    /** Viewport point the flyout opens from, kept inside the window. */
    x: number;
    y: number;
    onremove: (deleteIndexedData: boolean) => Promise<void>;
    onclose: () => void;
  } = $props();

  const MARGIN = 8;
  let deleteIndexedData = $state(false);
  let removing = $state(false);
  let error = $state("");

  /** Places the flyout at the point, flipped or shifted to stay in the window, then focuses it. */
  const place: Attachment<HTMLElement> = (element) => {
    const { width, height } = element.getBoundingClientRect();
    const left = x + width + MARGIN > innerWidth ? Math.max(MARGIN, x - width) : x;
    const top = y + height + MARGIN > innerHeight ? Math.max(MARGIN, y - height) : y;
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.querySelector<HTMLButtonElement>(".remove")?.focus();
  };

  async function remove(): Promise<void> {
    removing = true;
    error = "";
    try {
      await onremove(deleteIndexedData);
      onclose();
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      removing = false;
    }
  }
</script>

<div
  class="remove-folder-flyout"
  role="alertdialog"
  aria-labelledby="remove-folder-title"
  aria-describedby="remove-folder-note"
  {@attach place}
  {@attach popoverDismiss(!removing, onclose)}
>
  <p id="remove-folder-title" class="title">Remove “{name}” from this library?</p>
  <p id="remove-folder-note">The files stay on disk.</p>
  <label
    ><input type="checkbox" bind:checked={deleteIndexedData} disabled={removing} />Also delete its
    thumbnails and search data</label
  >
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="actions">
    <button class="ui-button ui-button-primary remove" onclick={remove} disabled={removing}
      >Remove</button
    >
    <button class="ui-button" onclick={onclose} disabled={removing}>Cancel</button>
  </div>
</div>

<style>
  .remove-folder-flyout {
    position: fixed;
    z-index: var(--z-popover);
    display: grid;
    gap: var(--space-4);
    width: max-content;
    max-width: min(300px, calc(100vw - 16px));
    padding: var(--space-6);
    border: 1px solid var(--border);
    background: var(--surface-0);
    box-shadow: var(--shadow-overlay);
    color: var(--text-primary);
    font-size: var(--font-size-md);
  }
  p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .title {
    font-weight: var(--font-weight-semibold);
  }
  label {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
  }
  input {
    margin: 2px 0 0;
  }
  .error {
    color: var(--danger);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
    margin-top: var(--space-2);
  }
</style>
