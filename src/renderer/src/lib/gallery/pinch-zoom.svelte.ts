import { tick } from "svelte";
import { get } from "svelte/store";

import type { LayoutOptions } from "./options";

import { distance, type Point } from "../gesture-math";
import { settings, settingsLimits } from "../settings.svelte";
import { setTileSize, sizeKey, type SizeKey } from "./wheel-zoom";

interface Pinch {
  distance: number;
  size: number;
  key: SizeKey;
  current: number;
  view: HTMLElement;
  /** Elements the fingers landed on. Touch events keep going to them even after the gallery
   * recycles them out of the page, where they no longer bubble to the gallery. */
  targets: Set<EventTarget>;
}

/**
 * Two-finger pinch resizes tiles live, like a phone's photo gallery: spreading the fingers makes
 * them bigger. While the fingers are down the size goes to the layout as `override`, unrounded
 * and with rows not stretched to fill, so tiles follow the fingers continuously; releasing saves
 * it once. The point between the fingers keeps the same place in the gallery as rows reflow.
 */
export class GalleryPinchZoom {
  /** Layout options to lay over the saved ones while a pinch is in progress. */
  override = $state.raw<Partial<LayoutOptions> | null>(null);
  private pinch: Pinch | null = null;
  private frame = 0;

  constructor(private readonly isBlocked: () => boolean) {}

  /** Svelte attachment for the element that contains `.gallery-viewport`. Its CSS must set
   * `touch-action: pan-x pan-y`, so the browser never takes a pinch as page zoom. */
  readonly attach = (element: HTMLDivElement): (() => void) => {
    const onStart = (event: TouchEvent): void => this.start(event, element);
    const onMove = (event: TouchEvent): void => this.move(event);
    const onEnd = (event: TouchEvent): void => this.end(event);
    element.addEventListener("touchstart", onStart, { passive: true });
    element.addEventListener("touchmove", onMove, { passive: false });
    element.addEventListener("touchend", onEnd);
    element.addEventListener("touchcancel", onEnd);
    return () => {
      this.finish(false);
      element.removeEventListener("touchstart", onStart);
      element.removeEventListener("touchmove", onMove);
      element.removeEventListener("touchend", onEnd);
      element.removeEventListener("touchcancel", onEnd);
    };
  };

  private start(event: TouchEvent, element: HTMLElement): void {
    if (event.touches.length !== 2 || this.isBlocked()) return this.finish(true);
    const view = element.querySelector<HTMLElement>(".gallery-viewport");
    if (!view) return;
    const current = get(settings);
    const key = sizeKey(current);
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- gesture bookkeeping; nothing renders from it
    const targets = new Set<EventTarget>();
    for (const touch of event.touches) targets.add(touch.target);
    for (const target of targets) {
      target.addEventListener("touchmove", this.onDetached, { passive: false });
      target.addEventListener("touchend", this.onDetached);
      target.addEventListener("touchcancel", this.onDetached);
    }
    this.pinch = {
      distance: fingerSpan(event.touches),
      size: current[key],
      key,
      current: current[key],
      view,
      targets,
    };
  }

  /** Events whose target has left the page never reach the gallery element. */
  private readonly onDetached = (event: Event): void => {
    const touch = event as TouchEvent;
    if (touch.target instanceof Node && touch.target.isConnected) return;
    if (event.type === "touchmove") this.move(touch);
    else this.end(touch);
  };

  private move(event: TouchEvent): void {
    const pinch = this.pinch;
    if (!pinch || event.touches.length !== 2) return;
    if (event.cancelable) event.preventDefault();
    const limit = settingsLimits[pinch.key];
    pinch.current = Math.max(
      limit.min,
      Math.min(limit.max, (pinch.size * fingerSpan(event.touches)) / pinch.distance),
    );
    const midY =
      (event.touches[0].clientY + event.touches[1].clientY) / 2 -
      pinch.view.getBoundingClientRect().top;
    // One layout per frame, however many touchmoves arrive.
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => void this.apply(pinch, midY));
  }

  private async apply(pinch: Pinch, midY: number): Promise<void> {
    const { view } = pinch;
    const anchor = (view.scrollTop + midY) / Math.max(1, view.scrollHeight);
    this.override = overrideFor(pinch.key, pinch.current);
    await tick();
    if (this.pinch === pinch) view.scrollTop = anchor * view.scrollHeight - midY;
  }

  private end(event: TouchEvent): void {
    if (event.touches.length < 2) this.finish(true);
  }

  private finish(save: boolean): void {
    const pinch = this.pinch;
    if (!pinch) return;
    this.pinch = null;
    cancelAnimationFrame(this.frame);
    for (const target of pinch.targets) {
      target.removeEventListener("touchmove", this.onDetached);
      target.removeEventListener("touchend", this.onDetached);
      target.removeEventListener("touchcancel", this.onDetached);
    }
    if (save && pinch.current !== pinch.size) setTileSize(() => pinch.current, true);
    this.override = null;
  }
}

function overrideFor(key: SizeKey, size: number): Partial<LayoutOptions> {
  if (key === "targetRowHeight") return { targetRowHeight: size };
  if (key === "masonryColumnWidth") return { columnWidth: size, fillRows: false };
  return { cellWidth: size, columns: 0, fillRows: false };
}

function fingerSpan(touches: TouchList): number {
  const point = (touch: Touch): Point => ({ x: touch.clientX, y: touch.clientY });
  return distance(point(touches[0]), point(touches[1]));
}
