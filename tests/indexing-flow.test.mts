import { svelte } from "@sveltejs/vite-plugin-svelte";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

import type { CatalogController as Catalog } from "../src/renderer/src/lib/catalog.svelte.ts";
import type { JobOrchestrator as Orchestrator } from "../src/renderer/src/lib/job-orchestrator.svelte.ts";
import type { JobTracker } from "../src/renderer/src/lib/job-tracker.svelte.ts";
import type {
  CreateLibraryRequest,
  JobListResponse,
  JobRequest,
  JobSnapshot,
  Library,
} from "../src/shared/backend.ts";

// Compile the actual rune module with the project's existing Svelte/Vite tools. Middleware mode
// opens no listening socket and never connects to Electron or the user's backend.
const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-indexing-tests",
  plugins: [svelte()],
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
after(() => vite.close());
const { JobOrchestrator } = (await vite.ssrLoadModule(
  "/src/renderer/src/lib/job-orchestrator.svelte.ts",
)) as { JobOrchestrator: typeof Orchestrator };
const { JobTracker: Tracker } = (await vite.ssrLoadModule(
  "/src/renderer/src/lib/job-tracker.svelte.ts",
)) as { JobTracker: new (...args: unknown[]) => JobTracker };
const { CatalogController } = (await vite.ssrLoadModule(
  "/src/renderer/src/lib/catalog.svelte.ts",
)) as { CatalogController: new () => Catalog };
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { visibilityState: "visible" },
});

function snapshot(
  type: JobSnapshot["type"],
  status: JobSnapshot["status"],
  jobId = "1",
  libraryId?: number,
): JobSnapshot {
  return {
    jobId,
    type,
    status,
    ...(libraryId === undefined ? {} : { libraryId }),
    phase: status === "completed" ? "finished" : "queued",
    errors: [],
    progress: { cataloged: 0 } as JobSnapshot["progress"],
  };
}

function library(id: number, path: string): Library {
  return {
    id,
    include: [{ path, scanPending: false, scanError: null, lastScanCompletedNs: null }],
    exclude: [],
    ocr: false,
    image: true,
  };
}

function fixture(responses: JobSnapshot[]): {
  orchestrator: Orchestrator;
  jobs: { running: boolean; active: JobSnapshot | null; cancelledAll: number };
  requests: JobRequest[];
} {
  storage.clear();
  const requests: JobRequest[] = [];
  const jobs = {
    running: false,
    error: "",
    cancelledAll: 0,
    active: null as JobSnapshot | null,
    async start(request: JobRequest): Promise<JobSnapshot> {
      requests.push(request);
      const result = responses.shift();
      assert.ok(result, "unexpected extra job request");
      this.active = result;
      this.running = result.status === "running";
      if (result.status === "completed" || result.status === "failed")
        orchestrator.handleTerminalJob(result);
      return result;
    },
    async cancelAll(): Promise<void> {
      this.cancelledAll++;
      this.running = false;
    },
  };
  globalThis.window = { nicegal: { backend: {} } } as unknown as Window & typeof globalThis;
  const orchestrator = new JobOrchestrator(jobs as unknown as JobTracker, async () => {});
  return { orchestrator, jobs, requests };
}

test("automatic scans request fast mode; explicit full and other options are forwarded", async () => {
  const f = fixture([
    snapshot("libraryScan", "completed", "1", 3),
    snapshot("libraryScan", "completed", "2", 3),
    snapshot("libraryScan", "completed", "3", 3),
  ]);
  await f.orchestrator.scan(3);
  await f.orchestrator.scan(3, { pendingOnly: true });
  await f.orchestrator.scan(3, { scanMode: "full", retryFailed: true });
  assert.deepEqual(
    f.requests.map((request) => request.params),
    [
      { libraryId: 3, scanMode: "fast" },
      { libraryId: 3, scanMode: "fast", pendingOnly: true },
      { libraryId: 3, scanMode: "full", retryFailed: true },
    ],
  );
});

test("a provider fallback during a scan shows recovery until the backend returns", () => {
  const f = fixture([]);
  f.jobs.active = snapshot("libraryScan", "running", "1", 3);
  assert.equal(f.orchestrator.backendDisconnected(true), true);
  assert.equal(f.orchestrator.restartingIndex, true);
  f.orchestrator.backendReady();
  assert.equal(f.orchestrator.restartingIndex, false);
  assert.deepEqual(f.requests, [], "application recovery requests pending folders after reconnect");
});

test("an ordinary crash, or a fallback with no scan running, shows no recovery", () => {
  const f = fixture([]);
  f.jobs.active = snapshot("libraryScan", "running", "1", 3);
  assert.equal(f.orchestrator.backendDisconnected(false), false);
  f.jobs.active = snapshot("thumbnailGenerate", "running", "2", 3);
  assert.equal(f.orchestrator.backendDisconnected(true), false);
});

test("Stop cancels the active job and every queued scan", async () => {
  const f = fixture([]);
  f.jobs.active = snapshot("libraryScan", "running", "1", 3);
  f.orchestrator.backendDisconnected(true);
  await f.orchestrator.cancel();
  assert.equal(f.jobs.cancelledAll, 1);
  assert.equal(f.orchestrator.restartingIndex, false);
});

for (const loaded of [null, { executionProvider: "cpu" }]) {
  test(`Stop during model-state lookup prevents preparation (loaded=${Boolean(loaded)})`, async () => {
    const f = fixture([]);
    const reply = Promise.withResolvers<unknown>();
    Object.assign(window.nicegal.backend, { getOcrModels: () => reply.promise });
    const preparing = f.orchestrator.prepareSearchModels();
    await f.orchestrator.cancel();
    reply.resolve({ loaded });
    await preparing;
    assert.deepEqual(f.requests, []);
    assert.equal(f.orchestrator.preparingSearchModels, false);
  });
}

for (const status of ["completed", "failed", "cancelled"] as const) {
  test(`immediately ${status} thumbnail job clears the resume record`, async () => {
    const f = fixture([snapshot("thumbnailGenerate", status)]);
    const request = { type: "thumbnailGenerate", params: { libraryId: 3 } } as const;
    storage.set("nicegal.jobResume.v1", JSON.stringify({ libraryId: 3, request }));
    await f.orchestrator.startResumableJob(request);
    assert.equal(storage.has("nicegal.jobResume.v1"), false);
  });
}

test("running thumbnail job remains resumable until its terminal snapshot", async () => {
  const f = fixture([snapshot("thumbnailGenerate", "running")]);
  await f.orchestrator.startResumableJob({ type: "thumbnailGenerate", params: { libraryId: 3 } });
  assert.equal(storage.has("nicegal.jobResume.v1"), true);
  f.orchestrator.handleTerminalJob(snapshot("thumbnailGenerate", "completed"));
  assert.equal(storage.has("nicegal.jobResume.v1"), false);
});

test("an interrupted thumbnail job resumes only for its own library", async () => {
  const f = fixture([snapshot("thumbnailGenerate", "running")]);
  const request = { type: "thumbnailGenerate", params: { libraryId: 3 } } as const;
  storage.set("nicegal.jobResume.v1", JSON.stringify({ libraryId: 3, request }));
  await f.orchestrator.resumeInterruptedJob(4);
  assert.deepEqual(f.requests, []);
  await f.orchestrator.resumeInterruptedJob(3);
  assert.deepEqual(f.requests, [request]);
});

function trackerBackend(overrides: Record<string, unknown>): void {
  globalThis.window = {
    nicegal: {
      backend: {
        subscribeJob: () => () => {},
        cancelJob: async (id: string) => snapshot("libraryScan", "cancelled", id),
        listJobs: async (): Promise<JobListResponse> => ({ activeJobId: null, jobs: [] }),
        ...overrides,
      },
    },
  } as unknown as Window & typeof globalThis;
}

test("a scan requested while a job runs is listed as queued, not followed", async () => {
  const started: JobSnapshot[] = [
    snapshot("thumbnailGenerate", "running", "1", 3),
    snapshot("libraryScan", "queued", "2", 4),
  ];
  trackerBackend({ startJob: async () => started.shift() });
  const tracker = new Tracker(
    () => {},
    () => {},
    () => {},
  );
  await tracker.start({ type: "thumbnailGenerate", params: { libraryId: 3 } });
  assert.equal(
    await tracker.start({ type: "thumbnailGenerate", params: { libraryId: 3 } }),
    null,
    "other job types still wait for the slot",
  );
  await tracker.start({ type: "libraryScan", params: { libraryId: 4 } });
  assert.equal(tracker.active?.jobId, "1");
  assert.equal(tracker.libraryId, 3);
  assert.equal(tracker.scanState(4), "queued");
  assert.equal(tracker.scanState(3), null);
  tracker.dispose();
});

test("only failures and new file errors keep a finished job in the toolbar", async () => {
  let send: (snapshot: JobSnapshot) => void = () => {};
  let nextId = 0;
  trackerBackend({
    startJob: async () => snapshot("libraryScan", "running", String(++nextId), 3),
    subscribeJob: (_id: string, onSnapshot: (snapshot: JobSnapshot) => void) => {
      send = onSnapshot;
      return () => {};
    },
  });
  const tracker = new Tracker(
    () => {},
    () => {},
    () => {},
  );
  const finish = async (errors: JobSnapshot["errors"]): Promise<void> => {
    await tracker.start({ type: "libraryScan", params: { libraryId: 3 } });
    send({ ...snapshot("libraryScan", "completed", String(nextId), 3), errors });
  };
  const unreadable = [{ path: "D:\\a.jpg", message: "unreadable" }];

  await finish([]);
  assert.equal(tracker.active, null, "a clean result goes straight to the status bar");
  assert.match(tracker.completionMessage, /^Scanned/);

  await finish(unreadable);
  assert.equal(tracker.active?.errors.length, 1, "a new file error stays until dismissed");
  tracker.dismiss();

  await finish(unreadable);
  assert.equal(tracker.active, null, "the same error after dismissal does not return");
  assert.match(tracker.completionMessage, /1 known file error$/);

  await finish([...unreadable, { path: "D:\\b.jpg", message: "unreadable" }]);
  assert.equal(tracker.active?.errors.length, 2, "one new error brings the job back");
  tracker.dispose();
});

test("sync follows a scan the backend started and refreshes the queue", async () => {
  let list: JobListResponse = {
    activeJobId: "7",
    jobs: [snapshot("libraryScan", "running", "7", 3), snapshot("libraryScan", "queued", "8", 4)],
  };
  const subscribed: string[] = [];
  trackerBackend({
    listJobs: async () => list,
    subscribeJob: (id: string) => {
      subscribed.push(id);
      return () => {};
    },
  });
  const tracker = new Tracker(
    () => {},
    () => {},
    () => {},
  );
  await tracker.sync();
  assert.equal(tracker.scanState(3), "scanning");
  assert.equal(tracker.scanState(4), "queued");
  assert.deepEqual(subscribed, ["7"]);
  await tracker.sync();
  assert.deepEqual(subscribed, ["7"], "an already followed job is not resubscribed");
  list = { activeJobId: null, jobs: [snapshot("libraryScan", "completed", "7", 3)] };
  await tracker.sync();
  assert.equal(tracker.scanState(4), null);
  tracker.dispose();
});

test("sync follows a restarted server job that reuses a completed job ID", async () => {
  let list: JobListResponse = {
    activeJobId: "1",
    jobs: [snapshot("libraryScan", "running", "1", 3)],
  };
  const subscribed: string[] = [];
  trackerBackend({
    listJobs: async () => list,
    subscribeJob: (id: string) => {
      subscribed.push(id);
      return () => {};
    },
  });
  const tracker = new Tracker(() => {}, () => {}, () => {});
  await tracker.sync();
  list = { activeJobId: null, jobs: [snapshot("libraryScan", "completed", "1", 3)] };
  await tracker.sync();

  tracker.backendDisconnected(true);
  list = { activeJobId: "1", jobs: [snapshot("libraryScan", "running", "1", 3)] };
  await tracker.sync();
  assert.deepEqual(subscribed, ["1", "1"]);
  assert.equal(tracker.active?.status, "running");
  tracker.dispose();
});

test("leaving a library cancels its running and queued scans only", async () => {
  const cancelled: string[] = [];
  trackerBackend({
    listJobs: async (): Promise<JobListResponse> => ({
      activeJobId: "1",
      jobs: [snapshot("libraryScan", "running", "1", 3), snapshot("libraryScan", "queued", "2", 4)],
    }),
    cancelJob: async (id: string) => {
      cancelled.push(id);
      return snapshot("libraryScan", "cancelled", id);
    },
  });
  const tracker = new Tracker(
    () => {},
    () => {},
    () => {},
  );
  await tracker.sync();
  await tracker.cancelLibraryScans(4);
  assert.deepEqual(cancelled, ["2"], "the other library's running scan continues");
  assert.equal(tracker.scanState(4), null);
  await tracker.cancelLibraryScans(3);
  assert.deepEqual(cancelled, ["2", "1"]);
  tracker.dispose();
});

test("Stop before the start response cancels the accepted backend job", async () => {
  let accept!: (job: JobSnapshot) => void;
  const cancelled: string[] = [];
  trackerBackend({
    startJob: () =>
      new Promise<JobSnapshot>((resolve) => {
        accept = resolve;
      }),
    cancelJob: async (id: string) => {
      cancelled.push(id);
      return snapshot("libraryScan", "cancelled", id);
    },
  });
  const tracker = new Tracker(
    () => {},
    () => {},
    () => {},
  );
  const start = tracker.start({ type: "libraryScan", params: { libraryId: 3 } });
  await tracker.cancel();
  accept(snapshot("libraryScan", "running", "accepted", 3));
  await start;
  assert.deepEqual(cancelled, ["accepted"]);
  assert.equal(tracker.running, false);
  tracker.dispose();
});

for (const rejected of [false, true]) {
  test(`old cancellation ${rejected ? "failure" : "response"} cannot affect a restarted job`, async () => {
    const reply = Promise.withResolvers<JobSnapshot>();
    const listeners: Array<(job: JobSnapshot) => void> = [];
    const connections: Array<(error: string | null) => void> = [];
    trackerBackend({
      startJob: async () => snapshot("libraryScan", "running", "1", 3),
      subscribeJob: (
        _id: string,
        listener: (job: JobSnapshot) => void,
        connection: (error: string | null) => void,
      ) => {
        listeners.push(listener);
        connections.push(connection);
        return () => {};
      },
      cancelJob: () => reply.promise,
    });
    const tracker = new Tracker(
      () => {},
      () => {},
      () => {},
    );
    await tracker.start({ type: "libraryScan", params: { libraryId: 3 } });
    const cancelling = tracker.cancel();
    tracker.backendDisconnected(true);
    await tracker.start({ type: "libraryScan", params: { libraryId: 3 } });
    listeners[0](snapshot("libraryScan", "cancelled"));
    connections[0]("old connection failed");
    if (rejected) reply.reject(new Error("old cancellation failed"));
    else reply.resolve(snapshot("libraryScan", "cancelled"));
    await cancelling;
    assert.equal(tracker.running, true);
    assert.equal(tracker.active?.status, "running");
    assert.equal(tracker.error, "");
    assert.equal(tracker.connectionError, null);
    listeners[1](snapshot("libraryScan", "cancelled"));
    assert.equal(tracker.running, false, "current subscription still works");
    tracker.dispose();
  });
}

function catalogBackend(overrides: Record<string, unknown>): void {
  globalThis.window = {
    nicegal: {
      backend: {
        getBackendStatus: async () => ({ ready: true, error: null }),
        getCatalogRevision: async () => "1",
        listAssets: async () => [],
        listLibraries: async () => [],
        getImageEmbeddingCoverage: async () => ({ total: 0, indexed: 0 }),
        ...overrides,
      },
    },
  } as unknown as Window & typeof globalThis;
}

test("catalog polling detects an insertion during a row load", async () => {
  storage.clear();
  let revision = "1";
  let lists = 0;
  const asset = {
    id: "1",
    displayName: "new.jpg",
    modifiedNs: "1000000",
    sourceSize: "1",
    mediaKind: "image",
    width: 1,
    height: 1,
  };
  catalogBackend({
    getCatalogRevision: async () => revision,
    listAssets: async () => {
      lists++;
      if (lists === 1) {
        revision = "2"; // This insertion happened after the first list's snapshot.
        return [];
      }
      return [asset];
    },
  });
  const catalog = new CatalogController();
  catalog.selectedId = 1;
  catalog.backendStatus = { ready: true, error: null };
  await catalog.refresh();
  assert.equal(catalog.items.length, 0);
  await catalog.pollRevision();
  assert.equal(lists, 2);
  assert.equal(catalog.items[0]?.id, "1");
  await catalog.pollRevision();
  assert.equal(lists, 2, "a stable revision does not reload again");
  catalog.dispose();
});

test("automatic catalog refresh and coverage polling remain available", async () => {
  storage.clear();
  let lists = 0;
  let revisions = 0;
  let coverage = 0;
  catalogBackend({
    listAssets: async () => {
      lists++;
      return [];
    },
    getCatalogRevision: async () => {
      revisions++;
      return "1";
    },
    getImageEmbeddingCoverage: async () => {
      coverage++;
      return { total: 0, indexed: 0 };
    },
  });
  const catalog = new CatalogController();
  catalog.selectedId = 1;
  catalog.backendStatus = { ready: true, error: null };
  catalog.scheduleRefresh(0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await catalog.pollRevision();
  assert.deepEqual([lists, revisions, coverage], [1, 2, 1]);
  await catalog.refresh();
  assert.deepEqual([lists, revisions, coverage], [2, 3, 1]);
  catalog.scheduleRefresh(0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(lists, 3);
  await catalog.pollRevision();
  assert.equal(coverage, 2);
  catalog.dispose();
});

test("v2 roots import once as one-folder libraries with their view state", async () => {
  storage.clear();
  storage.set(
    "nicegal.libraries.v2",
    JSON.stringify({
      selectedRoot: "D:/Phone",
      libraries: [
        { root: "C:/Pictures", displayName: "Pictures", query: "cat", scrollTop: 40 },
        { root: "D:/Phone", displayName: "Holiday phone", query: "", scrollTop: 0 },
      ],
    }),
  );
  storage.set(
    "nicegal.settings.v1",
    JSON.stringify({ libraryIndexing: { "d:/phone": { ocr: true, image: false } } }),
  );
  const created: CreateLibraryRequest[] = [];
  const backend: Library[] = [];
  catalogBackend({
    createLibrary: async (request: CreateLibraryRequest) => {
      created.push(request);
      const existing = backend.find((_, index) => created[index]?.importKey === request.importKey);
      if (existing) return existing;
      const next = library(backend.length + 1, request.include[0]);
      backend.push(next);
      return next;
    },
    listLibraries: async () => backend,
  });
  const catalog = new CatalogController();
  await catalog.initialize();
  assert.equal(created.length, 2);
  assert.ok(created.every((request) => request.importKey?.startsWith("nicegal.libraries.v2:")));
  assert.deepEqual(
    catalog.libraries.map(({ id, displayName }) => ({
      id,
      displayName,
      ...catalog.viewState(id),
    })),
    [
      { id: 1, displayName: "Pictures", name: null, query: "cat", scrollTop: 40 },
      { id: 2, displayName: "Holiday phone", name: "Holiday phone", query: "", scrollTop: 0 },
    ],
  );
  assert.equal(catalog.selectedId, 2);
  assert.ok(storage.has("nicegal.libraries.v2"), "v2 stays as rollback material");
  catalog.dispose();

  const again = new CatalogController();
  await again.initialize();
  assert.equal(created.length, 2, "a completed import is not repeated");
  assert.equal(again.selectedId, 2);
  again.dispose();
});

test("a failed import is retried with the same import key", async () => {
  storage.clear();
  storage.set(
    "nicegal.libraries.v2",
    JSON.stringify({ selectedRoot: "C:/Pictures", libraries: [{ root: "C:/Pictures" }] }),
  );
  const keys: string[] = [];
  let fail = true;
  catalogBackend({
    createLibrary: async (request: CreateLibraryRequest) => {
      keys.push(request.importKey ?? "");
      if (fail) throw new Error("backend busy");
      return library(1, "C:/Pictures");
    },
    listLibraries: async () => (fail ? [] : [library(1, "C:/Pictures")]),
  });
  const first = new CatalogController();
  await first.initialize();
  assert.equal(first.libraries.length, 0);
  first.dispose();
  fail = false;
  const second = new CatalogController();
  await second.initialize();
  assert.equal(second.selectedId, 1);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  second.dispose();
});

test("repeated reloads during a slow catalog load coalesce into one follow-up", async () => {
  storage.clear();
  const pending: Array<() => void> = [];
  let lists = 0;
  catalogBackend({
    listAssets: () =>
      new Promise((resolve) => {
        lists++;
        pending.push(() => resolve([]));
      }),
  });
  const catalog = new CatalogController();
  catalog.selectedId = 1;
  catalog.backendStatus = { ready: true, error: null };
  const first = catalog.refresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let request = 0; request < 10; request++) void catalog.refresh();
  assert.equal(lists, 1, "requests during a load do not restart it");
  pending.shift()!();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(lists, 2, "one follow-up load covers every request made during the first");
  pending.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(catalog.loading, false);
  catalog.dispose();
});
