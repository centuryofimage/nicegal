import type { Attachment } from "svelte/attachments";

let openPopovers = 0;

/** Whether a popover is open. Its own listener consumes Escape, so window-wide Escape
 * actions (closing the viewer, clearing the search) stand aside. */
export function hasOpenPopover(): boolean {
  return openPopovers > 0;
}

/** Attach to the common ancestor of the trigger and menu; listeners exist only while open. */
export function popoverDismiss(open: boolean, dismiss: () => void): Attachment<HTMLElement> {
  return (element): (() => void) | undefined => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (!event.composedPath().includes(element)) dismiss();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") dismiss();
    };
    openPopovers++;
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      openPopovers--;
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  };
}
