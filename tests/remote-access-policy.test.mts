import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer as createNetServer } from "node:net";
import { after, test } from "node:test";
import { createServer } from "vite";

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-remote-access-policy-tests",
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [
    {
      name: "mock-electron",
      enforce: "pre",
      resolveId: (id) => (id === "electron" ? "\0mock-electron" : undefined),
      load: (id) =>
        id === "\0mock-electron"
          ? "export const ipcMain = { handle: (channel, handler) => globalThis.__policyHandlers.set(channel, handler) }; export const protocol = {}; export const net = {};"
          : undefined,
    },
  ],
  ssr: { noExternal: ["electron"] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
(globalThis as typeof globalThis & { __policyHandlers: typeof handlers }).__policyHandlers =
  handlers;
after(() => vite.close());
const { registerBackendIpc } = await vite.ssrLoadModule("/src/main/backend/ipc.ts");
const { handleRemotableIpc, handleTrustedIpc } = await vite.ssrLoadModule("/src/main/ipc.ts");
const { RemoteServer } = await vite.ssrLoadModule("/src/main/remote/remote-server.ts");

const CLIENT = "11111111-2222-4333-8444-555555555555";
const headers = {
  cookie: "nicegal_device=test",
  "x-nicegal-client": CLIENT,
  "content-type": "application/json",
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function startServer(
  getCatalog: () => unknown,
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = new RemoteServer(
    {
      authenticate: () => ({ id: "phone", name: "Phone", pairedAt: 0, lastSeenAt: 0 }),
      pair: () => ({ error: "unused" }),
      rendererDirectory: "unused",
      iconPath: "unused",
      devRendererUrl: null,
      onConnectionsChanged() {
        /* No event streams in these tests. */
      },
      getThumbnails: () => null,
      getCatalog,
    },
    null,
  );
  const port = await freePort();
  await server.listen(port);
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test("library changes and destructive jobs are desktop-only", async (t) => {
  const calls: string[] = [];
  const client = {
    listLibraries: async () => [{ id: 1 }],
    createLibrary: async () => {
      calls.push("create");
      return { id: 2 };
    },
    updateLibrary: async () => {
      calls.push("update");
      return { id: 1 };
    },
    deleteLibrary: async () => {
      calls.push("delete");
    },
    startJob: async (request: { type: string }) => {
      calls.push(`job:${request.type}`);
      return { jobId: "j" };
    },
  };
  registerBackendIpc({
    status: { ready: true, error: null },
    client,
    isTrustedSender: () => true,
    restartForRuntimeChange: async () => {},
    restartFailedBackend: async () => {},
  });
  const server = await startServer(() => null);
  t.after(() => server.close());
  const rpc = async (channel: string, args: unknown[]): Promise<Response> =>
    fetch(`${server.base}/rpc/${channel}`, {
      method: "POST",
      headers,
      body: JSON.stringify(args),
    });

  const listed = await rpc("backend:list-libraries", []);
  assert.deepEqual(await listed.json(), { value: [{ id: 1 }] });

  const definition = { include: ["C:\\Users\\me"], exclude: [], ocr: true, image: true };
  assert.equal((await rpc("backend:create-library", [definition])).status, 404);
  assert.equal(
    (await rpc("backend:update-library", [1, { ...definition, videos: true }])).status,
    404,
  );
  assert.equal((await rpc("backend:delete-library", [1])).status, 404);

  const scan = await rpc("backend:start-job", [
    { type: "libraryScan", params: { libraryId: 1 } },
    "scan-token",
  ]);
  assert.deepEqual(await scan.json(), { value: { jobId: "j" } });
  const purge = (await (
    await rpc("backend:start-job", [
      { type: "libraryPurge", params: { libraryId: 1, removeLibrary: true } },
      "purge-token",
    ])
  ).json()) as { error?: { message: string } };
  assert.match(purge.error?.message ?? "", /only be started on the PC/);
  assert.deepEqual(calls, ["job:libraryScan"]);

  // The desktop window still makes every one of these calls.
  const windowEvent = { sender: Object.assign(new EventEmitter(), { id: 7 }) };
  await handlers.get("backend:create-library")!(windowEvent, definition);
  await handlers.get("backend:delete-library")!(windowEvent, 1);
  await handlers.get("backend:start-job")!(
    windowEvent,
    { type: "libraryPurge", params: { libraryId: 1 } },
    "window-token",
  );
  assert.deepEqual(calls, ["job:libraryScan", "create", "delete", "job:libraryPurge"]);
});

test("registration must match the channel's access in IPC_ACCESS", () => {
  assert.throws(
    () =>
      handleRemotableIpc(
        "backend:create-library",
        () => true,
        () => null,
      ),
    /not remote/,
  );
  assert.throws(
    () =>
      handleTrustedIpc(
        "backend:search",
        () => true,
        () => null,
      ),
    /is remote/,
  );
  assert.throws(
    () =>
      handleRemotableIpc(
        "test:unknown",
        () => true,
        () => null,
      ),
    /not remote/,
  );
});

test("remote API requests cannot change libraries or start jobs", async (t) => {
  const forwarded: string[] = [];
  const server = await startServer(() => ({
    forward: async (path: string, options: { method: string }) => {
      forwarded.push(`${options.method} ${path}`);
      return Response.json({ ok: true });
    },
  }));
  t.after(() => server.close());
  const cookie = { cookie: "nicegal_device=test" };

  const tags = await fetch(`${server.base}/api/v1/assets/tags?assetId=4`, { headers: cookie });
  assert.equal(tags.status, 200);
  const patches = await fetch(`${server.base}/api/v1/image-embeddings/patches`, {
    method: "POST",
    headers: { ...cookie, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(patches.status, 200);

  const library = await fetch(`${server.base}/api/v1/libraries`, {
    method: "POST",
    headers: { ...cookie, "content-type": "application/json" },
    body: JSON.stringify({ include: ["C:\\"], exclude: [], ocr: false, image: false }),
  });
  assert.equal(library.status, 404);
  const update = await fetch(`${server.base}/api/v1/libraries/1`, {
    method: "POST",
    headers: { ...cookie, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(update.status, 404);
  const job = await fetch(`${server.base}/api/v1/jobs`, {
    method: "POST",
    headers: { ...cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: "libraryPurge" }),
  });
  assert.equal(job.status, 404);
  assert.equal((await fetch(`${server.base}/api/v1/jobs`, { headers: cookie })).status, 200);
  assert.deepEqual(forwarded, [
    "GET /v1/assets/tags?assetId=4",
    "POST /v1/image-embeddings/patches",
    "GET /v1/jobs",
  ]);
});
