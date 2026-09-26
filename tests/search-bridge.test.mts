import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, test } from "node:test";
import { createServer } from "vite";

const handlers = new Map<string, (event: unknown, value?: unknown) => Promise<unknown>>();
const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-search-bridge-tests",
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [
    {
      name: "mock-electron",
      enforce: "pre",
      resolveId: (id) => (id === "electron" ? "\0mock-electron" : undefined),
      load: (id) =>
        id === "\0mock-electron"
          ? "export const ipcMain = { handle: (channel, handler) => globalThis.__searchBridgeHandlers.set(channel, handler) };"
          : undefined,
    },
  ],
  ssr: { noExternal: ["electron"] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
(
  globalThis as typeof globalThis & { __searchBridgeHandlers: typeof handlers }
).__searchBridgeHandlers = handlers;
after(() => vite.close());
const { registerBackendIpc } = await vite.ssrLoadModule("/src/main/backend/ipc.ts");

interface Fixture {
  calls: Array<{
    request: Record<string, unknown>;
    signal: AbortSignal;
    resolve: (value: unknown) => void;
  }>;
  sender: EventEmitter & { id: number };
  search: (metadata?: Record<string, unknown>) => Promise<unknown>;
  cancel: () => Promise<unknown>;
}

function fixture(): Fixture {
  const calls: Array<{
    request: Record<string, unknown>;
    signal: AbortSignal;
    resolve: (value: unknown) => void;
  }> = [];
  registerBackendIpc({
    status: { ready: true, error: null },
    isTrustedSender: () => true,
    client: {
      search: (request: Record<string, unknown>, signal: AbortSignal) =>
        new Promise((resolve) => calls.push({ request, signal, resolve })),
    },
  });
  const sender = Object.assign(new EventEmitter(), { id: 1 });
  const search = (metadata: Record<string, unknown> = {}): Promise<unknown> =>
    handlers.get("backend:search")!(
      { sender },
      { query: "cat", type: "ocrSimple", libraryId: 1, ...metadata },
    );
  const cancel = (): Promise<unknown> => handlers.get("backend:cancel-search")!({ sender });
  return { calls, sender, search, cancel };
}

test("same session lanes coexist; newer sessions and same-lane replacements abort selectively", async () => {
  const { calls, search } = fixture();
  const first = search({ searchSession: 1, searchLane: "literal" });
  const second = search({ searchSession: 1, searchLane: "meaning" });
  assert.equal(calls[0].signal.aborted, false);
  assert.equal(calls[1].signal.aborted, false);
  assert.equal("searchSession" in calls[0].request, false);
  assert.equal("searchLane" in calls[0].request, false);
  const replacement = search({ searchSession: 1, searchLane: "literal" });
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[1].signal.aborted, false);
  const newer = search({ searchSession: 2, searchLane: "visual" });
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(calls[2].signal.aborted, true);
  await assert.rejects(search({ searchSession: 1, searchLane: "visual" }), /superseded/);
  assert.equal(calls[3].signal.aborted, false);
  for (const call of calls) call.resolve({ total: 0, results: [] });
  const settled = await Promise.allSettled([first, second, replacement, newer]);
  assert.deepEqual(
    settled.map((result) => result.status),
    ["rejected", "rejected", "rejected", "fulfilled"],
  );
});

test("cancel closes session, destruction aborts all lanes, legacy remains latest-wins", async () => {
  const { calls, sender, search, cancel } = fixture();
  const first = search({ searchSession: 1, searchLane: "literal" });
  await cancel();
  await assert.rejects(search({ searchSession: 1, searchLane: "meaning" }), /superseded/);
  const second = search();
  const third = search();
  assert.equal(calls[1].signal.aborted, true);
  const fourth = search({ searchSession: 2, searchLane: "meaning" });
  const fifth = search({ searchSession: 2, searchLane: "visual" });
  sender.emit("destroyed");
  assert.ok(calls.every((call) => call.signal.aborted));
  for (const call of calls) call.resolve({ total: 0, results: [] });
  const settled = await Promise.allSettled([first, second, third, fourth, fifth]);
  assert.ok(settled.every((result) => result.status === "rejected"));
});

test("invalid transport metadata cannot cancel a valid active search", async () => {
  const { calls, search } = fixture();
  const active = search({ searchSession: 5, searchLane: "meaning" });
  for (const metadata of [
    { searchSession: 6 },
    { searchLane: "literal" },
    { searchSession: -1, searchLane: "literal" },
    { searchSession: 6.5, searchLane: "literal" },
    { searchSession: "6", searchLane: "literal" },
    { searchSession: 6, searchLane: "bad" },
  ])
    await assert.rejects(search(metadata), /Invalid search session or lane/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, false);
  calls[0].resolve({ total: 0, results: [] });
  await active;
});

test("library scan and library requests cross IPC with only their documented fields", async () => {
  const requests: unknown[] = [];
  const updates: unknown[][] = [];
  registerBackendIpc({
    status: { ready: true, error: null },
    isTrustedSender: () => true,
    client: {
      startJob: async (request: unknown) => {
        requests.push(request);
        return request;
      },
      updateLibrary: async (...args: unknown[]) => {
        updates.push(args);
        return {};
      },
    },
  });
  const start = (params: Record<string, unknown>): Promise<unknown> =>
    Promise.resolve().then(() =>
      handlers.get("backend:start-job")!({}, { type: "libraryScan", params }),
    );
  for (const params of [{ libraryId: 3 }, { libraryId: 3, retryFailed: true }]) {
    await start(params);
    assert.deepEqual(requests.at(-1), { type: "libraryScan", params });
  }
  await assert.rejects(start({ libraryId: "3" }), /Invalid library ID/);
  await assert.rejects(start({ libraryId: 0 }), /Invalid library ID/);
  await assert.rejects(start({ libraryId: 3, retryFailed: "yes" }), /Invalid/);
  await assert.rejects(start({ libraryId: 3, indexVideos: false }), /Invalid/);
  assert.equal(requests.length, 2);

  const update = (definition: unknown): Promise<unknown> =>
    Promise.resolve().then(() => handlers.get("backend:update-library")!({}, 3, definition));
  const root = process.cwd();
  const options = { ocr: false, image: true, videos: true };
  await update({ include: [root], exclude: [], ...options });
  assert.deepEqual(updates.at(-1), [3, { include: [root], exclude: [], ...options }]);
  await assert.rejects(update({ include: [], exclude: [], ...options }), /absolute/);
  await assert.rejects(update({ include: ["relative"], ...options }), /absolute/);
  await assert.rejects(update({ include: [root], exclude: [], ...options, ocr: 1 }), /search/);
  await assert.rejects(update({ include: [root], exclude: [], ocr: false, image: true }), /search/);
  await assert.rejects(
    update({ include: [root], exclude: [], ...options, name: "x" }),
    /definition/,
  );
  assert.equal(updates.length, 1);
});

test("backend error codes survive IPC; other errors pass through unchanged", async () => {
  const { errorCode, errorMessage } = await vite.ssrLoadModule("/src/renderer/src/lib/errors.ts");
  let failure: Error = new Error("unused");
  registerBackendIpc({
    status: { ready: true, error: null },
    isTrustedSender: () => true,
    client: {
      listLibraries: async () => {
        throw failure;
      },
    },
  });
  const list = (): Promise<unknown> =>
    Promise.resolve().then(() => handlers.get("backend:list-libraries")!({}));
  // Electron keeps only the message, behind its own prefix.
  const received = async (): Promise<Error> => {
    const error = (await list().catch((cause: unknown) => cause)) as Error;
    return new Error(
      `Error invoking remote method 'backend:list-libraries': Error: ${error.message}`,
    );
  };

  failure = Object.assign(new Error("Image model not ready"), { code: "models_not_ready" });
  const coded = await received();
  assert.equal(errorCode(coded), "models_not_ready");
  assert.equal(errorMessage(coded), "Image model not ready");

  failure = new Error("disk full");
  const plain = await received();
  assert.equal(errorCode(plain), undefined);
  assert.equal(errorMessage(plain), "disk full");
});
