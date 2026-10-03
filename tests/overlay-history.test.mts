import assert from "node:assert/strict";
import { test } from "node:test";

import { OverlayHistory } from "../src/renderer/src/lib/overlay-history.ts";
import { FakeHistory } from "./helpers/fake-history.ts";

function setup(): { browser: FakeHistory; overlays: OverlayHistory } {
  const browser = new FakeHistory();
  return { browser, overlays: new OverlayHistory(browser, browser) };
}

/** Lands traversals and lets deferred re-pushes run. */
async function settle(browser: FakeHistory): Promise<void> {
  for (let round = 0; round < 3; round++) {
    browser.flush();
    await Promise.resolve();
  }
}

test("UI close drops the entry and leaves no stale history", async () => {
  const { browser, overlays } = setup();
  const entry = overlays.open(() => assert.fail("UI close is not a Back"));
  assert.equal(browser.index, 1);
  entry.close();
  entry.close();
  await settle(browser);
  assert.equal(browser.index, 0);
  overlays.open(() => {}).close();
  await settle(browser);
  assert.equal(browser.length, 2, "reopening reuses the forward slot instead of growing");
  assert.equal(browser.index, 0);
});

test("Back closes the topmost overlay first: viewer, then settings, then Back twice", async () => {
  const { browser, overlays } = setup();
  const closed: string[] = [];
  const open = (name: string): void => {
    const entry = overlays.open(() => {
      closed.push(name);
      entry.close();
    });
  };
  open("viewer");
  open("settings");
  assert.equal(browser.index, 2);
  browser.back();
  await settle(browser);
  assert.deepEqual(closed, ["settings"]);
  assert.equal(browser.index, 1);
  browser.back();
  await settle(browser);
  assert.deepEqual(closed, ["settings", "viewer"]);
  assert.equal(browser.index, 0, "no extra traversal after the Back-driven closes");
});

test("an overlay that declines Back gets its entry back", async () => {
  const { browser, overlays } = setup();
  let asked = 0;
  const entry = overlays.open(() => asked++);
  browser.back();
  await settle(browser);
  assert.equal(asked, 1);
  assert.equal(browser.index, 1, "still-open dialog owns an entry again");
  entry.close();
  await settle(browser);
  assert.equal(browser.index, 0);
});

test("opening during an in-flight close pushes after the traversal lands", async () => {
  const { browser, overlays } = setup();
  overlays.open(() => {}).close();
  const reopened: string[] = [];
  overlays.open(() => reopened.push("next"));
  assert.equal(browser.index, 1, "push waits for the pending Back");
  await settle(browser);
  assert.equal(browser.index, 1);
  assert.deepEqual(browser.entries.length, 2);
  browser.back();
  await settle(browser);
  assert.deepEqual(reopened, ["next"]);
});

test("closing a lower overlay first keeps depths aligned", async () => {
  const { browser, overlays } = setup();
  const viewer = overlays.open(() => assert.fail("viewer was already closed"));
  const manager = overlays.open(() => {});
  viewer.close();
  await settle(browser);
  assert.equal(browser.index, 2, "the dialog above keeps its entry");
  manager.close();
  await settle(browser);
  assert.equal(browser.index, 0, "both entries are dropped together");
});

test("a reload clears a leftover overlay entry and skips stale ones", async () => {
  const browser = new FakeHistory();
  const before = new OverlayHistory(browser, browser);
  before.open(() => {});
  before.open(() => {});
  const reloaded = new FakeHistory();
  reloaded.entries = [...browser.entries];
  reloaded.index = browser.index;
  const overlays = new OverlayHistory(reloaded, reloaded);
  assert.equal(reloaded.state, null, "current entry no longer claims an overlay");
  reloaded.back();
  await settle(reloaded);
  assert.equal(reloaded.index, 0, "Back skips entries from before the reload");
  let backs = 0;
  overlays.open(() => backs++);
  reloaded.back();
  await settle(reloaded);
  assert.equal(backs, 1);
});
