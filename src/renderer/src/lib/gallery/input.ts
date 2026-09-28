import type { Attachment } from "svelte/attachments";

import SelectionArea from "@viselect/vanilla";

import type { SelectionModifiers } from "./selection.svelte";
import type { PoolTile } from "./tile-pool";

export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 10;

interface GalleryInputCallbacks {
  onopen(index: number): void;
  onselect(index: number, modifiers: SelectionModifiers): void;
  onfilemenu(index: number): void;
  onfiledrag(index: number, isCurrent: () => boolean): void;
  onclear(): void;
  onmarqueestart(modifiers: SelectionModifiers): void;
  onmarqueechange(ids: readonly string[]): void;
  onmarqueeend(): void;
}

/** Owns pointer/keyboard interpretation and marquee hit testing, independently of the DOM pool. */
export function createGalleryInput(callbacks: GalleryInputCallbacks): {
  attach: Attachment<HTMLDivElement>;
  activate(tile: PoolTile, event: MouseEvent): void;
  onFrameKeydown(event: KeyboardEvent, tile: PoolTile): void;
  openFileMenu(event: MouseEvent, tile: PoolTile): void;
  onFramePointerDown(event: PointerEvent, tile: PoolTile): void;
  startFileDrag(event: DragEvent, tile: PoolTile): void;
  onViewportPointerDown(event: PointerEvent): void;
  onViewportPointerUp(event: PointerEvent): void;
} {
  const BACKGROUND_CLICK_SLOP_PX = 4;
  let gesture = 0;
  let suppressActivation = false;
  function startFileDrag(event: DragEvent, tile: PoolTile): void {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyLink";
    const current = ++gesture;
    suppressActivation = true;
    callbacks.onfiledrag(tile.index, () => gesture === current);
  }
  function activate(tile: PoolTile, event: MouseEvent): void {
    if (suppressActivation && event.detail !== 0) return;
    const modifiers = { toggle: event.ctrlKey || event.metaKey, extend: event.shiftKey };
    if (modifiers.toggle || modifiers.extend) {
      callbacks.onselect(tile.index, modifiers);
    } else {
      callbacks.onopen(tile.index);
    }
  }

  function onFrameKeydown(event: KeyboardEvent, tile: PoolTile): void {
    if (event.key === "Enter") {
      event.preventDefault();
      callbacks.onopen(tile.index);
    } else if (event.key === " ") {
      event.preventDefault();
      callbacks.onselect(tile.index, { toggle: false, extend: event.shiftKey });
    }
  }

  function openFileMenu(event: MouseEvent, tile: PoolTile): void {
    event.preventDefault();
    callbacks.onfilemenu(tile.index);
  }

  /** iOS Safari sends no contextmenu for a long press, so touch presses time their own. Android
   * sends both, which opens the same menu twice with the same items. */
  function onFramePointerDown(event: PointerEvent, tile: PoolTile): void {
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    // Pooled tiles are reused while scrolling; keep the item that was pressed.
    const index = tile.index;
    const { pointerId, clientX: x, clientY: y } = event;
    const stop = (): void => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", stop, true);
      window.removeEventListener("pointercancel", stop, true);
    };
    const move = (moved: PointerEvent): void => {
      if (
        moved.pointerId === pointerId &&
        Math.abs(moved.clientX - x) + Math.abs(moved.clientY - y) > LONG_PRESS_SLOP_PX
      )
        stop();
    };
    const timer = setTimeout(() => {
      stop();
      // The lifted finger's click must not also open the viewer.
      suppressActivation = true;
      callbacks.onfilemenu(index);
    }, LONG_PRESS_MS);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", stop, true);
    window.addEventListener("pointercancel", stop, true);
  }

  /** Press position of a potential background click; consumed on the matching pointerup. A tile
   * press leaves it null so the tile's own activation path owns that interaction. */
  let backgroundPress: { x: number; y: number; pointerId: number } | null = null;

  function onViewportPointerDown(event: PointerEvent): void {
    backgroundPress = null;
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(".gallery-frame")) return;
    backgroundPress = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
  }

  function onViewportPointerUp(event: PointerEvent): void {
    const start = backgroundPress;
    backgroundPress = null;
    if (!start || event.button !== 0 || event.pointerId !== start.pointerId) return;
    const travelled = Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y);
    // A marquee drag (or any drag) ends with a pointerup too; only a genuine click clears.
    if (travelled > BACKGROUND_CLICK_SLOP_PX) return;
    if (event.target instanceof Element && event.target.closest(".gallery-frame")) return;
    callbacks.onclear();
  }

  function selectionModifiers(event: MouseEvent | TouchEvent | null): SelectionModifiers {
    if (!(event instanceof MouseEvent)) return { toggle: false, extend: false };
    return { toggle: event.ctrlKey || event.metaKey, extend: event.shiftKey };
  }

  function selectableIds(elements: readonly Element[]): string[] {
    const ids: string[] = [];
    for (const element of elements) {
      const id = element instanceof HTMLElement ? element.dataset.galleryItemId : undefined;
      if (id) ids.push(id);
    }
    return ids;
  }

  const attach: Attachment<HTMLDivElement> = (viewport) => {
    let marqueeArmed = false;
    const selectionArea = new SelectionArea({
      container: viewport,
      startAreas: [viewport],
      boundaries: [viewport],
      selectables: [".gallery-frame"],
      selectionAreaClass: "gallery-selection-area",
      behaviour: {
        intersect: "touch",
        startThreshold: 4,
        overlap: "keep",
        scrolling: { startScrollMargins: { x: 0, y: 16 } },
      },
      features: {
        // Tile clicks remain app-owned: a primary click opens a detail view and modifier clicks
        // retain the gallery's keyboard-compatible range semantics.
        singleTap: { allow: false },
        range: false,
        touch: false,
      },
    })
      .on("beforestart", ({ event }) => {
        // Decide ownership at the press, before either drag crosses its threshold.
        marqueeArmed = !(
          event?.target instanceof Element && event.target.closest(".gallery-frame")
        );
        return marqueeArmed;
      })
      .on("start", ({ event, selection }) => {
        backgroundPress = null;
        suppressActivation = true;
        // ViSelect stores elements between drags. A recycled pooled element must never carry a
        // previous asset's state, so it is just a hit-testing engine for this drag.
        selection.clearSelection(true, true);
        callbacks.onmarqueestart(selectionModifiers(event));
      })
      .on("move", ({ store }) => {
        callbacks.onmarqueechange(selectableIds(store.selected));
      })
      .on("stop", ({ selection }) => {
        marqueeArmed = false;
        selection.clearSelection(true, true);
        callbacks.onmarqueeend();
      });

    /**
     * A marquee drag only finishes on its own pointerup. Focus loss — Alt+Tab, a native menu
     * stealing focus, minimize — never delivers that pointerup, so the selection box would hang
     * until the next drag. `cancel(true)` tears down the in-progress drag and fires `stop` so the
     * app's marquee snapshot is closed as well.
     */
    const cancelGesture = (): void => {
      gesture++;
      backgroundPress = null;
      if (!marqueeArmed) return;
      marqueeArmed = false;
      selectionArea.cancel(true);
    };
    const cancelMarqueeOnHidden = (): void => {
      if (document.hidden) cancelGesture();
    };
    const onMouseMove = (event: MouseEvent): void => {
      // Mouseup outside the window may be lost. Cancel before ViSelect sees the return move.
      if ((event.buttons & 1) === 0) cancelGesture();
      const start = backgroundPress;
      if (
        start &&
        Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) >
          BACKGROUND_CLICK_SLOP_PX
      )
        backgroundPress = null;
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") cancelGesture();
    };
    const onPointerDown = (): void => {
      cancelGesture();
      suppressActivation = false;
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("blur", cancelGesture);
    window.addEventListener("pointercancel", cancelGesture);
    window.addEventListener("dragstart", cancelGesture, true);
    window.addEventListener("dragend", cancelGesture, true);
    document.addEventListener("visibilitychange", cancelMarqueeOnHidden);

    const resetPress = (): void => {
      gesture++;
      backgroundPress = null;
    };
    window.addEventListener("pointerup", resetPress);
    return () => {
      cancelGesture();
      selectionArea.destroy();
      window.removeEventListener("pointerup", resetPress);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("blur", cancelGesture);
      window.removeEventListener("pointercancel", cancelGesture);
      window.removeEventListener("dragstart", cancelGesture, true);
      window.removeEventListener("dragend", cancelGesture, true);
      document.removeEventListener("visibilitychange", cancelMarqueeOnHidden);
    };
  };
  return {
    attach,
    activate,
    onFrameKeydown,
    openFileMenu,
    onFramePointerDown,
    startFileDrag,
    onViewportPointerDown,
    onViewportPointerUp,
  };
}
