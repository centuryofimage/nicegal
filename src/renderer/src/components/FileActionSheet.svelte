<script lang="ts">
  import Copy from "@lucide/svelte/icons/copy";
  import Download from "@lucide/svelte/icons/download";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import ImagePlus from "@lucide/svelte/icons/image-plus";
  import ScanSearch from "@lucide/svelte/icons/scan-search";
  import Share from "@lucide/svelte/icons/share";

  import type { GalleryItem } from "../lib/gallery/types";

  import { errorMessage } from "../lib/errors";
  import { originalUrlOf } from "../lib/gallery/types";

  let {
    items,
    onvisualsearch,
    onclose,
  }: {
    /** First the item that was pressed, then the rest of the selection. */
    items: readonly GalleryItem[];
    onvisualsearch: (replace: boolean) => void;
    onclose: () => void;
  } = $props();

  const single = $derived(items.length === 1 ? items[0] : null);

  // Only a tap that starts on the backdrop closes the sheet. The finger that long-pressed to open
  // it lifts after it appears, and that release must not count.
  let backdropPress = false;

  // Sharing the file itself needs HTTPS and a browser that shares files; elsewhere the row is
  // left out rather than failing.
  const canShareFiles =
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [new File([""], "probe.jpg", { type: "image/jpeg" })] });

  const canCopyImages =
    typeof ClipboardItem !== "undefined" &&
    typeof navigator.clipboard?.write === "function" &&
    (ClipboardItem.supports?.("image/png") ?? true);
  let copyError = $state<string | null>(null);

  /**
   * Browsers take images on the clipboard only as PNG, so other formats are redrawn first. The
   * write starts inside the tap with the image still loading: Safari refuses clipboard writes
   * that begin after an await.
   */
  function copyImage(item: GalleryItem): void {
    copyError = null;
    const png = fetch(originalUrlOf(item), { signal: downloads.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Couldn't load the image (${response.status}).`);
        return response.blob();
      })
      .then((blob) => (blob.type === "image/png" ? blob : toPng(blob)));
    navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).then(onclose, (error) => {
      if (!downloads.signal.aborted) copyError = errorMessage(error);
    });
  }

  async function toPng(blob: Blob): Promise<Blob> {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (png) => (png ? resolve(png) : reject(new Error("Couldn't convert the image."))),
        "image/png",
      ),
    );
  }

  /** A tap may only open the share sheet for a few seconds. A large video can take longer to
   * download, so a download that outlives it waits as "ready" for a second tap. */
  let share = $state.raw<
    | { phase: "idle" | "preparing" }
    | { phase: "ready"; file: File }
    | { phase: "failed"; message: string }
  >({ phase: "idle" });
  const downloads = new AbortController();

  function present(dialog: HTMLDialogElement): () => void {
    dialog.showModal();
    return () => {
      downloads.abort();
      dialog.close();
    };
  }

  async function startShare(item: GalleryItem): Promise<void> {
    if (share.phase === "ready") return shareFile(share.file);
    share = { phase: "preparing" };
    try {
      const response = await fetch(originalUrlOf(item), { signal: downloads.signal });
      if (!response.ok) throw new Error(`Couldn't load the file (${response.status}).`);
      const blob = await response.blob();
      await shareFile(new File([blob], item.displayName, { type: blob.type }));
    } catch (error) {
      if (!downloads.signal.aborted) share = { phase: "failed", message: errorMessage(error) };
    }
  }

  async function shareFile(file: File): Promise<void> {
    if (!navigator.canShare({ files: [file] })) {
      share = { phase: "failed", message: "This browser can't share this type of file." };
      return;
    }
    try {
      await navigator.share({ files: [file] });
      onclose();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") onclose();
      else if (error instanceof DOMException && error.name === "NotAllowedError")
        share = { phase: "ready", file };
      else share = { phase: "failed", message: errorMessage(error) };
    }
  }

  function act(action: () => void): void {
    action();
    onclose();
  }
</script>

<!-- A bottom sheet for touch: the phone's equivalent of the desktop's native file menu. -->
<dialog
  class="file-sheet"
  aria-label={single ? single.displayName : `${items.length} items`}
  {@attach present}
  oncancel={(event) => {
    event.preventDefault();
    onclose();
  }}
  onpointerdown={(event) => (backdropPress = event.target === event.currentTarget)}
  onclick={(event) => {
    if (backdropPress && event.target === event.currentTarget) onclose();
    backdropPress = false;
  }}
>
  <div class="sheet">
    <p class="sheet-title">{single ? single.displayName : `${items.length} items`}</p>
    <div class="sheet-actions">
      {#if single}
        {#if canShareFiles}
          <button
            class="sheet-row"
            type="button"
            disabled={share.phase === "preparing"}
            onclick={() => startShare(single)}
            ><Share size={16} aria-hidden="true" />{share.phase === "preparing"
              ? "Preparing…"
              : share.phase === "ready"
                ? "Ready. Tap to share"
                : "Share…"}</button
          >
        {/if}
        {#if canCopyImages && single.mediaKind === "image"}
          <button class="sheet-row" type="button" onclick={() => copyImage(single)}
            ><Copy size={16} aria-hidden="true" />Copy image</button
          >
        {/if}
        <a
          class="sheet-row"
          href={originalUrlOf(single)}
          download={single.displayName}
          onclick={onclose}><Download size={16} aria-hidden="true" />Download</a
        >
        <a
          class="sheet-row"
          href={originalUrlOf(single)}
          target="_blank"
          rel="noopener"
          onclick={onclose}><ExternalLink size={16} aria-hidden="true" />Open in new tab</a
        >
      {/if}
      <button class="sheet-row" type="button" onclick={() => act(() => onvisualsearch(true))}
        ><ScanSearch size={16} aria-hidden="true" />Find similar images</button
      >
      <button class="sheet-row" type="button" onclick={() => act(() => onvisualsearch(false))}
        ><ImagePlus size={16} aria-hidden="true" />{single
          ? "Add to visual search"
          : `Add ${items.length} to visual search`}</button
      >
    </div>
    {#if share.phase === "failed"}<p class="sheet-error" role="alert">{share.message}</p>{/if}
    {#if copyError}<p class="sheet-error" role="alert">{copyError}</p>{/if}
    <button class="sheet-row sheet-cancel" type="button" onclick={onclose}>Cancel</button>
  </div>
</dialog>

<style>
  .file-sheet {
    box-sizing: border-box;
    width: 100%;
    max-width: var(--sheet-max-width);
    max-height: none;
    margin: auto auto 0;
    padding: 0 var(--space-8) calc(var(--space-8) + env(safe-area-inset-bottom));
    border: 0;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-md);
  }
  .file-sheet::backdrop {
    background: var(--dialog-backdrop);
  }
  /* One panel, like a settings group: a title bar, the actions, then Cancel. */
  .sheet {
    border: 1px solid var(--border);
    background: var(--surface-0);
    box-shadow: var(--shadow-overlay);
  }
  .sheet-title {
    margin: 0;
    padding: var(--space-7) var(--space-12);
    overflow: hidden;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-1);
    color: var(--text-primary);
    font-weight: var(--font-weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sheet-actions {
    display: grid;
  }
  .sheet-row {
    display: flex;
    width: 100%;
    align-items: center;
    gap: var(--space-8);
    min-height: var(--sheet-row-height);
    padding: 0 var(--space-12);
    border: 0;
    border-top: 1px solid var(--border-subtle);
    background: transparent;
    color: var(--text-primary);
    font: inherit;
    text-align: left;
    text-decoration: none;
  }
  .sheet-actions .sheet-row:first-child {
    border-top: 0;
  }
  .sheet-row:active {
    background: var(--surface-1);
  }
  .sheet-row:focus-visible {
    outline: var(--focus-ring);
    outline-offset: -2px;
  }
  .sheet-row :global(svg) {
    color: var(--text-secondary);
  }
  .sheet-row:disabled {
    color: var(--text-secondary);
  }
  .sheet-error {
    margin: 0;
    padding: var(--space-6) var(--space-12);
    border-top: 1px solid var(--border-subtle);
    color: var(--danger);
  }
  .sheet-cancel {
    justify-content: center;
    border-top: 1px solid var(--border);
    background: var(--surface-1);
  }
</style>
