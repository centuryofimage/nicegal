import type { Attachment } from "svelte/attachments";

import { pinchOf, pinchStep, swipeDirection, type Pinch, type Point } from "./gesture-math";
import { startLongPress } from "./long-press";

/** What the gesture handler asks of the viewer it drives. */
export interface ViewerGestureHost {
  /** False for a press on a control inside the media, which handles its own pointer. */
  isGestureTarget(target: Element): boolean;
  /** False where a long press should get the browser's own menu instead of the file actions. */
  opensFileMenuAt(target: Element): boolean;
  /** The image is measured and can be zoomed. */
  isReady(): boolean;
  /** The image is larger than the stage, so a drag pans it. */
  canPan(): boolean;
  pan(): Point;
  setPan(x: number, y: number): void;
  /** Scales the image by `ratio` around a client point. */
  zoomBy(ratio: number, clientX: number, clientY: number): void;
  hasPrev(): boolean;
  hasNext(): boolean;
  onprev(): void;
  onnext(): void;
  onfilemenu(): void;
  /** A press or drag began or ended, so hover highlights should clear. */
  onengage(): void;
  /** The pointer moved with no drag in progress. */
  onhover(event: PointerEvent): void;
}

/**
 * Pointer gestures on the viewer's media area, whatever it shows: an image, a video, or a load
 * error. One finger or the mouse pans a zoomed image; with nothing to pan, a horizontal touch swipe
 * steps between items and holding still opens the file actions. Two fingers zoom an image around
 * the point between them and pan as it moves; lifting one hands the gesture back to the other as
 * a pan.
 *
 * Touch presses rely on the implicit capture to the touched element, so a tap still clicks the
 * control under it.
 */
export class ViewerGestures {
  /** A pan drag is in progress. */
  dragging = $state(false);

  private dragPointerId: number | null = null;
  private dragStart: { pointer: Point; pan: Point } | null = null;
  private swipeStart: { pointerId: number; origin: Point } | null = null;
  private cancelLongPress: (() => void) | null = null;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- gesture bookkeeping; nothing renders from it
  private readonly touches = new Map<number, Point>();
  private pinch: Pinch | null = null;

  constructor(private readonly host: ViewerGestureHost) {}

  readonly attach: Attachment<HTMLElement> = (surface) => {
    const down = (event: PointerEvent): void => this.down(event, surface);
    const move = (event: PointerEvent): void => this.move(event);
    const end = (event: PointerEvent): void => this.end(event, surface);
    surface.addEventListener("pointerdown", down);
    surface.addEventListener("pointermove", move);
    surface.addEventListener("pointerup", end);
    surface.addEventListener("pointercancel", end);
    return () => {
      surface.removeEventListener("pointerdown", down);
      surface.removeEventListener("pointermove", move);
      surface.removeEventListener("pointerup", end);
      surface.removeEventListener("pointercancel", end);
      this.cancelLongPress?.();
      this.touches.clear();
      this.pinch = null;
      this.swipeStart = null;
      this.dragPointerId = null;
      this.dragStart = null;
      this.dragging = false;
    };
  };

  private startPan(pointerId: number, at: Point): void {
    this.dragPointerId = pointerId;
    this.dragStart = { pointer: at, pan: this.host.pan() };
    this.dragging = true;
  }

  private pinchNow(): Pinch {
    const [a, b] = [...this.touches.values()];
    return pinchOf(a, b);
  }

  private down(event: PointerEvent, surface: HTMLElement): void {
    const host = this.host;
    if (!(event.target instanceof Element) || !host.isGestureTarget(event.target)) return;
    const at = { x: event.clientX, y: event.clientY };
    const touch = event.pointerType === "touch";
    if (touch) {
      // The first finger down; a touch whose release never reached the surface is stale.
      if (event.isPrimary) this.touches.clear();
      this.touches.set(event.pointerId, at);
      if (this.touches.size === 2 && host.isReady()) {
        this.cancelLongPress?.();
        this.swipeStart = null;
        this.dragPointerId = null;
        this.dragging = false;
        host.onengage();
        this.pinch = this.pinchNow();
        return;
      }
      if (this.touches.size > 2) return;
    }
    if (touch && !host.canPan() && event.isPrimary) {
      this.swipeStart = { pointerId: event.pointerId, origin: at };
      this.cancelLongPress?.();
      if (host.opensFileMenuAt(event.target))
        this.cancelLongPress = startLongPress(event, () => {
          this.swipeStart = null;
          host.onfilemenu();
        });
      return;
    }
    if (event.button !== 0 || this.dragPointerId !== null || !host.canPan()) return;
    event.preventDefault();
    surface.setPointerCapture(event.pointerId);
    host.onengage();
    this.startPan(event.pointerId, at);
  }

  private move(event: PointerEvent): void {
    const host = this.host;
    const at = { x: event.clientX, y: event.clientY };
    if (this.touches.has(event.pointerId)) this.touches.set(event.pointerId, at);
    if (this.pinch && this.touches.size >= 2) {
      const next = this.pinchNow();
      const step = pinchStep(this.pinch, next);
      host.zoomBy(step.ratio, next.mid.x, next.mid.y);
      const pan = host.pan();
      host.setPan(pan.x + step.pan.x, pan.y + step.pan.y);
      this.pinch = next;
      return;
    }
    if (this.dragPointerId === null) {
      host.onhover(event);
      return;
    }
    const start = this.dragStart;
    if (event.pointerId !== this.dragPointerId || !start) return;
    host.setPan(start.pan.x + at.x - start.pointer.x, start.pan.y + at.y - start.pointer.y);
  }

  private end(event: PointerEvent, surface: HTMLElement): void {
    const host = this.host;
    this.touches.delete(event.pointerId);
    if (this.pinch) {
      if (this.touches.size >= 2) this.pinch = this.pinchNow();
      else {
        this.pinch = null;
        const [remaining] = [...this.touches.entries()];
        if (remaining && host.canPan()) this.startPan(remaining[0], remaining[1]);
      }
      return;
    }
    const swipe = this.swipeStart;
    if (swipe?.pointerId === event.pointerId) {
      this.swipeStart = null;
      if (event.type !== "pointerup") return;
      const direction = swipeDirection(
        event.clientX - swipe.origin.x,
        event.clientY - swipe.origin.y,
      );
      if (direction === "next" && host.hasNext()) host.onnext();
      else if (direction === "prev" && host.hasPrev()) host.onprev();
      return;
    }
    if (event.pointerId !== this.dragPointerId) return;
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
    this.dragPointerId = null;
    this.dragStart = null;
    this.dragging = false;
    host.onengage();
  }
}
