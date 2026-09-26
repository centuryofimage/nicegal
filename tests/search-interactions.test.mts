import { svelte } from "@sveltejs/vite-plugin-svelte";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

import type { OcrSearchController as Controller } from "../src/renderer/src/lib/ocr-search.svelte.ts";
import type { SearchRequest } from "../src/shared/backend.ts";

const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-search-tests",
  plugins: [svelte()],
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
after(() => vite.close());
const { OcrSearchController } = (await vite.ssrLoadModule(
  "/src/renderer/src/lib/ocr-search.svelte.ts",
)) as { OcrSearchController: typeof Controller };
const { parseQuery, textWithoutFolder, withFolder, withMediaFilter, withScope } =
  await vite.ssrLoadModule("/src/renderer/src/lib/search-query.ts");

test("media and path filters compose with scopes and dates", () => {
  const parsed = parseQuery("name: cat type:video during:2026 path:trips");
  assert.equal(parsed.scope, "name");
  assert.equal(parsed.media, "video");
  assert.equal(parsed.body.trim(), "cat");
  assert.equal(parsed.path, "trips");
  assert.equal(withScope("cat type:video", "ocr"), "ocr: cat type:video");
  assert.equal(withMediaFilter("name: cat type:video", "image"), "name: cat type:image");
  assert.equal(withMediaFilter("type:video", null), "");
  const afterMedia = parseQuery("type:video like: red car during:2026");
  assert.equal(afterMedia.scope, "like");
  assert.equal(afterMedia.media, "video");
  assert.equal(afterMedia.body.trim().replace(/\s+/g, " "), "red car");
  assert.equal(withScope("type:video like: red car", "ocr"), "ocr: type:video red car");
});

test("folder focus preserves search terms and filters catalog paths at a separator", () => {
  const folder = "C:\\Photo Trips\\2026";
  const query = withFolder("name: cat type:video", folder);
  assert.equal(parseQuery(query).folder, folder);
  assert.equal(parseQuery(query).body.trim(), "cat");
  assert.equal(withFolder(query, null), "name: cat type:video");
  for (const raw of [
    `in:"${folder}" type:video cat`,
    `type:video in:"${folder}" cat`,
    `type:video cat in:"${folder}"`,
  ]) {
    const parsed = parseQuery(raw);
    assert.equal(parsed.folder, folder);
    assert.equal(textWithoutFolder(parsed.tokens), "type:video cat");
  }
  const { search, requests } = fixture();
  const catalog = [
    { id: "1", path: `${folder}\\cat.mp4`, mediaKind: "video", date: 1 },
    { id: "2", path: "C:\\Photo Trips\\2026-old\\cat.mp4", mediaKind: "video", date: 1 },
  ] as Parameters<Controller["apply"]>[0];
  search.query = `in:"${folder}" type:video`;
  search.schedule(1, catalog, "modified");
  assert.deepEqual(
    search.apply(catalog).items.map((item) => item.id),
    ["1"],
  );
  assert.deepEqual(requests, []);
  search.dispose();
});

test("folder focus reaches backend text search before its result limit", async () => {
  const { search, requests } = fixture();
  search.query = 'ocr: receipt in:"C:\\Photo Trips"';
  search.schedule(1, [], "modified", false, true, false);
  await pause();
  assert.equal(requests[0]?.folder, "C:\\Photo Trips");
  assert.equal(requests[0]?.query, '"receipt"');
  search.dispose();
});

test("media operator filters a library without search text", () => {
  const { search, requests } = fixture();
  const catalog = [
    { id: "1", mediaKind: "image", date: 1 },
    { id: "2", mediaKind: "video", date: 1 },
  ] as Parameters<Controller["apply"]>[0];
  search.query = "type:video";
  search.schedule(1, catalog, "modified");
  assert.deepEqual(
    search.apply(catalog).items.map((item) => item.id),
    ["2"],
  );
  assert.equal(search.apply(catalog).matchTotal, 1);
  assert.deepEqual(requests, []);
  search.dispose();
});

test("searching for absent media skips model queries and shows an empty result", async () => {
  const catalog = [{ id: "1", mediaKind: "image", date: 1 }] as Parameters<
    Controller["apply"]
  >[0];
  for (const query of ["type:video", "cat type:video", "like: cat type:video"]) {
    const { search, requests } = fixture();
    search.query = query;
    search.schedule(1, catalog, "modified");
    await pause();
    assert.deepEqual(requests, [], query);
    assert.equal(search.apply(catalog).matchTotal, 0, query);
    assert.equal(search.pending, false, query);
    assert.equal(search.allError, "", query);
    assert.equal(search.error, "", query);
    search.dispose();
  }
});

test("media operator narrows backend filename matches", async () => {
  const { search, requests } = fixture();
  const catalog = [
    { id: "1", displayName: "cat.jpg", mediaKind: "image", date: 1 },
    { id: "2", displayName: "cat.mp4", mediaKind: "video", date: 1 },
  ] as Parameters<Controller["apply"]>[0];
  search.query = "name: cat type:video";
  search.schedule(1, catalog, "modified");
  await pause();
  assert.deepEqual(
    search.apply(catalog).items.map((item) => item.id),
    ["2"],
  );
  assert.equal(requests[0]?.type, "name");
  search.dispose();
});

test("quoted path scope uses backend search without text model setup", async () => {
  const { search, requests } = fixture();
  const catalog = [{ id: "1", displayName: "cat.jpg", mediaKind: "image", date: 1 }] as Parameters<
    Controller["apply"]
  >[0];
  search.query = 'path:"C:\\Photo Trips\\cat.jpg"';
  search.schedule(1, catalog, "modified");
  await pause();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, "path");
  assert.equal(requests[0].query, "C:\\Photo Trips\\cat.jpg");
  assert.equal(search.textSetupRequired, false);
  search.dispose();
});

test("visual scope after a media filter sends only the description to image search", async () => {
  const { search, requests } = fixture();
  search.query = "type:video like: red car";
  const catalog = [{ id: "1", mediaKind: "video", date: 1 }] as Parameters<
    Controller["apply"]
  >[0];
  search.schedule(1, catalog, "modified", true, false, true);
  await pause();
  assert.equal(search.imageSetupRequired, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, "image");
  assert.equal(requests[0].query, "red car");
  search.dispose();
});

test("path filter stays separate from visual description", async () => {
  const { search, requests } = fixture();
  search.query = 'like: red car path:"Photo Trips"';
  search.schedule(1, [], "modified", true, false, true);
  await pause();
  assert.equal(requests[0]?.type, "image");
  assert.equal(requests[0]?.query, "red car");
  assert.equal(requests[0]?.pathContains, "Photo Trips");
  search.dispose();
});

test("visual search waits for image coverage, then runs the unchanged query when ready", async () => {
  const { search, requests } = fixture();
  search.query = "like: cat";
  search.schedule(1, [], "modified", true, false, false);
  await pause();
  assert.equal(requests.length, 0);
  assert.equal(search.imageSetupRequired, true);
  assert.match(search.setupNotice, /isn't ready/);
  search.schedule(1, [], "modified", true, false, true);
  await pause();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, "image");
  assert.equal(search.imageSetupRequired, false);
  search.dispose();
});

test("adding a library creates it with the default search types and scans its folders", async () => {
  const { createApplication } = await vite.ssrLoadModule(
    "/src/renderer/src/lib/application.svelte.ts",
  );
  const created: unknown[] = [];
  const started: unknown[] = [];
  const library = {
    id: 5,
    include: [
      { path: "C:/new-pictures", scanPending: true, scanError: null, lastScanCompletedNs: null },
    ],
    exclude: [],
    ocr: false,
    image: true,
  };
  globalThis.window = {
    nicegal: {
      backend: {
        startJob: async (request: { params: { libraryId: number } }) => {
          started.push(request);
          return {
            jobId: "scan",
            libraryId: request.params.libraryId,
            type: "libraryScan",
            status: "running",
            phase: "scanning",
            progress: { cataloged: 0, thumbnailsGenerated: 0 },
            errors: [],
          };
        },
        createLibrary: async (request: unknown) => {
          created.push(request);
          return library;
        },
        listLibraries: async () => [],
        listJobs: async () => ({ activeJobId: null, jobs: [] }),
        subscribeJob: () => () => {},
        getCatalogRevision: async () => "1",
        listAssets: async () => [],
      },
    },
  } as unknown as Window & typeof globalThis;
  const app = createApplication();
  app.services.catalog.backendStatus = { ready: true, error: null };
  await app.commands.createLibrary("C:/new-pictures");
  assert.deepEqual(created, [
    { include: ["C:/new-pictures"], exclude: [], ocr: false, image: true },
  ]);
  assert.equal(app.services.catalog.selectedId, 5);
  assert.deepEqual(started, [
    { type: "libraryScan", params: { libraryId: 5, scanMode: "fast", pendingOnly: true } },
  ]);
  assert.equal(app.services.jobs.scanState(5), "scanning");
  app.services.jobs.dispose();
  app.services.ocrSearch.dispose();
});

test("adding an existing folder is blocked before creating another library", async () => {
  const { createApplication } = await vite.ssrLoadModule(
    "/src/renderer/src/lib/application.svelte.ts",
  );
  let creates = 0;
  globalThis.window = {
    nicegal: {
      backend: {
        listLibraries: async () => [
          {
            id: 3,
            include: [
              { path: "C:/Photos", scanPending: false, scanError: null, lastScanCompletedNs: null },
            ],
            exclude: [],
            ocr: false,
            image: true,
          },
        ],
        createLibrary: async () => {
          creates += 1;
        },
        getCatalogRevision: async () => "1",
        listAssets: async () => [],
      },
    },
  } as unknown as Window & typeof globalThis;
  const app = createApplication();
  app.services.catalog.backendStatus = { ready: true, error: null };
  await assert.rejects(app.commands.createLibrary("C:\\Photos\\"), /already in/);
  assert.equal(creates, 0);
  app.services.jobs.dispose();
  app.services.ocrSearch.dispose();
});

test("switching libraries stops the old library's scan and scans the new one's pending folders", async () => {
  const { createApplication } = await vite.ssrLoadModule(
    "/src/renderer/src/lib/application.svelte.ts",
  );
  const started: unknown[] = [];
  const cancelled: string[] = [];
  const library = (id: number): Record<string, unknown> => ({
    id,
    include: [{ path: `C:/${id}`, scanPending: false, scanError: null, lastScanCompletedNs: null }],
    exclude: [],
    ocr: false,
    image: true,
  });
  globalThis.window = {
    nicegal: {
      backend: {
        startJob: async (request: { params: { libraryId: number } }) => {
          started.push(request);
          return {
            jobId: String(request.params.libraryId),
            libraryId: request.params.libraryId,
            type: "libraryScan",
            status: "running",
            phase: "scanning",
            progress: { cataloged: 0, thumbnailsGenerated: 0 },
            errors: [],
          };
        },
        cancelJob: async (id: string) => {
          cancelled.push(id);
          return { jobId: id, type: "libraryScan", status: "cancelling", errors: [], progress: {} };
        },
        listLibraries: async () => [library(1), library(2)],
        listJobs: async () => ({ activeJobId: null, jobs: [] }),
        subscribeJob: () => () => {},
        getCatalogRevision: async () => "1",
        listAssets: async () => [],
      },
    },
  } as unknown as Window & typeof globalThis;
  const app = createApplication();
  const { catalog, orchestrator } = app.services;
  catalog.backendStatus = { ready: true, error: null };
  await catalog.loadLibraries();
  assert.equal(catalog.selectedId, 1, "a first load selects the first library");
  await orchestrator.scan(1);
  await catalog.selectLibrary(2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(cancelled, ["1"]);
  assert.deepEqual(started.at(-1), {
    type: "libraryScan",
    params: { libraryId: 2, scanMode: "fast", pendingOnly: true },
  });
  app.commands.beginDeferringScans();
  await catalog.selectLibrary(1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started.length, 2, "switching inside management does not start a scan");
  app.commands.endDeferringScans();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started.at(-1), {
    type: "libraryScan",
    params: { libraryId: 1, scanMode: "fast" },
  });
  app.services.jobs.dispose();
  app.services.ocrSearch.dispose();
});

const photo = { id: "1", displayName: "cat.jpg" };
const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

test("visual file picker results belong to the search session that opened it", async () => {
  const { chooseVisualFile } = await vite.ssrLoadModule(
    "/src/renderer/src/lib/visual-search-input.ts",
  );
  const { search } = fixture();
  search.query = "like: cat";
  let resolvePicker!: (value: { displayName: string; bytesBase64: string }) => void;
  window.nicegal.native = {
    chooseVisualSearchImage: () =>
      new Promise((resolve) => {
        resolvePicker = resolve;
      }),
  } as typeof window.nicegal.native;
  const pending = chooseVisualFile(search);
  search.query = "name: dog";
  resolvePicker({ displayName: "example.jpg", bytesBase64: "aW1hZ2U=" });
  await pending;
  assert.equal(search.query, "name: dog");
  assert.equal(
    search.visualReferences.length,
    0,
    "late picker results cannot reopen visual search",
  );

  search.query = "like:";
  const current = chooseVisualFile(search);
  resolvePicker({ displayName: "example.jpg", bytesBase64: "aW1hZ2U=" });
  await current;
  assert.equal(search.visualReferences.length, 1);
  search.dispose();
});

function fixture(): { search: Controller; requests: SearchRequest[] } {
  const requests: SearchRequest[] = [];
  globalThis.window = {
    nicegal: {
      backend: {
        getTextEmbeddingCoverage: async () => ({ indexed: 1, embedded: 1 }),
        searchOcr: async (request: SearchRequest) => {
          requests.push(request);
          if (request.type === "name")
            return {
              total: 2,
              results: [
                { assetId: "1", snippet: "cat.jpg", rank: 1 },
                { assetId: "2", snippet: "cat.mp4", rank: 2 },
              ],
            };
          assert.ok(
            request.query.trim() || request.imageQuery?.components.length,
            "never submit an empty search",
          );
          return { results: [], total: 0 };
        },
      },
    },
  } as unknown as Window & typeof globalThis;
  return { search: new OcrSearchController(), requests };
}

test("adding images activates Looks like, opens the composer, and deduplicates repeated additions", () => {
  const { search } = fixture();
  search.query = "name: cat during:2026";
  search.addLibraryReferences([photo]);
  assert.equal(search.query, "like: cat during:2026");
  assert.equal(search.composerOpen, true);
  search.composerOpen = false;
  search.addLibraryReferences([photo]);
  assert.equal(search.visualReferences.length, 1);
  assert.equal(search.composerOpen, true);
});

test("closing preserves terms; clearing and every nonvisual scope discard images and open state", () => {
  for (const query of ["", " ", "name:", "ocr:", "meaning:", "cat"]) {
    const { search } = fixture();
    search.addLibraryReferences([photo]);
    search.composerOpen = false;
    assert.equal(search.visualReferences.length, 1);
    search.composerOpen = true;
    const revision = search.visualSessionRevision;
    search.query = query;
    assert.equal(search.visualReferences.length, 0, query);
    assert.equal(search.composerOpen, false, query);
    assert.ok(search.visualSessionRevision > revision);
    search.query = "like:";
    assert.equal(search.composerOpen, false);
    assert.equal(search.visualReferences.length, 0);
  }
});

test("Search Like This Image replaces descriptions, dates, weights and old image examples", () => {
  const { search } = fixture();
  search.query = "like: 2:cat - dog during:2026";
  search.addLibraryReferences([photo]);
  search.setVisualReferences(
    search.visualReferences.map((reference) => ({ ...reference, polarity: "less", strength: 3 })),
  );
  search.addLibraryReferences([photo], true);
  assert.equal(search.query, "like:");
  assert.equal(search.visualReferences.length, 1);
  assert.equal(search.visualReferences[0].polarity, "more");
  assert.equal(search.visualReferences[0].strength, 1);
  assert.equal(search.composerOpen, true);
});

test("clear and scope changes cancel a queued image search without sending empty text requests", async () => {
  for (const query of ["", "name:", "ocr:", "meaning:", "like:"]) {
    const { search, requests } = fixture();
    search.addLibraryReferences([photo]);
    search.schedule("library", [], "modified");
    search.query = query;
    if (query === "like:") search.setVisualReferences([]);
    search.schedule("library", [], "modified");
    await pause();
    assert.deepEqual(requests, [], query);
    assert.equal(search.pending, false);
    assert.equal(search.error, "");
    search.dispose();
  }
});

test("image-only searches submit components; removing the final row keeps the editor open without searching", async () => {
  const { search, requests } = fixture();
  search.addLibraryReferences([photo]);
  search.schedule("library", [], "modified");
  await pause();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, "image");
  assert.deepEqual(requests[0].imageQuery?.components, [{ assetId: 1, weight: 1 }]);
  search.setVisualReferences([]);
  search.schedule("library", [], "modified");
  await pause();
  assert.equal(requests.length, 1);
  assert.equal(search.composerOpen, true);
  assert.equal(search.error, "");
  search.dispose();
});

test("partial weighted expressions do not send empty compositions", async () => {
  const { search, requests } = fixture();
  search.query = "like: 2:";
  search.schedule("library", [], "modified");
  await pause();
  assert.deepEqual(requests, []);
  assert.equal(search.pending, false);
  search.dispose();
});
