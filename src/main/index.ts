import {
  app,
  BrowserWindow,
  Menu,
  session,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron";
import { mkdir } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { BackendStatus } from "../shared/backend";

import icon from "../../resources/icon.png?asset";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import { BackendLog } from "./backend/backend-log";
import { registerBackendIpc } from "./backend/ipc";
import { NicegalServerClient } from "./backend/nicegal-server-client";
import { NicegalServerProcess, RESTART_EXIT_CODE } from "./backend/nicegal-server-process";
import { ThumbnailReader } from "./backend/thumbnail-reader";
import { collectDiagnostics, getAppInfo, recentBackendLog } from "./diagnostics";
import { registerNativeIpc } from "./native/ipc";
import { installProtocolHandlers, registerCustomSchemes } from "./protocols";
import { APP_ENTRY_URL } from "./renderer-location";
import { startUpdates } from "./updates";

registerCustomSchemes();

// Test runs can isolate Electron preferences alongside the backend databases. Changing only
// NICEGAL_STATE_DIR leaves saved library IDs and queries in the regular profile.
const isolatedUserData = process.env["NICEGAL_USER_DATA_DIR"];
if (isolatedUserData) {
  mkdirSync(isolatedUserData, { recursive: true });
  app.setPath("userData", isolatedUserData);
}

// Match electron-builder.yml so installed shortcuts and the running app share an identity.
if (process.platform === "win32") app.setAppUserModelId("io.github.nicegal.nicegal");

const isDev = Boolean(process.env["ELECTRON_RENDERER_URL"]);
const rendererEntryUrl = process.env["ELECTRON_RENDERER_URL"] ?? APP_ENTRY_URL;
const trustedRendererOrigin = isDev ? new URL(rendererEntryUrl).origin : null;

const backendStatus: BackendStatus = { ready: false, error: null };
let backendLog: BackendLog | null = null;
let backendProcess: NicegalServerProcess | null = null;
let thumbnailReader: ThumbnailReader | null = null;
let backendClient: NicegalServerClient | null = null;
let shutdownComplete = false;
let shutdownStarted = false;
let backendShutdown: Promise<void> | null = null;
let backendRecovery: Promise<void> | null = null;
let updates: ReturnType<typeof startUpdates> | null = null;
let restartForUpdate = false;

function broadcastBackendStatus(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(IPC_CHANNELS.backend.statusChanged, backendStatus);
  }
}

const backendContext = {
  status: backendStatus,
  get client(): NicegalServerClient | null {
    return backendClient;
  },
  isTrustedSender: isTrustedRenderer,
  restartForRuntimeChange: async (): Promise<void> => {
    backendStatus.restartReason = "runtime-change";
    try {
      await shutdownBackend();
      if (shutdownStarted) throw new Error("The app is closing");
      await initializeBackend();
    } catch (error) {
      backendStatus.error = formatBackendError(error);
      broadcastBackendStatus();
      throw error;
    }
  },
  restartFailedBackend,
};
registerBackendIpc(backendContext);
registerNativeIpc({
  isTrustedSender: isTrustedRenderer,
  get client(): NicegalServerClient | null {
    return backendClient;
  },
  getAppInfo,
  collectDiagnostics: (owner) =>
    collectDiagnostics(owner, {
      backendStatus,
      flushBackendLog: () => backendLog?.flush() ?? Promise.resolve(),
    }),
  recentBackendLog: async () => {
    await backendLog?.flush();
    return recentBackendLog();
  },
});

/**
 * Restrictive CSP for the app's own document, delivered as a response header (not a `<meta>`
 * tag) so it can differ between dev and production without the two policies stacking. Local
 * media never uses `file:`/`data:` — it is served entirely through the `thumb:`/`original:`
 * protocols — so `img-src`/`media-src` only need to name those schemes plus `'self'`. Dev
 * additionally loads its document and scripts from the
 * Vite dev server and needs `'unsafe-eval'` and a websocket allowance for HMR.
 */
function installContentSecurityPolicy(): void {
  const connectSrc = isDev ? "'self' ws://localhost:*" : "'self'";

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== "mainFrame") {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    // The legacy file page is loaded once only to read its origin-scoped localStorage. Prevent its
    // obsolete renderer bundle from starting and making rejected IPC calls during that migration.
    const scriptSrc = details.url.startsWith("file:")
      ? "'none'"
      : isDev
        ? "'self' 'unsafe-eval'"
        : "'self'";
    const policy = [
      "default-src 'self'",
      `script-src ${scriptSrc}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' thumb: original:",
      "media-src 'self' thumb: original:",
      `connect-src ${connectSrc}`,
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; ");
    callback({
      responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [policy] },
    });
  });
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  void loadRenderer(mainWindow).catch((error: unknown) => {
    console.error("Failed to load the renderer", error);
  });
}

async function loadRenderer(mainWindow: BrowserWindow): Promise<void> {
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });

  await mainWindow.loadURL(rendererEntryUrl);
  if (!mainWindow.isDestroyed()) mainWindow.show();
}

function installApplicationMenu(): void {
  const mac = process.platform === "darwin";
  const linux = process.platform === "linux";
  const viewItems: MenuItemConstructorOptions[] = [
    {
      label: "Toggle Developer &Tools",
      accelerator: "CommandOrControl+Shift+I",
      click: () => BrowserWindow.getFocusedWindow()?.webContents.toggleDevTools(),
    },
  ];
  if (isDev) {
    viewItems.unshift({ type: "separator" });
    viewItems.unshift({ role: "reload" });
  }
  const template: MenuItemConstructorOptions[] = [];
  if (mac) template.push({ role: "appMenu" }, { role: "editMenu" });
  template.push({
    label: mac ? "File" : "&File",
    submenu: [
      {
        label: "Close Window",
        accelerator: "CommandOrControl+W",
        click: () => BrowserWindow.getFocusedWindow()?.close(),
      },
      ...(linux
        ? [
            { type: "separator" as const },
            {
              label: "Quit",
              accelerator: "Control+Q",
              click: () => app.quit(),
            },
          ]
        : []),
    ],
  });
  template.push({ label: mac ? "View" : "&View", submenu: viewItems });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function isTrustedRenderer(event: IpcMainInvokeEvent): boolean {
  return (
    event.senderFrame === event.sender.mainFrame &&
    isTrustedRendererUrl(event.senderFrame.url) &&
    BrowserWindow.fromWebContents(event.sender) !== null
  );
}

function isTrustedRendererUrl(url: string): boolean {
  if (trustedRendererOrigin) {
    try {
      return new URL(url).origin === trustedRendererOrigin;
    } catch {
      return false;
    }
  }
  return url === rendererEntryUrl;
}

function focusMainWindow(): void {
  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (!mainWindow) {
    if (app.isReady()) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Reported once by the exited process's own `exit` handler; a deliberate `stop()` never reaches
 * this. `RESTART_EXIT_CODE` is not a crash — the server asks for this after silently downgrading
 * its execution provider (see `nicegal-server`'s `RESTART_EXIT_CODE` doc comment) — so it gets
 * a quiet respawn instead of a crash report. */
function handleUnexpectedExit(code: number | null, signal: NodeJS.Signals | null): void {
  if (shutdownStarted) return;
  if (code === RESTART_EXIT_CODE) {
    void restartAfterProviderFallback();
    return;
  }
  backendStatus.ready = false;
  delete backendStatus.restartReason;
  backendStatus.error = `nicegal-server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`;
  backendClient = null;
  backendLog?.write("desktop", "server-crashed", { code, signal });
  console.error(backendStatus.error);
  broadcastBackendStatus();
}

async function restartAfterProviderFallback(): Promise<void> {
  backendLog?.write("desktop", "server-restart-requested", {
    reason: "execution-provider-fallback",
  });
  console.info("nicegal-server is restarting to switch execution provider");
  backendStatus.restartReason = "provider-fallback";
  try {
    await shutdownBackend();
    // A provider fallback may have been draining the old backend when the user quit.
    // Do not spawn a replacement while the on-quit updater is about to replace its files.
    if (shutdownStarted) return;
    await initializeBackend();
  } catch (error) {
    backendStatus.error = formatBackendError(error);
    delete backendStatus.restartReason;
    backendLog?.write("desktop", "initialization-failed", { error: backendStatus.error });
    console.error("Failed to restart nicegal-server after an execution provider fallback", error);
    broadcastBackendStatus();
  }
}

function restartFailedBackend(): Promise<void> {
  if (backendRecovery) return backendRecovery;
  if (shutdownStarted) return Promise.reject(new Error("The app is closing"));
  if (backendStatus.ready || !backendStatus.error)
    return Promise.reject(new Error("The gallery service is already running or starting"));

  backendRecovery = (async () => {
    backendStatus.error = null;
    delete backendStatus.restartReason;
    broadcastBackendStatus();
    try {
      await shutdownBackend();
      if (shutdownStarted) throw new Error("The app is closing");
      await initializeBackend();
    } catch (error) {
      backendStatus.error = formatBackendError(error);
      backendLog?.write("desktop", "initialization-failed", { error: backendStatus.error });
      broadcastBackendStatus();
      throw error;
    }
  })().finally(() => {
    backendRecovery = null;
  });
  return backendRecovery;
}

async function initializeBackend(): Promise<void> {
  const stateDirectory =
    process.env["NICEGAL_STATE_DIR"] ?? join(app.getPath("userData"), "nicegal-server");
  await mkdir(stateDirectory, { recursive: true });
  backendLog = await BackendLog.open(join(stateDirectory, "backend.log"));
  backendProcess = new NicegalServerProcess(backendLog, handleUnexpectedExit);

  const executableName = process.platform === "win32" ? "nicegal-server.exe" : "nicegal-server";
  const repositoryDirectory = join(process.cwd(), "nicegal-server");
  const packagedDirectory = join(process.resourcesPath, "nicegal-server");
  const executable =
    process.env["NICEGAL_SERVER_PATH"] ??
    (app.isPackaged
      ? join(packagedDirectory, executableName)
      : join(repositoryDirectory, "target", "debug", executableName));
  const workingDirectory = app.isPackaged ? packagedDirectory : repositoryDirectory;
  const assetDatabase = join(stateDirectory, "assets.db");
  const ocrDatabase = join(stateDirectory, "index.db");
  const thumbnailDatabase = join(stateDirectory, "thumbnails.db");

  const connection = await backendProcess.start({
    executable,
    workingDirectory,
    assetDatabase,
    ocrDatabase,
    thumbnailDatabase,
  });
  backendClient = new NicegalServerClient(connection.endpoint, connection.token, backendLog);
  await backendClient.health();
  thumbnailReader = new ThumbnailReader(thumbnailDatabase);
  backendStatus.ready = true;
  backendStatus.error = null;
  delete backendStatus.restartReason;
  broadcastBackendStatus();
}

function shutdownBackend(): Promise<void> {
  // Provider fallback and app quit can overlap. NicegalServerProcess.stop() detaches its child
  // immediately, so a second stop alone would resolve before the first process has really exited.
  // All callers must await the same drain before respawning or letting an installer run.
  backendShutdown ??= drainBackend().finally(() => {
    backendShutdown = null;
  });
  return backendShutdown;
}

async function drainBackend(): Promise<void> {
  backendStatus.ready = false;
  broadcastBackendStatus();
  thumbnailReader?.close();
  thumbnailReader = null;
  backendClient = null;
  await backendProcess?.stop();
  backendProcess = null;
  await backendLog?.close();
  backendLog = null;
}

function formatBackendError(error: unknown): string {
  const diagnostic = backendProcess?.getDiagnostic() ?? "";
  const message = stripVTControlCharacters(error instanceof Error ? error.message : String(error));
  return diagnostic && !message.includes(diagnostic) ? `${message}\n${diagnostic}` : message;
}

if (app.requestSingleInstanceLock()) {
  app.on("second-instance", focusMainWindow);

  app.whenReady().then(async () => {
    installContentSecurityPolicy();
    installApplicationMenu();
    // Chromium needs the handlers before the first renderer navigation. Readers become available
    // after startup and can be replaced on backend restart without re-registering the protocols.
    installProtocolHandlers({
      rendererDirectory: join(__dirname, "../renderer"),
      getCatalog: () => backendClient,
      getThumbnails: () => thumbnailReader,
    });
    createWindow();
    updates = startUpdates(isTrustedRenderer, () => {
      restartForUpdate = true;
      app.quit();
    });

    try {
      await initializeBackend();
    } catch (error) {
      backendStatus.error = formatBackendError(error);
      backendLog?.write("desktop", "initialization-failed", { error: backendStatus.error });
      console.error("Failed to initialize nicegal-server", error);
      await shutdownBackend();
    }

    app.on("activate", focusMainWindow);
  });

  app.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    updates?.stop();
    void shutdownBackend()
      .then(() => {
        if (restartForUpdate) updates?.installAndRestart();
      })
      .catch((error: unknown) => {
        // A locked backend binary must never be replaced by the on-quit installer.
        updates?.deferInstallation();
        console.error("Backend shutdown failed; deferring any downloaded update", error);
      })
      .finally(() => {
        shutdownComplete = true;
        app.quit();
      });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
} else {
  console.info("Nicegal is already running; exiting this instance.");
  app.quit();
}
