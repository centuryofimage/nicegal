import { app, BrowserWindow, net, powerMonitor, shell, type IpcMainInvokeEvent } from "electron";
import { autoUpdater } from "electron-updater";
import { existsSync } from "node:fs";
import { join, win32 } from "node:path";

import type { UpdateStatus } from "../shared/updates";

import { IPC_CHANNELS } from "../shared/ipc-channels";
import { handleTrustedIpc } from "./ipc";
import { loadAutomaticUpdates, saveAutomaticUpdates } from "./update-preferences";

declare const __NICEGAL_RELEASE_UPDATES__: boolean;

const RELEASES = "https://github.com/centuryofimage/nicegal/releases";
const LATEST_RELEASE_API = "https://api.github.com/repos/centuryofimage/nicegal/releases/latest";
/** Unauthenticated GitHub API calls are rate limited per IP, so long sessions check daily at most. */
const DAILY_CHECK_MS = 24 * 60 * 60 * 1000;

const MAX_NOTES = 20;
const MAX_NOTE_LENGTH = 300;

/** Pulls the changelog bullets out of a release body as plain text, ignoring everything after
 * the first heading that follows them (the generated download table). */
export function releaseNotes(body: unknown): string[] {
  if (typeof body !== "string") return [];
  const notes: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*#/.test(line) && notes.length > 0) break;
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (!bullet) continue;
    const text = bullet[1]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*\*|`/g, "")
      .trim();
    if (text) notes.push(text.slice(0, MAX_NOTE_LENGTH));
    if (notes.length === MAX_NOTES) break;
  }
  return notes;
}

/** GitHub's web /releases/latest redirects; updater feed requests expect JSON from it. */
export async function latestStableRelease(): Promise<{
  version: string;
  feedUrl: string;
  notes: string[];
}> {
  const response = await net.fetch(LATEST_RELEASE_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "nicegal-updater",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Latest release lookup failed: HTTP ${response.status}`);
  const release: unknown = await response.json();
  if (
    typeof release !== "object" ||
    release === null ||
    !("tag_name" in release) ||
    typeof release.tag_name !== "string" ||
    !/^v\d+\.\d+\.\d+$/.test(release.tag_name) ||
    !("prerelease" in release) ||
    release.prerelease !== false ||
    !("draft" in release) ||
    release.draft !== false
  ) {
    throw new Error("Latest release response is not a stable numeric release");
  }
  return {
    version: release.tag_name.slice(1),
    feedUrl: `${RELEASES}/download/${release.tag_name}`,
    notes: "body" in release ? releaseNotes(release.body) : [],
  };
}

export function isNewerRelease(latest: string, current: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(latest) || !/^\d+\.\d+\.\d+$/.test(current)) return false;
  const latestParts = latest.split(".").map(BigInt);
  const currentParts = current.split(".").map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (latestParts[index] !== currentParts[index]) return latestParts[index] > currentParts[index];
  }
  return false;
}

/** Only the NSIS installer creates this marker; ZIP/portable share the same app payload. */
export function isProgramFilesInstallation(
  executable: string,
  environment: NodeJS.ProcessEnv,
): boolean {
  const root = win32.parse(executable).root;
  const directories = [
    environment.ProgramFiles,
    environment.ProgramW6432,
    environment["ProgramFiles(x86)"],
    ...(root ? [win32.join(root, "Program Files"), win32.join(root, "Program Files (x86)")] : []),
  ];
  return directories.some((directory) => {
    if (!directory) return false;
    const relative = win32.relative(directory.toLowerCase(), executable.toLowerCase());
    return (
      relative !== ".." && !relative.startsWith(`..${win32.sep}`) && !win32.isAbsolute(relative)
    );
  });
}

export function supportsAutomaticUpdates(
  packaged: boolean,
  platform: string,
  installed: boolean,
  environment: NodeJS.ProcessEnv,
  executable: string = process.execPath,
): boolean {
  if (!packaged || environment.FLATPAK_ID) return false;
  if (platform === "win32")
    return (
      installed &&
      !environment.PORTABLE_EXECUTABLE_FILE &&
      !isProgramFilesInstallation(executable, environment)
    );
  return platform === "linux" && Boolean(environment.APPIMAGE);
}

/** Main-process ownership keeps checks independent of gallery navigation and renderer reloads. */
export function startUpdates(
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
  requestRestart: () => void,
  platform: NodeJS.Platform = process.platform,
  releaseBuild: boolean = __NICEGAL_RELEASE_UPDATES__,
): {
  stop: () => void;
  deferInstallation: () => void;
  installAndRestart: () => boolean;
} {
  const supported = supportsAutomaticUpdates(
    app.isPackaged && releaseBuild,
    platform,
    existsSync(join(process.resourcesPath, "nicegal-installed")),
    process.env,
    app.getPath("exe"),
  );
  // Flatpak updates belong to the user's Flatpak installation/repository. A GitHub
  // notification would send them to a different package format rather than updating it.
  const notifyOnly = app.isPackaged && releaseBuild && !supported && !process.env.FLATPAK_ID;
  const mode = supported ? "automatic" : notifyOnly ? "notify" : "none";
  const preferencesPath = join(app.getPath("userData"), "update-settings.json");
  let automaticUpdates = loadAutomaticUpdates(preferencesPath);
  // Once disabled, this launch stays opted out even if re-enabled. No second check, and no
  // accidentally re-armed cached installer; enabling takes effect on the next launch.
  let disabledForSession = !automaticUpdates;
  let cancelDownload: (() => void) | undefined;
  let installationDeferred = false;
  let restartRequested = false;
  const mayUpdate = (): boolean => supported && !disabledForSession;
  const mayNotify = (): boolean => notifyOnly && !disabledForSession;
  const enabled = mayUpdate() || mayNotify();
  let status: UpdateStatus = { phase: enabled ? "idle" : "disabled", version: null, notes: [] };
  // The release lookup's notes, matched by version to what the updater reports.
  let latest: { version: string; notes: string[] } | undefined;
  let stopped = false;
  const timers: {
    initial?: ReturnType<typeof setTimeout>;
  } = {};

  const publish = (phase: UpdateStatus["phase"], version: string | null = null): void => {
    status = { phase, version, notes: version && latest?.version === version ? latest.notes : [] };
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed())
        window.webContents.send(IPC_CHANNELS.updates.statusChanged, status);
    }
  };
  const hasDownload = (): boolean => status.phase === "ready";
  handleTrustedIpc(IPC_CHANNELS.updates.status, isTrustedSender, () => status);
  handleTrustedIpc(IPC_CHANNELS.updates.preferences, isTrustedSender, () => ({
    enabled: automaticUpdates,
    mode,
  }));
  handleTrustedIpc(IPC_CHANNELS.updates.setEnabled, isTrustedSender, (_event, value: unknown) => {
    if (typeof value !== "boolean") throw new Error("Automatic updates must be a boolean");
    // Persist first: failed writes must not report a preference as saved.
    saveAutomaticUpdates(preferencesPath, value);
    automaticUpdates = value;
    if (!value) {
      disabledForSession = true;
      clearTimeout(timers.initial);
      if (supported) autoUpdater.autoInstallEvent = "manual";
      cancelDownload?.();
      publish("disabled");
    }
    return { enabled: automaticUpdates, mode };
  });
  handleTrustedIpc(IPC_CHANNELS.updates.releaseNotes, isTrustedSender, async () => {
    if ((status.phase !== "ready" && status.phase !== "available") || !status.version) return;
    // Never navigate to arbitrary URLs supplied by release metadata or by the renderer.
    await shell.openExternal(`${RELEASES}/tag/v${encodeURIComponent(status.version)}`);
  });
  handleTrustedIpc(IPC_CHANNELS.updates.restartAndInstall, isTrustedSender, () => {
    if (!mayUpdate() || status.phase !== "ready") throw new Error("No update is ready to install");
    if (restartRequested) return;
    restartRequested = true;
    // Let the IPC response reach the renderer before before-quit closes its window.
    setImmediate(() => {
      if (!stopped && mayUpdate() && status.phase === "ready") requestRestart();
    });
  });

  const deferInstallation = (): void => {
    installationDeferred = true;
    autoUpdater.autoInstallEvent = "manual";
  };
  const installAndRestart = (): boolean => {
    if (!mayUpdate() || status.phase !== "ready" || installationDeferred) return false;
    // Called only after index.ts drains the backend. The normal on-quit hook uses
    // install(true, false), which cannot relaunch the app after installation.
    autoUpdater.quitAndInstall({ isSilent: true, isForceRunAfter: true });
    return true;
  };
  let runCheck: (() => Promise<void>) | undefined;
  let checkInFlight = false;
  let lastCheckAt = 0;
  const startCheck = (): void => {
    if (!runCheck || checkInFlight || stopped) return;
    checkInFlight = true;
    lastCheckAt = Date.now();
    void runCheck().finally(() => {
      checkInFlight = false;
    });
  };
  const checkIfDue = (): void => {
    if (disabledForSession || Date.now() - lastCheckAt < DAILY_CHECK_MS) return;
    // A download in progress or waiting for restart already has what a check would find.
    if (status.phase === "downloading" || status.phase === "ready") return;
    startCheck();
  };
  const watchFocus = (window: BrowserWindow): void => {
    window.on("focus", checkIfDue);
  };
  const onWindowCreated = (_event: Electron.Event, window: BrowserWindow): void =>
    watchFocus(window);
  /** One check shortly after launch, then again on focus (including reopening from the tray)
   * once a day has passed. Nothing polls while the app sits hidden. */
  const scheduleChecks = (run: () => Promise<void>): void => {
    runCheck = run;
    lastCheckAt = Date.now();
    timers.initial = setTimeout(startCheck, 5_000);
    timers.initial.unref();
    BrowserWindow.getAllWindows().forEach(watchFocus);
    app.on("browser-window-created", onWindowCreated);
  };
  const stop = (): void => {
    stopped = true;
    clearTimeout(timers.initial);
    for (const window of BrowserWindow.getAllWindows()) window.off("focus", checkIfDue);
    app.off("browser-window-created", onWindowCreated);
  };
  if (mayNotify()) {
    const checkRelease = async (): Promise<void> => {
      try {
        const release = await latestStableRelease();
        if (stopped || !mayNotify()) return;
        latest = release;
        const available = isNewerRelease(release.version, app.getVersion());
        publish(available ? "available" : "idle", available ? release.version : null);
      } catch (error) {
        console.error("Release notification check failed", error);
        if (!stopped && mayNotify()) publish("error");
      }
    };
    scheduleChecks(checkRelease);
    return { stop, deferInstallation, installAndRestart };
  }
  if (!enabled) {
    autoUpdater.autoInstallEvent = "manual";
    return { stop, deferInstallation, installAndRestart };
  }

  autoUpdater.logger = console;
  // Start the download explicitly so opting out while the feed request is in flight cannot
  // start an unwanted download, and so we hold its cancellation token before work begins.
  autoUpdater.autoDownload = false;
  // Its on-quit install hook runs AFTER index.ts's asynchronous before-quit backend drain.
  // Do not call quitAndInstall(): that starts the installer before the backend has stopped.
  autoUpdater.autoInstallEvent = "onQuit";
  autoUpdater.autoRunAppAfterInstall = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.channel = "latest";
  autoUpdater.allowDowngrade = false; // Setting the channel enables downgrades unless reset.
  autoUpdater.disableWebInstaller = true;
  autoUpdater.disableDifferentialDownload = false;

  // Keep installation disarmed during OS shutdown/logoff, leaving the verified download cached.
  powerMonitor.on("shutdown", deferInstallation);
  const watchWindow = (window: BrowserWindow): void => {
    window.on("query-session-end", deferInstallation);
    window.on("session-end", deferInstallation);
  };
  BrowserWindow.getAllWindows().forEach(watchWindow);
  app.on("browser-window-created", (_event, window) => watchWindow(window));

  autoUpdater.on("checking-for-update", () => {
    if (mayUpdate()) publish("checking");
  });
  autoUpdater.on("update-available", (info) => {
    if (mayUpdate()) publish("downloading", info.version);
  });
  autoUpdater.on("update-not-available", () => {
    if (mayUpdate()) publish("idle");
  });
  autoUpdater.on("update-downloaded", (info) => {
    if (mayUpdate()) publish("ready", info.version);
  });
  autoUpdater.on("error", (error) => {
    console.error("Automatic update failed", error);
    // A later installation error must not pretend the downloaded update disappeared.
    if (mayUpdate() && status.phase !== "ready") publish("error");
  });

  const check = async (): Promise<void> => {
    if (stopped || !mayUpdate()) return;
    try {
      const release = await latestStableRelease();
      if (stopped || !mayUpdate()) return;
      latest = release;
      // Keep electron-updater's verified NSIS/AppImage downloads and versioned blockmap URLs,
      // while bypassing its GitHub provider's broken /releases/latest JSON lookup. GitHub release
      // assets answer multi-range requests with 501, which silently turns every differential
      // download into a full one, so fetch changed blocks one range at a time like its provider.
      autoUpdater.setFeedURL({
        provider: "generic",
        url: release.feedUrl,
        useMultipleRangeRequest: false,
      });
      const result = await autoUpdater.checkForUpdates();
      if (!result?.isUpdateAvailable || stopped || !mayUpdate()) return;
      const token = result.cancellationToken;
      if (!token) throw new Error("Update check returned no download cancellation token");
      cancelDownload = () => token.cancel();
      await autoUpdater.downloadUpdate(token);
    } catch (error) {
      console.error("Automatic update check/download failed", error);
      if (mayUpdate() && !hasDownload()) publish("error");
    } finally {
      cancelDownload = undefined;
    }
  };
  scheduleChecks(check);
  return { stop, deferInstallation, installAndRestart };
}
