import assert from "node:assert/strict";
import { test } from "node:test";

import { createGalleryShortcutHandler } from "../src/renderer/src/lib/gallery-shortcuts.ts";

class Target {
  isContentEditable = false;
  private selector: string;
  constructor(selector: string = "") {
    this.selector = selector;
  }
  closest(selector: string): Target | null {
    return selector.split(", ").includes(this.selector) ? this : null;
  }
}
Object.assign(globalThis, {
  Element: Target,
  HTMLElement: Target,
  document: { fullscreenElement: null },
});

/** What Escape finds open, and whether a popover is showing. */
interface Layers {
  view: boolean;
  search: boolean;
  popover: boolean;
}

function fixture(layers: Partial<Layers> = {}): {
  calls: string[];
  layers: Layers;
  press: (key: string, options?: Partial<KeyboardEvent>) => KeyboardEvent;
} {
  const calls: string[] = [];
  const open: Layers = { view: true, search: false, popover: false, ...layers };
  const handle = createGalleryShortcutHandler({
    focusSearch: () => calls.push("search"),
    toggleInfo: () => calls.push("info"),
    closeInfo: () => calls.push("close-info"),
    dismissView: () => {
      if (!open.view) return false;
      calls.push("dismiss");
      open.view = false;
      return true;
    },
    clearSearch: () => {
      if (!open.search) return false;
      calls.push("clear");
      open.search = false;
      return true;
    },
    popoverOpen: () => open.popover,
    navigateHistory: (delta) => calls.push(delta < 0 ? "back" : "forward"),
    checkForChanges: () => calls.push("check"),
  });
  function press(key: string, options: Partial<KeyboardEvent> = {}): KeyboardEvent {
    const event = {
      key,
      target: null,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...options,
    } as unknown as KeyboardEvent;
    handle(event);
    return event;
  }
  return { calls, layers: open, press };
}

test("Ctrl/Cmd+L and F focus search from editing controls, excluding modified/repeated or consumed keys", () => {
  const { calls, press } = fixture();
  const target = new Target("input") as unknown as EventTarget;
  assert.equal(press("l", { ctrlKey: true, target }).defaultPrevented, true);
  assert.equal(press("L", { metaKey: true, target }).defaultPrevented, true);
  assert.equal(press("f", { ctrlKey: true, target }).defaultPrevented, true);
  assert.equal(press("F", { metaKey: true, target }).defaultPrevented, true);
  for (const options of [
    { altKey: true },
    { shiftKey: true },
    { repeat: true },
    { defaultPrevented: true },
  ])
    for (const key of ["l", "f"]) press(key, { ctrlKey: true, ...options });
  press("l");
  press("f");
  assert.deepEqual(calls, ["search", "search", "search", "search"]);
});

test("Info shortcut leaves text entry, modal controls, and fullscreen alone", () => {
  const { calls, press } = fixture();
  press("i");
  press("i", { target: new Target("input") as unknown as EventTarget });
  const editable = new Target();
  editable.isContentEditable = true;
  press("i", { target: editable as unknown as EventTarget });
  press("i", { ctrlKey: true });
  press("i", { metaKey: true });
  press("i", { ctrlKey: true, target: new Target("input") as unknown as EventTarget });
  press("i", { ctrlKey: true, target: new Target("dialog") as unknown as EventTarget });
  press("i", { ctrlKey: true, shiftKey: true });
  press("i", { repeat: true });
  Object.assign(document, { fullscreenElement: new Target() });
  try {
    press("i");
  } finally {
    Object.assign(document, { fullscreenElement: null });
  }
  assert.deepEqual(calls, ["info", "info", "info", "info"]);
});

test("Escape respects local handling, closes focused Info first, then dismisses the view", () => {
  const { calls, press } = fixture();
  press("Escape", { defaultPrevented: true });
  press("Escape", { target: new Target(".metadata-panel") as unknown as EventTarget });
  press("Escape");
  Object.assign(document, { fullscreenElement: new Target() });
  try {
    press("Escape");
  } finally {
    Object.assign(document, { fullscreenElement: null });
  }
  assert.deepEqual(calls, ["close-info", "dismiss"]);
});

test("F5 checks for changes unless modified or repeated", () => {
  const { calls, press } = fixture();
  const event = press("F5");
  assert.equal(event.defaultPrevented, true);
  press("F5", { ctrlKey: true });
  press("F5", { shiftKey: true });
  press("F5", { repeat: true });
  assert.deepEqual(calls, ["check"]);
});

test("Escape peels one layer per press: the view, then the search, then nothing", () => {
  const { calls, press } = fixture({ view: true, search: true });
  assert.equal(press("Escape").defaultPrevented, true);
  assert.equal(press("Escape").defaultPrevented, true);
  assert.equal(press("Escape").defaultPrevented, false, "an already clear search is left alone");
  assert.deepEqual(calls, ["dismiss", "clear"]);
});

test("Escape leaves the view and search alone while a popover closes", () => {
  const { calls, layers, press } = fixture({ view: true, search: true, popover: true });
  press("Escape");
  assert.deepEqual(calls, []);
  layers.popover = false;
  press("Escape");
  assert.deepEqual(calls, ["dismiss"]);
});

test("Alt+Left and Alt+Right move through history, even from the search field", () => {
  const { calls, press } = fixture();
  const field = new Target("input") as unknown as EventTarget;
  assert.equal(press("ArrowLeft", { altKey: true, target: field }).defaultPrevented, true);
  press("ArrowRight", { altKey: true });
  press("ArrowLeft");
  press("ArrowLeft", { altKey: true, shiftKey: true });
  press("ArrowLeft", { altKey: true, ctrlKey: true });
  assert.deepEqual(calls, ["back", "forward"]);
});
