import { svelte } from "@sveltejs/vite-plugin-svelte";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

import type { GalleryItem, GallerySection } from "../src/renderer/src/lib/gallery/types.ts";
import type { OcrSearchController as Controller } from "../src/renderer/src/lib/ocr-search.svelte.ts";
import type { SearchRequest, SearchResponse } from "../src/shared/backend.ts";

// Synthetic results test interaction contracts, not CLIP quality or model calibration.
const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-all-search-tests",
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [svelte()],
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
after(() => vite.close());
const { OcrSearchController } = (await vite.ssrLoadModule(
  "/src/renderer/src/lib/ocr-search.svelte.ts",
)) as { OcrSearchController: typeof Controller };
const { buildLayout } = await vite.ssrLoadModule("/src/renderer/src/lib/gallery/layout.ts");
const { recyclePool } = await vite.ssrLoadModule("/src/renderer/src/lib/gallery/tile-pool.ts");
const pause = (ms = 450): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
function items(count = 8): GalleryItem[] {
  return Array.from(
    { length: count },
    (_, index) =>
      ({
        id: String(index + 1),
        displayName: index === 1 ? "needle.jpg" : `photo${index}.jpg`,
        width: 100,
        height: 80,
        aspectRatio: 1.25,
        date: Date.parse("2026-06-01") - index * 86400000,
      }) as GalleryItem,
  );
}
function response(ids: string[]): SearchResponse {
  return {
    total: ids.length,
    results: ids.map((assetId, index) => ({
      assetId,
      snippet: "needle",
      rank: index + 1,
      distance: index / ids.length,
    })),
  };
}
function fixture(): {
  search: Controller;
  requests: SearchRequest[];
  fileRequests: SearchRequest[];
  complete: (lane: string, result: SearchResponse | Error) => void;
  cancellations: () => number;
} {
  const requests: SearchRequest[] = [];
  const fileRequests: SearchRequest[] = [];
  const pending = new Map<
    string,
    { resolve: (value: SearchResponse) => void; reject: (error: Error) => void }
  >();
  let cancellations = 0;
  globalThis.window = {
    nicegal: {
      backend: {
        cancelSearch: async () => {
          cancellations += 1;
        },
        getTextEmbeddingCoverage: async () => ({ indexed: 8, embedded: 8 }),
        searchOcr: (request: SearchRequest) => {
          if (request.type === "name") {
            fileRequests.push(request);
            const snippet = request.query === "OR_" ? "Before OR_after.jpg" : "needle.jpg";
            const ids = request.query === "needle" || request.query === "OR_" ? ["2"] : [];
            return Promise.resolve({
              total: ids.length,
              results: ids.map((assetId, index) => ({ assetId, snippet, rank: index + 1 })),
            });
          }
          requests.push(request);
          return new Promise<SearchResponse>((resolve, reject) =>
            pending.set(request.searchLane!, { resolve, reject }),
          );
        },
      },
    },
  } as unknown as Window & typeof globalThis;
  return {
    search: new OcrSearchController(),
    requests,
    fileRequests,
    cancellations: () => cancellations,
    complete: (lane, result) => {
      const task = pending.get(lane)!;
      assert.ok(task, lane);
      if (result instanceof Error) task.reject(result);
      else task.resolve(result);
    },
  };
}

test("All publishes fast results, independent lanes, top-ten related tail and deduplicated groups", async () => {
  const f = fixture();
  const catalog = items();
  f.search.query = "needle";
  f.search.schedule(1, catalog, "modified");
  await pause(240);
  assert.deepEqual(
    f.requests.map((request) => request.searchLane),
    ["literal"],
  );
  assert.equal(f.fileRequests[0]?.type, "name");
  f.complete("literal", response(["1"]));
  await pause(5);
  assert.deepEqual(
    f.search.apply(catalog).items.map((item) => item.id),
    ["1", "2"],
  );
  assert.equal(f.search.pending, true);
  assert.equal(f.search.displaySnippets.get("2"), "needle.jpg");
  await pause(320);
  assert.equal(new Set(f.requests.map((request) => request.searchSession)).size, 1);
  assert.equal(f.requests.find((request) => request.searchLane === "meaning")?.limit, 10);
  f.complete("visual", response(["8", "7", "6", "5", "4", "3", "2", "1"]));
  await pause(5);
  assert.equal(
    f.search.pending,
    true,
    "visual completion cannot clear another lane's pending state",
  );
  f.complete("meaning", response(["3", "1", "4", "5", "6", "7", "8", "2"]));
  await pause(5);
  const view = f.search.apply(catalog);
  assert.equal(f.search.pending, false);
  assert.deepEqual(
    view.items.map((item) => item.id),
    ["1", "2", "3", "4", "5", "6", "7", "8"],
  );
  assert.deepEqual(
    view.sections?.map((section) => section.count),
    [8],
  );
  assert.equal(view.sources?.get("1"), "Names and text, Visual results");
  assert.equal(f.search.displaySnippets.get("1"), "needle", "All keeps literal OCR excerpts");
  assert.equal(
    f.search.displaySnippets.get("3"),
    "needle",
    "All also exposes admitted related-text excerpts",
  );
  const before = f.requests.length;
  f.search.sortMode = "date";
  f.search.minMatchPercentile = 100;
  const dated = f.search.apply(catalog);
  assert.equal(dated.sections, undefined);
  assert.deepEqual(
    dated.items.map((item) => item.id),
    ["1", "2", "3", "4", "5", "6", "7", "8"],
  );
  assert.equal(f.search.sliderLabel, "Visual similarity");
  assert.equal(f.search.sliderApplicable, true);
  f.search.minMatchPercentile = 0;
  assert.equal(f.search.apply(catalog).items.length, 8);
  f.search.sortMode = "relevance";
  f.search.minMatchPercentile = 100;
  assert.equal(f.search.apply(catalog).items.length, 8, "CLIP is unfiltered in Relevance");
  assert.equal(f.requests.length, before, "presentation changes reuse responses");
  f.search.dispose();
});

test("All omits empty sections while searching and after results are filtered to the catalog", async () => {
  const f = fixture();
  const catalog = items();
  f.search.query = "unmatched";
  f.search.schedule(1, catalog, "modified");
  await pause();
  assert.deepEqual(f.search.apply(catalog).sections, []);
  f.complete("literal", response([]));
  f.complete("meaning", response([]));
  f.complete("visual", response(["8", "missing"]));
  await pause(5);
  const view = f.search.apply(catalog);
  assert.deepEqual(
    view.sections?.map(({ key, start, count }) => ({ key, start, count })),
    [{ key: "visual", start: 0, count: 1 }],
  );
  const empty = f.search.apply(catalog.filter((item) => item.id !== "8"));
  assert.equal(empty.matchTotal, 0);
  assert.deepEqual(empty.sections, []);
  for (const mode of ["grid", "masonry", "justified"]) {
    assert.equal(buildLayout(empty.items, 800, { mode }, empty.sections).dividers.length, 0);
  }
  f.search.dispose();
});

test("All keeps text search but skips visual text requests for an image-only model", async () => {
  const f = fixture();
  const catalog = items();
  f.search.query = "needle";
  f.search.schedule(1, catalog, "modified", false);
  await pause();
  assert.deepEqual(
    f.requests.map((request) => request.searchLane),
    ["literal", "meaning"],
  );
  f.complete("literal", response(["1"]));
  f.complete("meaning", response(["3"]));
  await pause(5);
  assert.equal(f.search.pending, false);
  assert.deepEqual(
    f.search.apply(catalog).items.map((item) => item.id),
    ["1", "2", "3"],
  );
  f.search.dispose();
});

test("All caps related text at ten hits and appends it inside the literal section", async () => {
  const f = fixture();
  const catalog = items(30);
  f.search.query = "needle";
  f.search.schedule(1, catalog, "modified");
  await pause();
  f.complete("literal", response(["30"]));
  f.complete("meaning", response(catalog.map((item) => item.id)));
  f.complete("visual", response([]));
  await pause(5);
  const view = f.search.apply(catalog);
  assert.deepEqual(
    view.sections?.map((section) => section.key),
    ["literal"],
  );
  assert.deepEqual(
    view.items.map((item) => item.id),
    ["30", "2", "1", "3", "4", "5", "6", "7", "8", "9", "10"],
  );
  assert.equal(f.search.displaySnippets.has("11"), false);
  assert.equal(view.sources?.get("2"), "Names and text");
  assert.equal(view.sections?.[0].status, "");
  f.search.dispose();
});

test("filename captions share the OCR pool, highlight literal names, and clear with the query", async () => {
  const f = fixture();
  const catalog = items(2);
  catalog[1].displayName = "Before OR_after.jpg";
  f.search.query = "name: OR_";
  f.search.schedule(1, catalog, "modified");
  await pause(240);
  assert.equal(f.requests.length, 0);
  assert.equal(f.search.displaySnippets.get("2"), "Before OR_after.jpg");
  const matching = f.search.apply(catalog).items;
  const request = {
    items: matching,
    layout: buildLayout(matching, 500),
    start: 0,
    end: 1,
    poolSize: 10,
    devicePixelRatio: 1,
    snippets: f.search.displaySnippets,
    snippetTerms: [],
    snippetTermsKey: "OR_",
    filenameQuery: "OR_",
  };
  const tiles = recyclePool({ ...request, tiles: [] });
  assert.equal(tiles[0].alt, "Before OR_after.jpg");
  assert.deepEqual(
    tiles[0].snippetSegments.filter((part) => part.hit).map((part) => part.text),
    ["OR_"],
  );
  assert.equal(recyclePool({ ...request, tiles })[0].snippetSegments, tiles[0].snippetSegments);
  f.search.query = "";
  f.search.schedule(1, catalog, "modified");
  assert.equal(f.search.displaySnippets.size, 0);
  const cleared = recyclePool({
    ...request,
    tiles,
    snippets: f.search.displaySnippets,
    filenameQuery: "",
    snippetTermsKey: "",
  });
  assert.equal(cleared[0].snippetSegments, undefined);
  f.search.query = "OR_";
  f.search.schedule(1, catalog, "modified");
  await pause(240);
  f.complete("literal", {
    total: 1,
    results: [{ assetId: "2", snippet: "OCR excerpt OR_", rank: 1, distance: 0 }],
  });
  await pause(5);
  assert.equal(f.search.displaySnippets.get("2"), "OCR excerpt OR_");
  f.search.dispose();
});

test("long filename excerpts keep the matching portion visible", async () => {
  const { segmentFilename } = await vite.ssrLoadModule(
    "/src/renderer/src/lib/gallery/snippet-highlight.ts",
  );
  const name = `${"prefix_".repeat(30)}Target-name.jpg`;
  const segments = segmentFilename(name, "target-name");
  assert.equal(segments[0].text.startsWith("…"), true);
  assert.deepEqual(
    segments.filter((part) => part.hit).map((part) => part.text),
    ["Target-name"],
  );
  assert(segments.map((part) => part.text).join("").length < name.length);
});

test("clear cancels immediately and late lane results cannot refill the gallery", async () => {
  const f = fixture();
  const catalog = items();
  f.search.query = "needle";
  f.search.schedule(1, catalog, "modified");
  await pause();
  f.search.query = "";
  f.search.schedule(1, catalog, "modified");
  assert.equal(f.cancellations(), 2);
  for (const lane of ["literal", "meaning", "visual"]) f.complete(lane, response(["1"]));
  await pause(5);
  assert.equal(f.search.pending, false);
  assert.equal(f.search.apply(catalog).sections, undefined);
  assert.equal(f.search.apply(catalog).items.length, catalog.length);
  f.search.dispose();
});

test("a lane failure preserves siblings and commits wait until pointer interaction ends", async () => {
  const f = fixture();
  const catalog = items();
  f.search.query = "needle";
  f.search.schedule(1, catalog, "modified");
  await pause();
  f.search.setInteracting(true);
  f.complete("visual", response(["8"]));
  f.complete("meaning", new Error("Model unavailable"));
  f.complete("literal", response(["1"]));
  await pause(5);
  assert.deepEqual(
    f.search.apply(catalog).items.map((item) => item.id),
    ["2"],
  );
  assert.equal(f.search.pending, true);
  f.search.setInteracting(false);
  await pause(5);
  assert.deepEqual(
    f.search.apply(catalog).items.map((item) => item.id),
    ["1", "2", "8"],
  );
  assert.match(f.search.apply(catalog).sections![0].status!, /Model unavailable/);
  assert.equal(f.search.pending, false);
  f.search.dispose();
});

test("date constraints reach all lanes; no frontend top-500 cutoff remains", async () => {
  const f = fixture();
  const catalog = items(700);
  f.search.query = "needle during:2026";
  f.search.schedule(1, catalog, "modified");
  await pause();
  for (const request of f.requests) {
    assert.ok(request.after);
    assert.ok(request.before);
    assert.equal(request.timeline, "modified");
  }
  for (const lane of ["literal", "meaning", "visual"])
    f.complete(lane, response(catalog.map((item) => item.id)));
  await pause(5);
  assert.ok(
    f.search.apply(catalog).items.every((item) => new Date(item.date).getFullYear() === 2026),
  );
  f.search.query = "like: needle";
  f.search.schedule(1, catalog, "modified");
  await pause(240);
  f.complete("literal", response(catalog.map((item) => item.id)));
  await pause(5);
  assert.equal(f.search.apply(catalog).items.length, 700);
  f.search.query = "meaning: needle";
  assert.equal(f.search.minMatchPercentile, 95);
  f.search.dispose();
});

test("section layouts preserve indices and range indexes in all three modes, including empty headings", () => {
  const catalog = items();
  const sections: GallerySection[] = [
    { key: "literal", label: "Names and text", start: 0, count: 0 },
    { key: "meaning", label: "Related text", start: 0, count: 3 },
    { key: "visual", label: "Visual results", start: 3, count: 5 },
  ];
  for (const mode of ["grid", "masonry", "justified"]) {
    const layout = buildLayout(catalog, 800, { mode, granularity: "month" }, sections);
    assert.equal(layout.dividers.length, 3);
    assert.deepEqual(
      layout.positions.map((position: { index: number }) => position.index),
      [0, 1, 2, 3, 4, 5, 6, 7],
    );
    assert.ok(layout.positions[0].y >= 52);
    assert.ok(layout.positions[3].y >= layout.dividers[2].y + 26);
    assert.ok(
      layout.positions.every(
        (position: { y: number; height: number }) => position.y + position.height <= layout.height,
      ),
    );
    for (const column of layout.columns)
      assert.deepEqual(
        column.tops,
        [...column.tops].sort((a: number, b: number) => a - b),
      );
  }
});

test("All without OCR retains filename matches alongside visual results", async () => {
  const f = fixture();
  f.search.query = "needle";
  f.search.schedule(1, items(), "modified", true, false);
  await pause();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].type, "image");
  assert.equal(f.search.allMode, true);
  f.complete(f.requests[0].searchLane!, response(["4", "3"]));
  await pause(10);
  assert.deepEqual(
    f.search.apply(items()).items.map((item) => item.id),
    ["2", "4", "3"],
  );
  assert.equal(f.search.indexNotice, "");
  f.search.query = "name: needle";
  f.search.schedule(1, items(), "modified", true, false);
  await pause(240);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(
    f.search.apply(items()).items.map((item) => item.id),
    ["2"],
  );
});

test("v2 per-root indexing choices remain readable for the library import", async () => {
  const { settingsDefaults, libraryIndexing } = await vite.ssrLoadModule(
    "/src/renderer/src/lib/settings.svelte.ts",
  );
  const stored = JSON.parse(
    JSON.stringify({
      ...settingsDefaults,
      libraryIndexing: { screenshots: { ocr: true, image: true } },
    }),
  );
  assert.deepEqual(libraryIndexing(stored, "screenshots"), { ocr: true, image: true });
  assert.deepEqual(libraryIndexing(stored, "photos"), { ocr: false, image: true });
});

test("a malformed section response cannot corrupt successful results, including deferred arrivals", async () => {
  for (const deferred of [false, true]) {
    const f = fixture();
    f.search.query = "needle";
    f.search.schedule(1, items(), "modified", true, false);
    await pause();
    f.search.setInteracting(deferred);
    f.complete("visual", { total: 10, results: null } as unknown as SearchResponse);
    await pause(5);
    f.search.setInteracting(false);
    await pause(5);
    const view = f.search.apply(items());
    assert.deepEqual(
      view.items.map((item) => item.id),
      ["2"],
    );
    assert.equal(view.sections?.[0].count, 1);
    assert.equal(view.sections?.length, 1);
    assert.match(f.search.allError, /Visual results: Invalid search response/);
    assert.equal(f.search.pending, false);
    f.search.dispose();
  }
});

const { encodeIpcError } = await vite.ssrLoadModule("/src/shared/ipc-error.ts");
/** A backend error as the renderer receives it: Electron's prefix around the coded payload. */
const ipcError = (code: string, message: string): Error =>
  new Error(
    `Error invoking remote method 'backend:search': Error: ${encodeIpcError({ code, message })}`,
  );

test("a visual model that is not ready is a setup notice, not a search error", async () => {
  const f = fixture();
  f.search.query = "like: needle";
  f.search.schedule(1, items(), "modified");
  await pause(240);
  f.complete("literal", ipcError("models_not_ready", "Image model not ready"));
  await pause(5);
  assert.equal(f.search.error, "");
  assert.equal(f.search.setupNotice, "Visual search isn't ready for this library yet.");
  assert.equal(f.search.imageSetupRequired, true);
  f.search.dispose();
});

test("collapsed sections preserve counts and dense layout indices in every layout", async () => {
  const { collapseSearchSections } = await vite.ssrLoadModule(
    "/src/renderer/src/lib/gallery/search-sections.ts",
  );
  const original = {
    items: items(),
    matchTotal: 8,
    filtering: true,
    sections: [
      { key: "literal", label: "Names and text", start: 0, count: 3 },
      { key: "visual", label: "Visual results", start: 3, count: 5 },
    ],
  };
  for (const hidden of [["literal"], ["visual"], ["literal", "visual"]]) {
    const view = collapseSearchSections(original, new Set(hidden));
    assert.equal(view.matchTotal, 8);
    assert.deepEqual(
      view.sections.map((section) => section.count),
      [3, 5],
    );
    assert.equal(
      view.items.length,
      8 - (hidden.includes("literal") ? 3 : 0) - (hidden.includes("visual") ? 5 : 0),
    );
    for (const mode of ["grid", "masonry", "justified"]) {
      const layout = buildLayout(view.items, 800, { mode }, view.sections);
      assert.equal(layout.dividers.length, 2);
      assert.equal(layout.positions.length, view.items.length);
      assert.deepEqual(
        layout.positions.map((position) => position.index),
        view.items.map((_, index) => index),
      );
    }
  }
  assert.equal(collapseSearchSections(original, new Set()), original);
});

test("missing text coverage exposes setup state independently of library status and resets on new search", async () => {
  for (const prefix of ["ocr:", "meaning:"]) {
    const f = fixture();
    window.nicegal.backend.getTextEmbeddingCoverage = async () => ({
      indexed: 0,
      embedded: 0,
      pending: 0,
      lastIndexedAt: null,
    });
    f.search.query = `${prefix} needle`;
    f.search.schedule(1, items(), "modified");
    await pause(240);
    assert.equal(f.search.textSetupRequired, true);
    assert.equal(f.requests.length, 0);
    f.search.query = "name: needle";
    f.search.schedule(1, items(), "modified");
    assert.equal(f.search.textSetupRequired, false);
    f.search.dispose();
  }
});
