<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    labelledby,
    describedby,
    onclose,
    children,
  }: {
    labelledby: string;
    describedby?: string;
    onclose: () => void;
    children: Snippet;
  } = $props();

  let backdropPress = false;

  function present(dialog: HTMLDialogElement): () => void {
    const previousFocus = document.activeElement;
    // Native dialog focusing selects autofocus / the first interactive control and restores
    // focus on close. Do not turn the heading into a keyboard focus target.
    dialog.showModal();
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }

  function isBackdrop(event: MouseEvent): boolean {
    const dialog = event.currentTarget as HTMLDialogElement;
    const bounds = dialog.getBoundingClientRect();
    return (
      event.target === dialog &&
      (event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom)
    );
  }

  function cancel(event: Event): void {
    event.preventDefault();
    onclose();
  }
</script>

<dialog
  class="modal"
  aria-labelledby={labelledby}
  aria-describedby={describedby}
  {@attach present}
  oncancel={cancel}
  onkeydown={(event) => {
    // Descendant confirmations may consume Escape first. Otherwise native cancel owns it,
    // and it must not also close a detail view or clear the gallery's selection.
    if (event.key === "Escape") event.stopPropagation();
  }}
  onpointerdown={(event) => (backdropPress = isBackdrop(event))}
  onpointercancel={() => (backdropPress = false)}
  onclick={(event) => {
    if (backdropPress && isBackdrop(event)) onclose();
    backdropPress = false;
  }}
>
  {@render children()}
</dialog>

<style>
  /* A narrower panel must remain centered inside the shared dialog shell. */
  .modal[open] {
    display: grid;
    justify-items: center;
  }

  .modal {
    box-sizing: border-box;
    width: min(var(--modal-width, var(--dialog-width)), calc(100% - 2 * var(--space-16)));
    max-width: none;
    max-height: calc(100% - 2 * var(--space-16));
    margin: auto;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-primary);
    overflow: auto;
  }

  .modal::backdrop {
    background: var(--dialog-backdrop);
  }
</style>
