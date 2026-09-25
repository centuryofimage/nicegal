import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "vite";

for (const restartForUpdate of [false, true])
  test(`${restartForUpdate ? "update restart" : "quit"} awaits an in-flight provider fallback shutdown without respawning the backend`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "nicegal-shutdown-test-"));
    const stopped = Promise.withResolvers<void>();
    const finishedQuit = Promise.withResolvers<void>();
    const state = {
      starts: 0,
      stops: 0,
      quits: 0,
      updateStops: 0,
      deferrals: 0,
      installs: 0,
      requestRestart: (): void => {
        throw new Error("Update restart handler not attached");
      },
      ready: Promise.resolve(),
      onExit: (code: number): void => {
        throw new Error(`Exit handler not attached: ${code}`);
      },
      stop: (): Promise<void> => (++state.stops === 1 ? stopped.promise : Promise.resolve()),
    };
    const app = Object.assign(new EventEmitter(), {
      isPackaged: false,
      requestSingleInstanceLock: (): boolean => true,
      setAppUserModelId: (): void => {},
      getPath: (): string => directory,
      whenReady: () => ({
        then: (callback: () => Promise<void>): void => {
          state.ready = callback();
        },
      }),
      quit: (): void => {
        state.quits++;
        if (state.quits === (restartForUpdate ? 2 : 1)) finishedQuit.resolve();
      },
    });
    const mocks = { app, state };
    (globalThis as typeof globalThis & { __shutdownMocks: typeof mocks }).__shutdownMocks = mocks;
    const sources: Record<string, string> = {
      electron: `
      import { EventEmitter } from 'node:events';
      export const app = globalThis.__shutdownMocks.app;
      export class BrowserWindow extends EventEmitter {
        static getAllWindows() { return []; }
        webContents = Object.assign(new EventEmitter(), {
          setWindowOpenHandler() {},
        });
        loadURL() { return Promise.resolve(); }
        isDestroyed() { return false; }
        show() {}
      }
      export const Menu = { setApplicationMenu() {}, buildFromTemplate() {} };
      export const session = { defaultSession: { webRequest: { onHeadersReceived() {} } } };
    `,
      "../../resources/icon.png?asset": "export default '';",
      "./backend/backend-log":
        "export class BackendLog { static async open() { return new BackendLog(); } write() {} async close() {} }",
      "./backend/ipc": "export function registerBackendIpc() {}",
      "./protocols":
        "export function registerCustomSchemes() {} export function installProtocolHandlers() {}",
      "./backend/nicegal-server-client": "export class NicegalServerClient { async health() {} }",
      "./backend/nicegal-server-process": `
      const s = globalThis.__shutdownMocks.state;
      export const RESTART_EXIT_CODE = 99;
      export class NicegalServerProcess {
        constructor(_log, onExit) { s.onExit = onExit; }
        async start() { s.starts++; return { endpoint: '', token: '' }; }
        stop() { return s.stop(); }
      }
    `,
      "./backend/thumbnail-reader": "export class ThumbnailReader { close() {} }",
      "./native/ipc": "export function registerNativeIpc() {}",
      "./updates": `export function startUpdates(_trusted, requestRestart) { const s = globalThis.__shutdownMocks.state; s.requestRestart = requestRestart; return {
      stop() { s.updateStops++; }, deferInstallation() { s.deferrals++; },
      installAndRestart() { s.installs++; return true; }
    }; }`,
    };
    const vite = await createServer({
      configFile: false,
      cacheDir: "node_modules/.vite-shutdown-tests",
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [
        {
          name: "mock-app-lifecycle",
          enforce: "pre",
          transform: (code, id) =>
            id.endsWith("/src/main/index.ts")
              ? `const __dirname = ${JSON.stringify(directory)};\n${code}`
              : undefined,
          resolveId: (id) => (Object.hasOwn(sources, id) ? `\0shutdown:${id}` : undefined),
          load: (id) => (id.startsWith("\0shutdown:") ? sources[id.slice(10)] : undefined),
        },
      ],
      ssr: { noExternal: ["electron"] },
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      appType: "custom",
    });
    t.after(() => vite.close());
    const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
    electronProcess.resourcesPath = directory;
    t.after(() => {
      delete electronProcess.resourcesPath;
    });
    t.mock.method(console, "info", () => {});
    await vite.ssrLoadModule("/src/main/index.ts");
    await state.ready;
    assert.equal(state.starts, 1);
    state.onExit(99);
    assert.equal(state.stops, 1);
    if (restartForUpdate) state.requestRestart();
    let prevented = false;
    app.emit("before-quit", {
      preventDefault: () => {
        prevented = true;
      },
    });
    await Promise.resolve();
    assert.equal(prevented, true);
    assert.equal(state.stops, 1, "quit joins the existing stop instead of returning prematurely");
    assert.equal(state.installs, 0, "the updater cannot run before the backend exits");
    assert.equal(state.quits, restartForUpdate ? 1 : 0);
    stopped.resolve();
    await finishedQuit.promise;
    assert.equal(state.starts, 1, "fallback must not respawn while the app is quitting");
    assert.equal(state.updateStops, 1);
    assert.equal(state.deferrals, 0);
    assert.equal(state.installs, restartForUpdate ? 1 : 0);
    assert.equal(state.quits, restartForUpdate ? 2 : 1);
  });
