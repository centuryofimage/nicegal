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

function fixture(): {
  calls: string[];
  press: (key: string, options?: Partial<KeyboardEvent>) => KeyboardEvent;
} {
  const calls: string[] = [];
  const handle = createGalleryShortcutHandler({
    focusSearch: () => calls.push("search"),
    toggleInfo: () => calls.push("info"),
    closeInfo: () => calls.push("close-info"),
    dismissView: () => calls.push("dismiss"),
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
  return { calls, press };
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
