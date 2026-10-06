import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, test } from "node:test";
import { createServer } from "vite";

import { RendererHandlers } from "./helpers/renderer-handlers.ts";

/** A desktop-window IPC event; handlers see it as a stable bridge client. */
const windowEvent = { sender: Object.assign(new EventEmitter(), { id: 99 }) };
const handlers = new RendererHandlers();
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
      handlers.get("backend:start-job")!(
        windowEvent,
        { type: "libraryScan", params },
        "request-token",
      ),
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
    Promise.resolve().then(() =>
      handlers.get("backend:update-library")!(windowEvent, 3, definition),
    );
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
  // What the preload throws into the renderer once it unwraps the call's result.
  const received = (): Promise<Error> =>
    Promise.resolve()
      .then(() => handlers.get("backend:list-libraries")!(windowEvent))
      .then(
        () => assert.fail("the call should fail"),
        (error: unknown) => error as Error,
      );

  failure = Object.assign(new Error("Image model not ready"), { code: "models_not_ready" });
  const coded = await received();
  assert.equal(errorCode(coded), "models_not_ready");
  assert.equal(errorMessage(coded), "Image model not ready");

  failure = new Error("disk full");
  const plain = await received();
  assert.equal(errorCode(plain), undefined);
  assert.equal(errorMessage(plain), "disk full");
});
