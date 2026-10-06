import type { Attachment } from "svelte/attachments";

import type { ContentRect } from "./marquee";
import type { SelectionModifiers } from "./selection.svelte";
import type { PoolTile } from "./tile-pool";

import { startLongPress } from "../long-press";
import { autoScrollVelocity, classifyPressTravel, rectFromPoints } from "./marquee";

interface GalleryInputCallbacks {
  onopen(index: number): void;
  onselect(index: number, modifiers: SelectionModifiers): void;
  onfilemenu(index: number): void;
  onfiledrag(index: number, isCurrent: () => boolean): void;
  onclear(): void;
  onmarqueestart(modifiers: SelectionModifiers): void;
  onmarqueechange(ids: readonly string[]): void;
  onmarqueeend(): void;
  /** The box to draw, in canvas coordinates; null when no marquee is active. */
  onmarqueerect(rect: ContentRect | null): void;
  /** Every item touching `rect`, from layout geometry rather than rendered tiles. */
  marqueeHits(rect: ContentRect): readonly string[];
}

/** Owns pointer/keyboard interpretation and the marquee gesture, independently of the DOM pool. */
export function createGalleryInput(callbacks: GalleryInputCallbacks): {
  attach: Attachment<HTMLDivElement>;
  activate(tile: PoolTile, event: MouseEvent): void;
  onFrameKeydown(event: KeyboardEvent, tile: PoolTile): void;
  openFileMenu(event: MouseEvent, tile: PoolTile): void;
  onFramePointerDown(event: PointerEvent, tile: PoolTile): void;
  startFileDrag(event: DragEvent, tile: PoolTile): void;
} {
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
   * sends one too; `startLongPress` lets only the first of the two open the menu. */
  function onFramePointerDown(event: PointerEvent, tile: PoolTile): void {
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    // Pooled tiles are reused while scrolling; keep the item that was pressed.
    const index = tile.index;
    startLongPress(event, () => {
      // The lifted finger's click must not also open the viewer.
      suppressActivation = true;
      callbacks.onfilemenu(index);
    });
  }

  function selectionModifiers(event: MouseEvent): SelectionModifiers {
    return { toggle: event.ctrlKey || event.metaKey, extend: event.shiftKey };
  }

  const attach: Attachment<HTMLDivElement> = (viewport) => {
    /** A primary background press: a click if it barely moves, a marquee once it drags far enough. */
    let press: {
      pointerId: number;
      client: { x: number; y: number };
      /** Press point in canvas coordinates, so the box grows as the viewport scrolls. */
      anchor: { x: number; y: number };
      modifiers: SelectionModifiers;
      canMarquee: boolean;
      active: boolean;
      hits: readonly string[];
    } | null = null;
    let pointer = { x: 0, y: 0 };
    let scrollFrame = 0;
    let lastFrameTime = 0;

    function toContent(clientX: number, clientY: number): { x: number; y: number } {
      const bounds = viewport.getBoundingClientRect();
      const x = clientX - bounds.left - viewport.clientLeft + viewport.scrollLeft;
      const y = clientY - bounds.top - viewport.clientTop + viewport.scrollTop;
      return {
        x: Math.min(Math.max(x, 0), viewport.scrollWidth),
        y: Math.min(Math.max(y, 0), viewport.scrollHeight),
      };
    }

    function edgeVelocity(): number {
      const bounds = viewport.getBoundingClientRect();
      return autoScrollVelocity(pointer.y, bounds.top, bounds.bottom);
    }

    function updateMarquee(): void {
      if (!press?.active) return;
      const rect = rectFromPoints(press.anchor, toContent(pointer.x, pointer.y));
      callbacks.onmarqueerect(rect);
      const previous = press.hits;
      const hits = callbacks.marqueeHits(rect);
      if (hits.length !== previous.length || hits.some((id, index) => id !== previous[index])) {
        press.hits = hits;
        callbacks.onmarqueechange(hits);
      }
      if (!scrollFrame && edgeVelocity() !== 0) {
        lastFrameTime = performance.now();
        scrollFrame = requestAnimationFrame(autoScroll);
      }
    }

    /** Scrolls while the pointer is held near or past the top or bottom edge. The resulting scroll
     * event updates the marquee. */
    function autoScroll(time: number): void {
      scrollFrame = 0;
      const velocity = press?.active ? edgeVelocity() : 0;
      if (velocity === 0) return;
      const elapsed = Math.min(100, Math.max(0, time - lastFrameTime));
      lastFrameTime = time;
      viewport.scrollTop += (velocity * elapsed) / 1000;
      scrollFrame = requestAnimationFrame(autoScroll);
    }

    function endPress(): void {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = 0;
      const ended = press;
      press = null;
      if (!ended?.active) return;
      callbacks.onmarqueerect(null);
      callbacks.onmarqueeend();
    }

    const onViewportPointerDown = (event: PointerEvent): void => {
      endPress();
      if (event.button !== 0) return;
      if (event.target instanceof Element && event.target.closest(".gallery-frame")) return;
      pointer = { x: event.clientX, y: event.clientY };
      press = {
        pointerId: event.pointerId,
        client: pointer,
        anchor: toContent(event.clientX, event.clientY),
        modifiers: selectionModifiers(event),
        // Touch drags scroll the gallery instead.
        canMarquee: event.pointerType !== "touch",
        active: false,
        hits: [],
      };
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!press || event.pointerId !== press.pointerId) return;
      pointer = { x: event.clientX, y: event.clientY };
      if (!press.active) {
        const travel = classifyPressTravel(pointer.x - press.client.x, pointer.y - press.client.y);
        if (travel !== "marquee" || !press.canMarquee) return;
        press.active = true;
        suppressActivation = true;
        callbacks.onmarqueestart(press.modifiers);
      }
      updateMarquee();
    };

    const onPointerUp = (event: PointerEvent): void => {
      gesture++;
      const ended = press;
      if (!ended || event.pointerId !== ended.pointerId) return;
      endPress();
      if (ended.active || event.button !== 0) return;
      const travel = classifyPressTravel(
        event.clientX - ended.client.x,
        event.clientY - ended.client.y,
      );
      if (travel !== "click") return;
      if (event.target instanceof Element && event.target.closest(".gallery-frame")) return;
      callbacks.onclear();
    };

    /** Focus loss (Alt+Tab, a native menu, minimize) never delivers the press's pointerup. */
    const cancelGesture = (): void => {
      gesture++;
      endPress();
    };
    const cancelOnHidden = (): void => {
      if (document.hidden) cancelGesture();
    };
    const onMouseMove = (event: MouseEvent): void => {
      // A mouseup outside the window may be lost.
      if ((event.buttons & 1) === 0) cancelGesture();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") cancelGesture();
    };
    const onPointerDown = (): void => {
      cancelGesture();
      suppressActivation = false;
    };
    const onScroll = (): void => updateMarquee();
    const listeners: [EventTarget, string, EventListener, boolean?][] = [
      [viewport, "pointerdown", onViewportPointerDown as EventListener],
      [viewport, "scroll", onScroll],
      [window, "pointermove", onPointerMove as EventListener, true],
      [window, "pointerup", onPointerUp as EventListener, true],
      [window, "keydown", onKeyDown as EventListener, true],
      [window, "pointerdown", onPointerDown, true],
      [window, "mousemove", onMouseMove as EventListener, true],
      [window, "blur", cancelGesture],
      [window, "pointercancel", cancelGesture],
      [window, "dragstart", cancelGesture, true],
      [window, "dragend", cancelGesture, true],
      [document, "visibilitychange", cancelOnHidden],
    ];
    for (const [target, type, listener, capture] of listeners)
      target.addEventListener(type, listener, capture);
    return () => {
      cancelGesture();
      for (const [target, type, listener, capture] of listeners)
        target.removeEventListener(type, listener, capture);
    };
  };
  return {
    attach,
    activate,
    onFrameKeydown,
    openFileMenu,
    onFramePointerDown,
    startFileDrag,
  };
}
