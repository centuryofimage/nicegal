import assert from "node:assert/strict";
import { flushSync, tick } from "svelte";

import type { GalleryItem } from "../../src/renderer/src/lib/gallery/types";
import type { JobSnapshot } from "../../src/shared/backend";

import { createApplication } from "../../src/renderer/src/lib/application.svelte";
import { emptyLayout } from "../../src/renderer/src/lib/gallery/types";
import {
  createLibraryViewController,
  type LibraryViewController,
} from "../../src/renderer/src/lib/library-view.svelte";
import { layoutOptions, settings } from "../../src/renderer/src/lib/settings.svelte";
import { FakeHistory } from "./fake-history";

const browser = new FakeHistory();
Object.assign(globalThis, {
  history: browser,
  window: {
    nicegal: { backend: { cancelSearch: async () => {} } },
    addEventListener: browser.addEventListener.bind(browser),
  },
});

const app = createApplication();
const { catalog, ocrSearch } = app.services;
catalog.definitions = [
  {
    id: 1,
    include: [
      { path: "C:/library", scanPending: false, scanError: null, lastScanCompletedNs: null },
    ],
    exclude: [],
    ocr: false,
    image: true,
  },
];
catalog.selectedId = 1;
catalog.loading = false;
catalog.backendStatus = { ready: true, error: null };
const row = {
  cataloged: 0,
  indexed: 0,
  embedded: 0,
  pending: 0,
  lastIndexedAt: null,
  loading: false,
  error: null,
};
catalog.libraryStatuses.set(1, row);
let schedules = 0;
ocrSearch.schedule = () => {
  schedules++;
};
let view!: LibraryViewController;
const stop = $effect.root(() => {
  view = createLibraryViewController(app, () => {});
});
flushSync();
assert.equal(schedules, 1);
const librariesBeforeScroll = catalog.libraries;
for (let offset = 100; offset <= 500; offset += 100) {
  catalog.updateLibraryViewState(1, { scrollTop: offset });
  catalog.libraryStatuses.set(1, { ...row });
  flushSync();
}
assert.equal(schedules, 1, "scroll saves and unchanged row snapshots must not restart search");
assert.equal(
  catalog.libraries,
  librariesBeforeScroll,
  "scroll saves must not rebuild the library records the pane renders",
);
catalog.libraryStatuses.set(1, { ...row, loading: true });
flushSync();
catalog.libraryStatuses.set(1, { ...row, error: "Temporary status failure" });
flushSync();
assert.equal(schedules, 1, "transient status states must not toggle search engines");
view.handleGalleryScroll({ scrollTop: 900, layout: emptyLayout() });
flushSync();
assert.equal(schedules, 1);
ocrSearch.query = "cats";
flushSync();
assert.equal(schedules, 2, "query changes still search");
catalog.libraryStatuses.set(1, { ...row, indexed: 1 });
flushSync();
assert.equal(schedules, 3, "new OCR data enables text search");
const selection = view.gallerySelection;
selection.select("1", ["1"], { toggle: false, extend: false });
view.toggleSection("visual");
flushSync();
assert.equal(schedules, 3, "collapse does not schedule search");
ocrSearch.query = "dogs";
assert.notEqual(view.gallerySelection, selection, "selection resets synchronously for a new query");
flushSync();
assert.equal(schedules, 4);

// Model residency changes must not reschedule an unchanged query.
const { runtime } = app.services;
const readyModel = { state: "ready" as const, error: null };
const idleModel = { state: "notLoaded" as const, error: null };
runtime.models = { text: readyModel, clipImage: readyModel, clipText: readyModel };
flushSync();
assert.equal(schedules, 4, "completing a lazy load must not duplicate a successful search");
runtime.models = { text: idleModel, clipImage: idleModel, clipText: idleModel };
flushSync();
assert.equal(schedules, 4, "idle eviction must not rerun the current query");
ocrSearch.imageSetupRequired = true;
flushSync();
assert.equal(schedules, 4, "a setup notice alone must not cause a retry loop");
runtime.models = { text: idleModel, clipImage: idleModel, clipText: readyModel };
flushSync();
assert.equal(schedules, 5, "a recovered image encoder retries a blocked visual search");
ocrSearch.imageSetupRequired = false;
runtime.models = { text: idleModel, clipImage: idleModel, clipText: { ...readyModel } };
flushSync();
assert.equal(schedules, 5, "status polling must not repeat the recovery retry");
runtime.models = { text: idleModel, clipImage: idleModel, clipText: idleModel };
flushSync();
assert.equal(schedules, 5, "a query left visible stays idle after eviction");

// A job updates the live catalog without invalidating an unchanged search snapshot.
ocrSearch.apply = (items) => ({
  items,
  matchTotal: items.length,
  filtering: Boolean(ocrSearch.query),
});
const first = [{ id: "first" }] as GalleryItem[];
catalog.items = first;
flushSync();
const beforeJob = schedules;
const { jobs } = app.services;
jobs.active = { jobId: "catalog", type: "libraryScan", status: "running" } as JobSnapshot;
flushSync();
assert.equal(schedules, beforeJob, "starting a job retains settled search results");
const latest = [{ id: "first" }, { id: "second" }] as GalleryItem[];
catalog.items = latest;
catalog.libraryStatuses.set(1, { ...row, cataloged: 2, indexed: 0 });
flushSync();
assert.equal(catalog.items.length, 2, "live catalog keeps advancing");
assert.equal(view.filteredItems, first, "displayed search uses the retained catalog snapshot");
assert.equal(
  schedules,
  beforeJob,
  "catalog and coverage updates do not restart search during a job",
);
ocrSearch.query = "new query";
flushSync();
assert.equal(schedules, beforeJob + 1, "explicit searches still run during cataloging");
assert.equal(view.filteredItems, latest);
const completed = [...latest, { id: "third" }] as GalleryItem[];
catalog.items = completed;
flushSync();
assert.equal(view.filteredItems, latest);
jobs.active = { ...jobs.active, status: "completed" };
flushSync();
assert.equal(schedules, beforeJob + 2, "job completion refreshes the search");
assert.equal(view.filteredItems, completed);
jobs.active = { ...jobs.active, status: "running" };
flushSync();
ocrSearch.query = "";
flushSync();
catalog.items = first;
flushSync();
assert.equal(view.filteredItems, first, "clearing search returns to the live catalog during a job");
const idleSearchSchedules = schedules;
const idleSearchView = view.searchView;
for (let completed = 1; completed <= 10; completed++) {
  jobs.active = {
    ...jobs.active!,
    phase: "imageEmbedding",
    progress: { phaseCompleted: completed } as JobSnapshot["progress"],
  };
  flushSync();
}
assert.equal(
  schedules,
  idleSearchSchedules,
  "job progress must not reschedule an unfiltered gallery",
);
assert.equal(view.searchView, idleSearchView, "job progress must preserve the gallery view");
const originalLayout = view.galleryLayoutOptions;
let layoutEmissions = 0;
const unsubscribeLayout = layoutOptions.subscribe(() => layoutEmissions++);
settings.update((value) => ({ ...value, debugIndexLimit: value.debugIndexLimit + 1 }));
flushSync();
assert.equal(layoutEmissions, 1, "non-layout settings do not publish layout changes");
assert.equal(view.galleryLayoutOptions, originalLayout);
settings.update((value) => ({ ...value, gap: value.gap + 1 }));
flushSync();
assert.equal(layoutEmissions, 2, "layout changes still publish");
assert.notEqual(view.galleryLayoutOptions, originalLayout);
unsubscribeLayout();
const geometry = emptyLayout();
app.services.jobs.active = null;
view.galleryScroll.onScroll({ scrollTop: 100, layout: geometry });
flushSync();
assert.equal(view.galleryScroll.layout, geometry, "geometry remains an unproxied snapshot");
const replacement = emptyLayout();
view.galleryScroll.onScroll({ scrollTop: 120, layout: replacement });
flushSync();
assert.equal(view.galleryScroll.layout, replacement);
assert.equal(view.galleryScroll.scrollTop, 120);
// Opening captures the item immediately, even if results vanish before the first render.
catalog.items = first;
flushSync();
view.openDetail(0);
catalog.items = [];
flushSync();
assert.equal(view.detailItem?.id, "first", "viewer survives results disappearing before render");
assert.equal(view.detailIndex, null);
view.dismissSelectionOrDetail();
flushSync();
assert.equal(view.detailItem, undefined, "Escape closes a retained viewer with no result index");
catalog.items = latest;
flushSync();
view.openDetail(0);
view.showNextDetail();
flushSync();
assert.equal(view.detailItem?.id, "second", "navigation captures the next item");
ocrSearch.composerOpen = true;
flushSync();
assert.equal(view.detailItem, undefined, "opening the composer explicitly dismisses the viewer");
view.openDetail(0);
ocrSearch.composerOpen = false;
flushSync();
assert.equal(view.detailItem?.id, "first", "closing the composer does not close the viewer");
view.dispose();
ocrSearch.composerOpen = true;
assert.equal(view.detailItem?.id, "first", "disposed view no longer receives navigation actions");
stop();
console.log("Library reactivity checks passed");

// The viewer owns one history entry: UI close drops it, Back closes the viewer.
const historyApp = createApplication();
historyApp.services.catalog.items = latest;
let historyView!: LibraryViewController;
const stopHistory = $effect.root(() => {
  historyView = createLibraryViewController(historyApp, () => {});
});
flushSync();
browser.flush();
const baseIndex = browser.index;
historyView.openDetail(0);
historyView.showNextDetail();
assert.equal(browser.index, baseIndex + 1, "navigating inside the viewer adds no entries");
historyView.closeDetail();
historyView.openDetail(1);
browser.flush();
await Promise.resolve();
assert.equal(browser.index, baseIndex + 1, "reopening during the pending Back keeps one entry");
assert.equal(
  historyView.detailItem?.id,
  "second",
  "the pending Back does not close the reopened image",
);
historyView.detailStatus = { loading: true } as NonNullable<LibraryViewController["detailStatus"]>;
browser.back();
browser.flush();
flushSync();
assert.equal(historyView.detailItem, undefined, "user Back closes the current viewer");
assert.equal(historyView.detailStatus, null, "Back also clears the closed image's status");
await tick();
browser.flush();
assert.equal(browser.index, baseIndex, "Back leaves no entry to re-push");
historyView.dispose();
stopHistory();
