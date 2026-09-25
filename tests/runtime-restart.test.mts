import { svelte } from "@sveltejs/vite-plugin-svelte";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

import type { RuntimeController as Controller } from "../src/renderer/src/lib/runtime.svelte.ts";

import { IPC_CHANNELS } from "../src/shared/ipc-channels.ts";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
Object.assign(globalThis, { __runtimeHandlers: handlers });
const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-runtime-tests",
  plugins: [
    svelte(),
    {
      name: "mock-runtime-ipc",
      enforce: "pre",
      resolveId: (id) => (id === "electron" ? "\0runtime-electron" : undefined),
      load: (id) =>
        id === "\0runtime-electron"
          ? "export const ipcMain = { handle: (channel, callback) => globalThis.__runtimeHandlers.set(channel, callback) };"
          : undefined,
    },
  ],
  ssr: { noExternal: ["electron"] },
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
after(() => vite.close());
const { registerBackendIpc } = await vite.ssrLoadModule("/src/main/backend/ipc.ts");
const { RuntimeController } = (await vite.ssrLoadModule(
  "/src/renderer/src/lib/runtime.svelte.ts",
)) as {
  RuntimeController: typeof Controller;
};

test("provider and model changes share restart and exclude overlapping job starts", async () => {
  const restart = Promise.withResolvers<void>();
  const jobStart = Promise.withResolvers<object>();
  let restarts = 0;
  const status = { activeExecutionProvider: "cpu", restartRequired: false };
  registerBackendIpc({
    status: { ready: true },
    isTrustedSender: () => true,
    client: {
      setExecutionProvider: async () => ({ restartRequired: true }),
      setImageModel: async () => ({ restartRequired: true }),
      getRuntimeStatus: async () => status,
      startJob: () => jobStart.promise,
    },
    restartForRuntimeChange: async () => {
      restarts++;
      await restart.promise;
    },
  });
  const invoke = async (channel: string, value: unknown): Promise<unknown> =>
    handlers.get(channel)!({}, value);
  const channels = IPC_CHANNELS.backend;
  const change = invoke(channels.setExecutionProvider, "cpu");
  await Promise.resolve();
  await assert.rejects(invoke(channels.setImageModel, "model"), /already in progress/);
  await assert.rejects(invoke(channels.startJob, {}), /already in progress/);
  restart.resolve();
  assert.equal(await change, status);
  await invoke(channels.setImageModel, "model");
  assert.equal(restarts, 2);
  const job = invoke(channels.startJob, {
    type: "libraryScan",
    params: { libraryId: 1 },
  });
  await assert.rejects(invoke(channels.setExecutionProvider, "cpu"), /job is starting/);
  jobStart.resolve({});
  await job;
});

test("provider change accepts status after the backend disconnect resets controller generations", async () => {
  const controller = new RuntimeController();
  const changed = {
    activeExecutionProvider: "cpu",
    configuredExecutionProvider: "cpu",
    restartRequired: false,
  };
  Object.assign(globalThis, {
    window: {
      nicegal: {
        backend: {
          setExecutionProvider: async () => {
            controller.reset();
            return changed;
          },
          getSearchModels: async () => ({}),
          getOcrModels: async () => ({ loaded: null }),
        },
      },
    },
  });
  await controller.setExecutionProvider("cpu");
  assert.equal(controller.status, changed);
  assert.equal(controller.loading, false);
  assert.equal(controller.saving, false);
  assert.equal(controller.error, null);
});

test("image model write invalidates an older runtime read", async () => {
  const read = Promise.withResolvers<object>();
  const previous = { imageModel: { selectedModel: "old" } };
  const selected = { imageModel: { selectedModel: "new" } };
  globalThis.window = {
    nicegal: {
      backend: {
        getRuntimeStatus: () => read.promise,
        setImageModel: async () => selected,
        getSearchModels: async () => ({}),
        getOcrModels: async () => ({}),
      },
    },
  } as unknown as Window & typeof globalThis;
  const runtime = new RuntimeController();
  const refresh = runtime.refresh();
  await runtime.setImageModel("new");
  read.resolve(previous);
  await refresh;
  assert.equal(runtime.status?.imageModel.selectedModel, "new");
  assert.equal(runtime.loading, false);
});

test("model refresh clears startup loading when it supersedes the first runtime read", async () => {
  const firstRead = Promise.withResolvers<object>();
  const modelRead = Promise.withResolvers<object>();
  let reads = 0;
  globalThis.window = {
    nicegal: {
      backend: {
        getRuntimeStatus: () => (++reads === 1 ? firstRead.promise : modelRead.promise),
        getSearchModels: async () => ({}),
      },
    },
  } as unknown as Window & typeof globalThis;

  const runtime = new RuntimeController();
  const initial = runtime.refresh();
  const models = runtime.refreshModels();
  await Promise.resolve();
  const latest = { configuredExecutionProvider: "webgpu" };
  modelRead.resolve(latest);
  await models;
  firstRead.resolve({ configuredExecutionProvider: "cpu" });
  await initial;

  assert.equal(runtime.status, latest);
  assert.equal(runtime.loading, false);
});
