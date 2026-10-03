import assert from "node:assert/strict";

import type { GalleryItem } from "../../src/renderer/src/lib/gallery/types";

import { createApplication } from "../../src/renderer/src/lib/application.svelte";
import { GallerySelection } from "../../src/renderer/src/lib/gallery/selection.svelte";
import {
  createLibraryViewController,
  type LibraryViewController,
} from "../../src/renderer/src/lib/library-view.svelte";
import { FakeHistory } from "./fake-history";

const plain = { toggle: false, extend: false };
const toggle = { toggle: true, extend: false };
const selection = new GallerySelection();
const visible = ["1", "2", "3"];
selection.select("1", visible, plain);
selection.beginMarquee(toggle);
selection.updateMarquee(["2"], visible);
assert.deepEqual([...selection.ids], ["1", "2"]);
selection.updateMarquee([], visible);
assert.deepEqual([...selection.ids], ["1"], "reversing a marquee restores the baseline");
selection.clear();
selection.updateMarquee(["2"], visible);
assert.equal(selection.count, 0, "clear ends the snapshot so later moves cannot restore it");
selection.beginMarquee(plain);
selection.select("3", visible, plain);
selection.updateMarquee(["2"], visible);
assert.deepEqual([...selection.ids], ["3"], "item selection owns the gesture after a marquee");
selection.beginMarquee(toggle);
selection.retainCatalogAssets([{ id: "1" }, { id: "2" }]);
selection.updateMarquee(["2"], ["1", "2"]);
assert.deepEqual([...selection.ids], ["2"], "deleted baseline IDs cannot reappear");
selection.endMarquee();
selection.updateMarquee(["1"], visible);
assert.deepEqual([...selection.ids], ["2"]);

let prepared = Promise.withResolvers<string>();
const starts: string[] = [];
const groups: string[][] = [];
const browser = new FakeHistory();
Object.assign(globalThis, {
  history: browser,
  window: {
    addEventListener: browser.addEventListener.bind(browser),
    nicegal: {
      backend: {},
      native: {
        prepareFileDrag: ({ assetIds }: { assetIds: string[] }) => {
          groups.push(assetIds);
          return prepared.promise;
        },
        startFileDrag: async (token: string) => {
          starts.push(token);
        },
      },
    },
  },
});
const app = createApplication();
let held = true;
const canceled = app.commands.startFileDrag(["1", "2"], () => held);
held = false;
prepared.resolve("canceled");
await canceled;
assert.deepEqual(starts, [], "release during lookup must never start a late native drag");
prepared = Promise.withResolvers<string>();
const active = app.commands.startFileDrag(["1", "2"], () => true);
prepared.resolve("active");
await active;
assert.deepEqual(starts, ["active"]);

app.services.catalog.items = visible.map(
  (id) => ({ id, displayName: `${id}.png`, date: 0, aspectRatio: 1 }) as GalleryItem,
);
let view!: LibraryViewController;
const dispose = $effect.root(() => {
  view = createLibraryViewController(app, () => {});
});
view.selectGalleryItem(0, plain);
view.selectGalleryItem(2, toggle);
view.startFileDrag(0, () => true);
assert.deepEqual(groups.at(-1), ["1", "3"], "a selected tile exports the whole selected group");
view.startFileDrag(1, () => true);
assert.deepEqual(groups.at(-1), ["2"], "an unselected tile exports itself");
assert.deepEqual([...view.gallerySelection.ids], ["2"]);
await Promise.resolve();
prepared = Promise.withResolvers<string>();
const startsBeforeChange = starts.length;
view.startFileDrag(1, () => true);
app.services.catalog.items = [...app.services.catalog.items];
prepared.resolve("stale-results");
await Promise.resolve();
assert.equal(starts.length, startsBeforeChange, "changed results invalidate a pending file export");
view.dispose();
dispose();
