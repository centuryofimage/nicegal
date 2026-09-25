import assert from "node:assert/strict";
import { flushSync } from "svelte";

import type { GalleryItem } from "../../src/renderer/src/lib/gallery/types";
import type { JobSnapshot } from "../../src/shared/backend";

import { createApplication } from "../../src/renderer/src/lib/application.svelte";
import { emptyLayout } from "../../src/renderer/src/lib/gallery/types";
import {
  createLibraryViewController,
  type LibraryViewController,
} from "../../src/renderer/src/lib/library-view.svelte";
import { layoutOptions, settings } from "../../src/renderer/src/lib/settings.svelte";

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
view.dispose();
stop();
console.log("Library reactivity checks passed");
