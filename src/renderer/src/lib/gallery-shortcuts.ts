export interface GalleryShortcutActions {
  focusSearch: () => void;
  toggleInfo: () => void;
  closeInfo: () => void;
  dismissView: () => void;
  checkForChanges: () => void;
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
    if (!document.fullscreenElement) actions.dismissView();
  };
}
