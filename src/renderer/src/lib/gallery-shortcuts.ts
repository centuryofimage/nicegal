export interface GalleryShortcutActions {
  focusSearch: () => void;
  toggleInfo: () => void;
  closeInfo: () => void;
  /** Closes the viewer or clears the selection; false when there was neither. */
  dismissView: () => boolean;
  /** False when the search was already clear. */
  clearSearch: () => boolean;
  /** An open popover consumes Escape itself. */
  popoverOpen: () => boolean;
  /** Back/Forward keys. Omitted where the browser already handles them. */
  navigateHistory?: (delta: -1 | 1) => void;
  checkForChanges: () => void;
}

const isMac = /Mac/i.test(globalThis.navigator?.platform ?? "");

/** Alt+Left/Right, or Command+[ and ] on macOS, where Option+arrows move by word. */
function historyDelta(event: KeyboardEvent): -1 | 1 | null {
  if (event.shiftKey || event.ctrlKey) return null;
  if (isMac) {
    if (!event.metaKey || event.altKey) return null;
    return event.key === "[" ? -1 : event.key === "]" ? 1 : null;
  }
  if (!event.altKey || event.metaKey) return null;
  return event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : null;
}

/** Workspace-wide shortcuts live here. SearchBar and DetailView own keys local to
 * their controls; they get first refusal through preventDefault/stopPropagation. */
export function createGalleryShortcutHandler(
  actions: GalleryShortcutActions,
): (event: KeyboardEvent) => void {
  return (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    const command = event.metaKey || event.ctrlKey;

    // Search focus works while editing text too; both shortcuts support macOS Command.
    if (
      command &&
      !event.altKey &&
      !event.shiftKey &&
      !event.repeat &&
      (event.key.toLowerCase() === "l" || event.key.toLowerCase() === "f")
    ) {
      event.preventDefault();
      actions.focusSearch();
      return;
    }

    if (event.key === "F5" && !command && !event.altKey && !event.shiftKey && !event.repeat) {
      event.preventDefault();
      actions.checkForChanges();
      return;
    }

    const delta = actions.navigateHistory ? historyDelta(event) : null;
    if (delta !== null) {
      event.preventDefault();
      actions.navigateHistory?.(delta);
      return;
    }

    const target = event.target;
    if (
      event.key.toLowerCase() === "i" &&
      !document.fullscreenElement &&
      (!command || !event.shiftKey) &&
      !event.altKey &&
      !event.repeat &&
      !(
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest("dialog") ||
          (!command && target.closest("input, textarea, select")))
      )
    ) {
      event.preventDefault();
      actions.toggleInfo();
      return;
    }
    if (event.key !== "Escape") return;
    if (target instanceof Element && target.closest(".metadata-panel")) {
      event.preventDefault();
      actions.closeInfo();
      return;
    }
    if (document.fullscreenElement || actions.popoverOpen()) return;
    // One layer per press: the viewer, then the selection, then the search.
    if (actions.dismissView() || actions.clearSearch()) event.preventDefault();
  };
}
