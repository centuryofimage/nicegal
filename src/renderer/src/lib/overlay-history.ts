import { tick } from "svelte";

/** History state key holding an entry's overlay depth (1 for the bottom overlay). */
const DEPTH_KEY = "nicegalOverlay";
/** History state key holding the page state of an entry below every overlay. */
const BASE_KEY = "nicegalBase";

export type HistoryPort = Pick<History, "state" | "pushState" | "replaceState" | "go">;
export interface PopStateSource {
  addEventListener(type: "popstate", listener: () => void): void;
}

export interface OverlayEntry {
  /** Closes the overlay from the UI and drops its history entry. Safe to repeat. */
  close(): void;
}

interface Slot {
  readonly onBack: () => void;
  /** Whether the slot owns the history entry at depth `index + 1`. */
  pushed: boolean;
  open: boolean;
}

function depthOf(state: unknown): number {
  const depth = (state as Record<string, unknown> | null)?.[DEPTH_KEY];
  return typeof depth === "number" ? depth : 0;
}

function baseOf(state: unknown): unknown {
  return (state as Record<string, unknown> | null)?.[BASE_KEY] ?? null;
}

/**
 * Gives each open overlay (viewer, dialog) one browser history entry, so Back or the Android
 * back gesture closes the topmost overlay instead of leaving the app. Pushed slots form a prefix
 * of the stack; slots opened while a traversal is in flight are pushed when it lands.
 *
 * Entries below every overlay are base entries: page states such as searches, which Back and
 * Forward move between once no overlay is open. A base write waits until no overlay owns an
 * entry and no traversal is in flight, so it never cuts off an overlay's entry.
 */
export class OverlayHistory {
  readonly #history: HistoryPort;
  readonly #stack: Slot[] = [];
  /** `go()` calls whose popstate has not arrived yet. */
  #pending = 0;
  /** The latest base write waiting for overlays to close; `push` sticks once requested. */
  #queuedBase: { state: unknown; push: boolean } | null = null;
  #onBase: ((state: unknown) => void) | undefined;

  constructor(history: HistoryPort, events: PopStateSource) {
    this.#history = history;
    // A reload starts without overlays, so an entry left from before it no longer owns one.
    if (depthOf(history.state) > 0) history.replaceState(null, "");
    events.addEventListener("popstate", () => this.#onPopState());
  }

  /** `onBack` runs when Back removes the entry. An overlay still open once the UI settles
   * (e.g. it asked to confirm unsaved changes) gets a fresh entry. */
  open(onBack: () => void): OverlayEntry {
    const slot: Slot = { onBack, pushed: false, open: true };
    this.#stack.push(slot);
    this.#sync();
    return { close: () => this.#close(slot) };
  }

  /** Records the page state at the base. `push` adds a Back step; otherwise the current base
   * entry is updated in place. */
  setBase(state: unknown, push: boolean): void {
    this.#queuedBase = { state, push: push || (this.#queuedBase?.push ?? false) };
    this.#sync();
  }

  /** `listener` receives the base state when Back or Forward lands on another base entry. It is
   * not called for traversals this class makes, or for a Back that closes an overlay. */
  onBaseTraversal(listener: (state: unknown) => void): void {
    this.#onBase = listener;
  }

  #pushedCount(): number {
    const index = this.#stack.findIndex((slot) => !slot.pushed);
    return index < 0 ? this.#stack.length : index;
  }

  #close(slot: Slot): void {
    if (!slot.open) return;
    slot.open = false;
    // A pushed slot below another overlay keeps its depth until the overlays above it close.
    if (!slot.pushed) this.#stack.splice(this.#stack.indexOf(slot), 1);
    else this.#trim();
  }

  /** Removes closed slots from the top of the pushed prefix along with their entries. */
  #trim(): void {
    const pushed = this.#pushedCount();
    let first = pushed;
    while (first > 0 && !this.#stack[first - 1].open) first--;
    if (first === pushed) return;
    this.#stack.splice(first, pushed - first);
    this.#go(first - pushed);
  }

  #go(delta: number): void {
    this.#pending++;
    this.#history.go(delta);
  }

  #sync(): void {
    if (this.#pending > 0) return;
    const base = this.#queuedBase;
    if (base && this.#pushedCount() === 0) {
      this.#queuedBase = null;
      const state = { [BASE_KEY]: base.state };
      if (base.push) this.#history.pushState(state, "");
      else this.#history.replaceState(state, "");
    }
    for (const [index, slot] of this.#stack.entries()) {
      if (slot.pushed) continue;
      this.#history.pushState({ [DEPTH_KEY]: index + 1 }, "");
      slot.pushed = true;
    }
  }

  #onPopState(): void {
    const ownTraversal = this.#pending > 0;
    if (ownTraversal) this.#pending--;
    const depth = depthOf(this.#history.state);
    const pushed = this.#pushedCount();
    if (!ownTraversal && depth === 0 && pushed === 0) {
      // Moving between base entries. A base write still queued belongs to the entry just left.
      this.#queuedBase = null;
      this.#onBase?.(baseOf(this.#history.state));
      this.#sync();
      return;
    }
    if (depth > pushed) {
      // An entry from before a reload, or one already closed: nothing is open there.
      this.#go(pushed - depth);
      return;
    }
    const removed = this.#stack.slice(depth, pushed);
    for (const slot of removed) slot.pushed = false;
    for (let index = removed.length - 1; index >= 0; index--) {
      if (removed[index].open) removed[index].onBack();
    }
    for (let index = this.#stack.length - 1; index >= depth; index--) {
      if (!this.#stack[index].open) this.#stack.splice(index, 1);
    }
    this.#trim();
    if (removed.length) void tick().then(() => this.#sync());
    else this.#sync();
  }
}

let shared: OverlayHistory | undefined;

/** The window's overlay history. The first call clears an overlay entry left by a reload. */
export function overlayHistory(): OverlayHistory {
  return (shared ??= new OverlayHistory(history, window));
}
