import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createServer } from "vite";

import type { UpdateStatus } from "../src/shared/updates.ts";

import { RendererHandlers } from "./helpers/renderer-handlers.ts";

const handlers = new RendererHandlers();
const messages: unknown[] = [];
const opened: string[] = [];
const feedUrls: string[] = [];
const releaseRequests: string[] = [];
const net = {
  fetch: async (input: string): Promise<Response> => {
    releaseRequests.push(input);
    return Response.json({ tag_name: "v0.0.42", prerelease: false, draft: false });
  },
};
const flushUpdateCheck = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};
const window = Object.assign(new EventEmitter(), {
  webContents: {
    isDestroyed: () => false,
    send: (_channel: string, status: unknown) => messages.push(status),
  },
});
let userData = mkdtempSync(join(tmpdir(), "nicegal-update-preferences-test-"));
let executable = "C:\\Users\\bep\\AppData\\Local\\Programs\\nicegal\\nicegal.exe";
const app = Object.assign(new EventEmitter(), {
  isPackaged: true,
  getPath: (name: string) => (name === "exe" ? executable : userData),
  getVersion: () => "0.0.41",
});
const powerMonitor = new EventEmitter();
let calls = 0;
let resolveDownload: () => void = () => {};
let cancelledDownloads = 0;
let downloads = 0;
const explicitInstalls: { isSilent: boolean; isForceRunAfter: boolean }[] = [];
const updater = Object.assign(new EventEmitter(), {
  autoInstallEvent: "manual",
  autoDownload: false,
  autoRunAppAfterInstall: true,
  allowPrerelease: false,
  channel: "",
  allowDowngrade: true,
  disableWebInstaller: false,
  disableDifferentialDownload: true,
  setFeedURL: (configuration: { provider: string; url: string }) => {
    assert.equal(configuration.provider, "generic");
    feedUrls.push(configuration.url);
  },
  checkForUpdates: async () => {
    calls++;
    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "0.0.42" });
    return {
      isUpdateAvailable: true,
      cancellationToken: {
        cancel: (): void => {
          cancelledDownloads++;
          resolveDownload();
        },
      },
    };
  },
  downloadUpdate: () => {
    downloads++;
    return new Promise<void>((resolve) => {
      resolveDownload = resolve;
    });
  },
  quitAndInstall: (options: { isSilent: boolean; isForceRunAfter: boolean }) => {
    explicitInstalls.push(options);
  },
});
const mocks = { app, window, net, powerMonitor, updater, handlers, opened };
(globalThis as typeof globalThis & { __updateMocks: typeof mocks }).__updateMocks = mocks;
// Simulated updater, temporary installed marker; never touches real installs or GitHub.
const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-update-tests",
  define: { __NICEGAL_RELEASE_UPDATES__: "true" },
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [
    {
      name: "mock-updater",
      enforce: "pre",
      resolveId: (id) =>
        ["electron", "electron-updater"].includes(id) ? `\0update-${id}` : undefined,
      load: (id) => {
        if (id === "\0update-electron")
          return `
        const m = globalThis.__updateMocks;
        export const app = m.app;
        export const net = m.net;
        export const powerMonitor = m.powerMonitor;
        export const BrowserWindow = { getAllWindows: () => [m.window] };
        export const ipcMain = { handle: (name, handler) => m.handlers.set(name, handler) };
        export const shell = { openExternal: async (url) => { m.opened.push(url); } };
      `;
        if (id === "\0update-electron-updater")
          return "export const autoUpdater = globalThis.__updateMocks.updater;";
        return undefined;
      },
    },
  ],
  ssr: { noExternal: ["electron", "electron-updater"] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
after(() => vite.close());
const { startUpdates, supportsAutomaticUpdates, isNewerRelease, isProgramFilesInstallation } =
  await vite.ssrLoadModule("/src/main/updates.ts");

test("only installed NSIS and AppImage builds support automatic updates", () => {
  assert.equal(supportsAutomaticUpdates(true, "win32", true, {}, executable), true);
  assert.equal(supportsAutomaticUpdates(true, "win32", false, {}), false);
  assert.equal(
    supportsAutomaticUpdates(true, "win32", true, { PORTABLE_EXECUTABLE_FILE: "portable.exe" }),
    false,
  );
  assert.equal(supportsAutomaticUpdates(false, "win32", true, {}), false);
  assert.equal(
    supportsAutomaticUpdates(true, "linux", false, { APPIMAGE: "/app/nicegal.AppImage" }),
    true,
  );
  assert.equal(supportsAutomaticUpdates(true, "linux", false, {}), false);
  assert.equal(supportsAutomaticUpdates(true, "darwin", true, {}), false);
  assert.equal(
    supportsAutomaticUpdates(true, "linux", false, {
      APPIMAGE: "/stale/environment.AppImage",
      FLATPAK_ID: "io.github.centuryofimage.nicegal",
    }),
    false,
  );
});

test("Flatpak leaves update checks to its package manager", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
  const previousResources = electronProcess.resourcesPath;
  electronProcess.resourcesPath = userData;
  const previous = process.env.FLATPAK_ID;
  process.env.FLATPAK_ID = "io.github.centuryofimage.nicegal";
  t.after(() => {
    if (previousResources === undefined) delete electronProcess.resourcesPath;
    else electronProcess.resourcesPath = previousResources;
    if (previous === undefined) delete process.env.FLATPAK_ID;
    else process.env.FLATPAK_ID = previous;
  });
  const beforeChecks = calls;
  const beforeRequests = releaseRequests.length;
  const service = startUpdates(
    () => true,
    () => assert.fail("Flatpak cannot self-install"),
    "linux",
    true,
  );
  t.after(service.stop);
  assert.deepEqual(await handlers.get("updates:preferences")!({}), { enabled: true, mode: "none" });
  t.mock.timers.tick(5_000);
  await flushUpdateCheck();
  assert.equal(calls, beforeChecks);
  assert.equal(releaseRequests.length, beforeRequests);
  assert.equal(service.installAndRestart(), false);
});

test("release version comparison uses numeric components", () => {
  assert.equal(isNewerRelease("0.0.42", "0.0.41"), true);
  assert.equal(isNewerRelease("0.1.0", "0.0.99"), true);
  assert.equal(isNewerRelease("0.0.41", "0.0.41"), false);
  assert.equal(isNewerRelease("0.0.40", "0.0.41"), false);
  assert.equal(isNewerRelease("0.0.42", "0.0.41-beta.1"), false);
});

test("Program Files installations require manual updates without matching sibling folders", () => {
  const environment = { ProgramFiles: "C:\\Program Files", ProgramW6432: "D:\\Apps" };
  for (const path of [
    "c:\\PROGRAM FILES\\nicegal\\nicegal.exe",
    "D:\\Apps\\nicegal.exe",
    "C:\\Program Files (x86)\\nicegal\\nicegal.exe",
  ]) {
    assert.equal(isProgramFilesInstallation(path, environment), true);
    assert.equal(supportsAutomaticUpdates(true, "win32", true, environment, path), false);
  }
  for (const path of [
    "C:\\Program Files Backup\\nicegal.exe",
    "D:\\AppsBackup\\nicegal.exe",
    "C:\\Users\\bep\\AppData\\Local\\Programs\\nicegal\\nicegal.exe",
  ]) {
    assert.equal(isProgramFilesInstallation(path, environment), false);
    assert.equal(supportsAutomaticUpdates(true, "win32", true, environment, path), true);
  }
});

for (const scenario of [
  { name: "Linux deb", platform: "linux", executable: "/opt/nicegal/nicegal" },
  { name: "Windows ZIP", platform: "win32", executable: "C:\\Users\\bep\\Downloads\\nicegal.exe" },
  {
    name: "Windows Program Files",
    platform: "win32",
    executable: "C:\\Program Files\\nicegal\\nicegal.exe",
  },
]) {
  test(`${scenario.name} offers a manual update without downloading or installing`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const previousUserData = userData;
    const previousExecutable = executable;
    const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
    const previousResources = electronProcess.resourcesPath;
    const previousAppImage = process.env.APPIMAGE;
    delete process.env.APPIMAGE;
    userData = mkdtempSync(join(tmpdir(), "nicegal-manual-update-test-"));
    executable = scenario.executable;
    electronProcess.resourcesPath = userData;
    if (scenario.name === "Windows Program Files")
      writeFileSync(join(userData, "nicegal-installed"), "nsis");
    t.after(() => {
      userData = previousUserData;
      executable = previousExecutable;
      if (previousResources === undefined) delete electronProcess.resourcesPath;
      else electronProcess.resourcesPath = previousResources;
      if (previousAppImage === undefined) delete process.env.APPIMAGE;
      else process.env.APPIMAGE = previousAppImage;
    });
    const beforeChecks = calls;
    const beforeDownloads = downloads;
    const service = startUpdates(
      () => true,
      () => assert.fail("Manual updates cannot restart"),
      scenario.platform,
      true,
    );
    t.after(service.stop);
    assert.deepEqual(await handlers.get("updates:preferences")!({}), {
      enabled: true,
      mode: "notify",
    });
    t.mock.timers.tick(5_000);
    await flushUpdateCheck();
    assert.deepEqual(await handlers.get("updates:status")!({}), {
      phase: "available",
      version: "0.0.42",
      notes: [],
    });
    assert.equal(calls, beforeChecks);
    assert.equal(downloads, beforeDownloads);
    assert.equal(service.installAndRestart(), false);
    await assert.rejects(async () => handlers.get("updates:restart-and-install")!({}), /No update/);
    const beforeOpened = opened.length;
    await handlers.get("updates:release-notes")!({});
    assert.deepEqual(opened.slice(beforeOpened), [
      "https://github.com/centuryofimage/nicegal/releases/tag/v0.0.42",
    ]);
  });
}

test("packaged macOS checks once and offers a release link without installing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const previousUserData = userData;
  const previousPackaged = app.isPackaged;
  userData = mkdtempSync(join(tmpdir(), "nicegal-mac-notifier-test-"));
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
  const previousResources = electronProcess.resourcesPath;
  electronProcess.resourcesPath = userData;
  t.after(() => {
    userData = previousUserData;
    app.isPackaged = previousPackaged;
    if (previousResources === undefined) delete electronProcess.resourcesPath;
    else electronProcess.resourcesPath = previousResources;
  });
  const beforeChecks = calls;
  const beforeRequests = releaseRequests.length;
  const beforeOpened = opened.length;
  app.isPackaged = true;
  let restartRequests = 0;
  const service = startUpdates(
    (event: unknown) => event === "trusted",
    () => restartRequests++,
    "darwin",
    true,
  );
  t.after(service.stop);
  const status = async (): Promise<UpdateStatus> =>
    (await handlers.get("updates:status")!("trusted")) as UpdateStatus;
  assert.deepEqual(await handlers.get("updates:preferences")!("trusted"), {
    enabled: true,
    mode: "notify",
  });
  assert.deepEqual(await status(), { phase: "idle", version: null, notes: [] });
  t.mock.timers.tick(5_000);
  await flushUpdateCheck();
  assert.equal(releaseRequests.length, beforeRequests + 1);
  assert.equal(calls, beforeChecks, "Mac notifier never starts electron-updater");
  assert.deepEqual(await status(), { phase: "available", version: "0.0.42", notes: [] });
  await handlers.get("updates:release-notes")!("trusted");
  assert.deepEqual(opened.slice(beforeOpened), [
    "https://github.com/centuryofimage/nicegal/releases/tag/v0.0.42",
  ]);
  await assert.rejects(
    async () => handlers.get("updates:restart-and-install")!("trusted"),
    /No update/,
  );
  assert.equal(service.installAndRestart(), false);
  assert.equal(restartRequests, 0);
  await handlers.get("updates:set-enabled")!("trusted", false);
  assert.deepEqual(await status(), { phase: "disabled", version: null, notes: [] });
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.equal(releaseRequests.length, beforeRequests + 1);
});

test("ad hoc and branch packages never check for updates", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
  const previousResources = electronProcess.resourcesPath;
  const previousPackaged = app.isPackaged;
  electronProcess.resourcesPath = mkdtempSync(join(tmpdir(), "nicegal-branch-update-test-"));
  writeFileSync(join(electronProcess.resourcesPath, "nicegal-installed"), "nsis");
  app.isPackaged = true;
  t.after(() => {
    app.isPackaged = previousPackaged;
    if (previousResources === undefined) delete electronProcess.resourcesPath;
    else electronProcess.resourcesPath = previousResources;
  });
  const beforeRequests = releaseRequests.length;
  const beforeChecks = calls;
  const platform = process.platform;
  const service = startUpdates(
    () => true,
    () => {},
    platform,
    false,
  );
  t.after(service.stop);
  assert.deepEqual(await handlers.get("updates:preferences")!({}), { enabled: true, mode: "none" });
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.equal(releaseRequests.length, beforeRequests);
  assert.equal(calls, beforeChecks);
  service.stop();
  const macService = startUpdates(
    () => true,
    () => {},
    "darwin",
    false,
  );
  t.after(macService.stop);
  assert.deepEqual(await handlers.get("updates:preferences")!({}), { enabled: true, mode: "none" });
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.equal(releaseRequests.length, beforeRequests);
  assert.equal(calls, beforeChecks);
});

test("one check per launch, ready state, trusted notes and quit deferral", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const checksBefore = calls;
  const requestsBefore = releaseRequests.length;
  const feedsBefore = feedUrls.length;
  const openedBefore = opened.length;
  // Electron normally provides this property; Node does not.
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
  const previousResources = electronProcess.resourcesPath;
  electronProcess.resourcesPath = mkdtempSync(join(tmpdir(), "nicegal-update-test-"));
  writeFileSync(join(electronProcess.resourcesPath, "nicegal-installed"), "nsis");
  const previousAppImage = process.env.APPIMAGE;
  if (process.platform === "linux") process.env.APPIMAGE = "/test/nicegal.AppImage";
  t.after(() => {
    if (previousResources === undefined) delete electronProcess.resourcesPath;
    else electronProcess.resourcesPath = previousResources;
    if (previousAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = previousAppImage;
  });
  let restartRequests = 0;
  const service = startUpdates(
    (event: unknown) => event === "trusted",
    () => restartRequests++,
  );
  t.after(service.stop);
  assert.equal(updater.autoDownload, false, "downloads start explicitly with a cancellation token");
  assert.equal(updater.autoInstallEvent, "onQuit");
  assert.equal(updater.autoRunAppAfterInstall, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.channel, "latest");
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.disableDifferentialDownload, false);
  assert.equal(updater.disableWebInstaller, true);
  await assert.rejects(async () => handlers.get("updates:status")!("foreign"), /Untrusted/);
  await assert.rejects(async () => handlers.get("updates:release-notes")!("foreign"), /Untrusted/);
  await assert.rejects(
    async () => handlers.get("updates:restart-and-install")!("foreign"),
    /Untrusted/,
  );
  await assert.rejects(
    async () => handlers.get("updates:restart-and-install")!("trusted"),
    /No update/,
  );
  const status = async (): Promise<UpdateStatus> =>
    (await handlers.get("updates:status")!("trusted")) as UpdateStatus;
  assert.deepEqual(await status(), { phase: "idle", version: null, notes: [] });
  await handlers.get("updates:release-notes")!("trusted");
  assert.equal(opened.length, openedBefore);
  t.mock.timers.tick(4_999);
  assert.equal(calls, checksBefore);
  t.mock.timers.tick(1);
  await flushUpdateCheck();
  assert.equal(calls, checksBefore + 1);
  assert.deepEqual(releaseRequests.slice(requestsBefore), [
    "https://api.github.com/repos/centuryofimage/nicegal/releases/latest",
  ]);
  assert.deepEqual(feedUrls.slice(feedsBefore), [
    "https://github.com/centuryofimage/nicegal/releases/download/v0.0.42",
  ]);
  assert.deepEqual(await status(), { phase: "downloading", version: "0.0.42", notes: [] });
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  assert.equal(calls, checksBefore + 1, "no second check while the download promise is pending");
  updater.emit("update-downloaded", { version: "0.0.42" });
  resolveDownload();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(await status(), { phase: "ready", version: "0.0.42", notes: [] });
  assert.deepEqual(messages.at(-1), await status());
  await handlers.get("updates:release-notes")!("trusted");
  assert.deepEqual(opened.slice(openedBefore), [
    "https://github.com/centuryofimage/nicegal/releases/tag/v0.0.42",
  ]);
  await handlers.get("updates:restart-and-install")!("trusted");
  await flushUpdateCheck();
  assert.equal(restartRequests, 1);
  await handlers.get("updates:restart-and-install")!("trusted");
  await flushUpdateCheck();
  assert.equal(restartRequests, 1, "a repeated click cannot queue another restart");
  assert.equal(service.installAndRestart(), true);
  assert.deepEqual(explicitInstalls, [{ isSilent: true, isForceRunAfter: true }]);
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  assert.equal(calls, checksBefore + 1, "keep the downloaded version stable until quit");
  t.mock.method(console, "error", () => {});
  updater.emit("error", new Error("installation failed"));
  assert.deepEqual(await status(), { phase: "ready", version: "0.0.42", notes: [] });
  window.emit("query-session-end");
  assert.equal(updater.autoInstallEvent, "manual");
  updater.autoInstallEvent = "onQuit";
  powerMonitor.emit("shutdown");
  assert.equal(updater.autoInstallEvent, "manual");
  updater.autoInstallEvent = "onQuit";
  service.deferInstallation();
  assert.equal(
    updater.autoInstallEvent,
    "manual",
    "failed backend shutdown can suppress installation",
  );
  assert.equal(service.installAndRestart(), false, "session shutdown must not force an install");
  service.stop();
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  assert.equal(calls, checksBefore + 1);
});

test("dev is disabled and does not schedule checks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  app.isPackaged = false;
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
  electronProcess.resourcesPath = process.cwd();
  const service = startUpdates(
    () => true,
    () => {},
  );
  delete electronProcess.resourcesPath;
  t.after(service.stop);
  const before = calls;
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.equal(calls, before);
  assert.deepEqual(await handlers.get("updates:status")!({}), {
    phase: "disabled",
    version: null,
    notes: [],
  });
});

test("failed checks do not retry until the next launch; quitting before the delay cancels the check", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.mock.method(console, "error", () => {});
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
  electronProcess.resourcesPath = mkdtempSync(join(tmpdir(), "nicegal-update-offline-"));
  writeFileSync(join(electronProcess.resourcesPath, "nicegal-installed"), "nsis");
  const previousAppImage = process.env.APPIMAGE;
  if (process.platform === "linux") process.env.APPIMAGE = "/test/nicegal.AppImage";
  t.after(() => {
    delete electronProcess.resourcesPath;
    if (previousAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = previousAppImage;
  });
  app.isPackaged = true;
  let attempts = 0;
  t.mock.method(updater, "checkForUpdates", async () => {
    attempts++;
    throw new Error("offline");
  });
  const first = startUpdates(
    () => true,
    () => {},
  );
  t.after(first.stop);
  t.mock.timers.tick(5_000);
  await flushUpdateCheck();
  assert.equal(attempts, 1);
  assert.deepEqual(await handlers.get("updates:status")!({}), {
    phase: "error",
    version: null,
    notes: [],
  });
  t.mock.timers.tick(7 * 24 * 60 * 60 * 1000);
  assert.equal(attempts, 1, "no retry even after a week running");
  first.stop();
  const second = startUpdates(
    () => true,
    () => {},
  );
  second.stop();
  t.mock.timers.tick(5_000);
  assert.equal(attempts, 1, "an early quit cancels the pending startup check");
});

test("long sessions check again on focus once a day, never while hidden", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  t.mock.method(console, "error", () => {});
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
  electronProcess.resourcesPath = mkdtempSync(join(tmpdir(), "nicegal-update-daily-"));
  writeFileSync(join(electronProcess.resourcesPath, "nicegal-installed"), "nsis");
  const previousAppImage = process.env.APPIMAGE;
  if (process.platform === "linux") process.env.APPIMAGE = "/test/nicegal.AppImage";
  t.after(() => {
    delete electronProcess.resourcesPath;
    if (previousAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = previousAppImage;
  });
  app.isPackaged = true;
  let attempts = 0;
  t.mock.method(updater, "checkForUpdates", async () => {
    attempts++;
    throw new Error("offline");
  });
  const updates = startUpdates(
    () => true,
    () => {},
  );
  t.after(updates.stop);
  window.emit("focus");
  t.mock.timers.tick(5_000);
  await flushUpdateCheck();
  assert.equal(attempts, 1, "focus right after launch does not add a check");
  t.mock.timers.tick(23 * 60 * 60 * 1000);
  window.emit("focus");
  await flushUpdateCheck();
  assert.equal(attempts, 1, "focus within a day of the last check does nothing");
  t.mock.timers.tick(3 * 24 * 60 * 60 * 1000);
  await flushUpdateCheck();
  assert.equal(attempts, 1, "days hidden in the tray do not check");
  window.emit("focus");
  window.emit("focus");
  await flushUpdateCheck();
  assert.equal(attempts, 2, "the first focus after a day checks once");
  updates.stop();
  t.mock.timers.tick(2 * 24 * 60 * 60 * 1000);
  window.emit("focus");
  await flushUpdateCheck();
  assert.equal(attempts, 2, "stopping removes the focus listener");
});

test("opt-out persists, cancels a download, hides ready state and cannot re-arm this launch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.mock.method(console, "error", () => {});
  userData = mkdtempSync(join(tmpdir(), "nicegal-update-optout-"));
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
  electronProcess.resourcesPath = userData;
  writeFileSync(join(userData, "nicegal-installed"), "nsis");
  const previousAppImage = process.env.APPIMAGE;
  if (process.platform === "linux") process.env.APPIMAGE = "/test/nicegal.AppImage";
  t.after(() => {
    delete electronProcess.resourcesPath;
    if (previousAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = previousAppImage;
  });
  updater.removeAllListeners();
  app.isPackaged = true;
  const service = startUpdates(
    (event: unknown) => event === "trusted",
    () => {},
  );
  t.after(service.stop);
  const setEnabled = (value: unknown): Promise<unknown> =>
    handlers.get("updates:set-enabled")!("trusted", value);
  await assert.rejects(
    async () => handlers.get("updates:set-enabled")!("foreign", false),
    /Untrusted/,
  );
  await assert.rejects(async () => setEnabled("false"), /boolean/);
  assert.deepEqual(await handlers.get("updates:preferences")!("trusted"), {
    enabled: true,
    mode: "automatic",
  });
  const previousDownloads = downloads;
  t.mock.timers.tick(5_000);
  await flushUpdateCheck();
  assert.equal(downloads, previousDownloads + 1);
  const previousCancelled = cancelledDownloads;
  assert.deepEqual(await setEnabled(false), { enabled: false, mode: "automatic" });
  assert.equal(cancelledDownloads, previousCancelled + 1);
  await assert.rejects(
    async () => handlers.get("updates:restart-and-install")!("trusted"),
    /No update/,
  );
  assert.equal(updater.autoInstallEvent, "manual");
  assert.equal(
    JSON.parse(readFileSync(join(userData, "update-settings.json"), "utf8")).automaticUpdates,
    false,
  );
  updater.emit("update-downloaded", { version: "0.0.42" });
  assert.deepEqual(await handlers.get("updates:status")!("trusted"), {
    phase: "disabled",
    version: null,
    notes: [],
  });
  setEnabled(true);
  assert.equal(updater.autoInstallEvent, "manual");
  const previousCalls = calls;
  t.mock.timers.tick(7 * 24 * 60 * 60 * 1000);
  assert.equal(calls, previousCalls);
  setEnabled(false);
  service.stop();
  updater.removeAllListeners();
  const nextLaunch = startUpdates(
    () => true,
    () => {},
  );
  t.after(nextLaunch.stop);
  t.mock.timers.tick(5_000);
  assert.equal(calls, previousCalls, "saved opt-out is read before scheduling");
  assert.deepEqual(await handlers.get("updates:preferences")!({}), {
    enabled: false,
    mode: "automatic",
  });
});

test("invalid saved preferences fail closed; preference writes preserve unrelated files", async (t) => {
  const { loadAutomaticUpdates, saveAutomaticUpdates } = await vite.ssrLoadModule(
    "/src/main/update-preferences.ts",
  );
  const directory = mkdtempSync(join(tmpdir(), "nicegal-update-storage-"));
  const path = join(directory, "update-settings.json");
  assert.equal(loadAutomaticUpdates(path), true);
  t.mock.method(console, "error", () => {});
  writeFileSync(path, "not json");
  assert.equal(loadAutomaticUpdates(path), false);
  writeFileSync(path, '{"automaticUpdates":"false"}');
  assert.equal(loadAutomaticUpdates(path), false);
  const other = join(directory, "other-settings.json");
  writeFileSync(other, "keep me");
  saveAutomaticUpdates(path, false);
  assert.equal(loadAutomaticUpdates(path), false);
  saveAutomaticUpdates(path, true);
  assert.equal(loadAutomaticUpdates(path), true);
  assert.equal(readFileSync(other, "utf8"), "keep me");
});

test("latest release lookup accepts only a successful stable numeric release", async (t) => {
  const { latestStableRelease } = await vite.ssrLoadModule("/src/main/updates.ts");
  let response = Response.json({ tag_name: "v0.0.7", prerelease: false, draft: false });
  t.mock.method(net, "fetch", async () => response);
  assert.equal(
    (await latestStableRelease()).feedUrl,
    "https://github.com/centuryofimage/nicegal/releases/download/v0.0.7",
  );
  response = Response.json({ tag_name: "v0.0.8-beta.1", prerelease: true, draft: false });
  await assert.rejects(latestStableRelease(), /stable numeric release/);
  response = Response.json({ tag_name: "v0.0.8/../../other", prerelease: false, draft: false });
  await assert.rejects(latestStableRelease(), /stable numeric release/);
  response = new Response("rate limited", { status: 403 });
  await assert.rejects(latestStableRelease(), /HTTP 403/);
});

test("opting out during the release lookup never starts an updater check", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  userData = mkdtempSync(join(tmpdir(), "nicegal-update-lookup-optout-"));
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
  electronProcess.resourcesPath = userData;
  writeFileSync(join(userData, "nicegal-installed"), "nsis");
  const previousAppImage = process.env.APPIMAGE;
  if (process.platform === "linux") process.env.APPIMAGE = "/test/nicegal.AppImage";
  t.after(() => {
    delete electronProcess.resourcesPath;
    if (previousAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = previousAppImage;
  });
  app.isPackaged = true;
  let finishLookup: (response: Response) => void = () => {};
  t.mock.method(
    net,
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        finishLookup = resolve;
      }),
  );
  const service = startUpdates(
    () => true,
    () => {},
  );
  t.after(service.stop);
  const checksBefore = calls;
  const feedsBefore = feedUrls.length;
  t.mock.timers.tick(5_000);
  await handlers.get("updates:set-enabled")!({}, false);
  finishLookup(Response.json({ tag_name: "v0.0.42", prerelease: false, draft: false }));
  await flushUpdateCheck();
  assert.equal(calls, checksBefore);
  assert.equal(feedUrls.length, feedsBefore);
  assert.deepEqual(await handlers.get("updates:status")!({}), {
    phase: "disabled",
    version: null,
    notes: [],
  });
});
