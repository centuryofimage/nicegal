import {
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  shell,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { AppInfo } from "../../shared/diagnostics";
import type { NicegalServerClient } from "../backend/nicegal-server-client";
import type { IpcSenderValidator } from "../ipc";

import appIcon from "../../../resources/icon.png?asset";
import licenseInformation from "../../../resources/licenses/license-information.html?asset&asarUnpack";
import { IPC_CHANNELS } from "../../shared/ipc-channels";
import { handleTrustedIpc } from "../ipc";
import {
  copyFilePaths,
  copyFiles,
  openFiles,
  resolveFileTargets,
  revealFile,
  type ResolvedFileTarget,
} from "./file-actions";

export interface NativeIpcContext {
  isTrustedSender: IpcSenderValidator;
  readonly client: NicegalServerClient | null;
  getAppInfo: () => AppInfo;
  collectDiagnostics: (owner: BrowserWindow) => Promise<string | null>;
}

/** Main-process capabilities backed by Electron/OS APIs rather than the search backend. */
export function registerNativeIpc(context: NativeIpcContext): void {
  handleTrustedIpc(IPC_CHANNELS.native.appInfo, context.isTrustedSender, () =>
    context.getAppInfo(),
  );
  handleTrustedIpc(
    IPC_CHANNELS.native.collectDiagnostics,
    context.isTrustedSender,
    async (event) => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner) throw new Error("Diagnostics require an owning application window");
      return context.collectDiagnostics(owner);
    },
  );
  // One preparation per renderer. Tokens keep resolved paths on the trusted side and prevent
  // an older lookup from replacing a newer gesture while the backend is responding.
  const drags = new WeakMap<
    WebContents,
    { token: string; files: ResolvedFileTarget[]; expires: number }
  >();
  const dragIcon = nativeImage.createFromPath(appIcon).resize({ width: 32, height: 32 });
  handleTrustedIpc(
    IPC_CHANNELS.native.prepareFileDrag,
    context.isTrustedSender,
    async (event, value) => {
      if (!context.client) throw new Error("File dragging requires the catalog backend");
      const ids = parseAssetIds(value, 100_000);
      const drag = {
        token: randomUUID(),
        files: [] as ResolvedFileTarget[],
        expires: Date.now() + 30_000,
      };
      drags.set(event.sender, drag);
      const files: ResolvedFileTarget[] = [];
      for (let offset = 0; offset < ids.length; offset += 512) {
        files.push(...(await resolveFileTargets(context.client, ids.slice(offset, offset + 512))));
        if (drags.get(event.sender) !== drag || event.sender.isDestroyed())
          throw new Error("File drag was superseded");
      }
      if (files.length !== ids.length)
        throw new Error(
          "Some selected files are no longer available. Refresh the library and try again.",
        );
      if (drags.get(event.sender) !== drag || event.sender.isDestroyed())
        throw new Error("File drag was superseded");
      drag.files = files;
      return drag.token;
    },
  );
  handleTrustedIpc(IPC_CHANNELS.native.startFileDrag, context.isTrustedSender, (event, token) => {
    const drag = drags.get(event.sender);
    if (!drag || drag.token !== token || !drag.files.length || drag.expires < Date.now()) {
      throw new Error("File drag expired. Drag the selection again.");
    }
    drags.delete(event.sender);
    // Electron on Windows/Linux advertises COPY | LINK, never MOVE. There is deliberately no
    // source-file cleanup. The user accepted shortcuts as well as copies (2026-09-14).
    event.sender.startDrag({
      file: drag.files[0].path,
      files: drag.files.map((file) => file.path),
      icon: dragIcon,
    });
  });
  handleTrustedIpc(
    IPC_CHANNELS.native.openExternalUrl,
    context.isTrustedSender,
    async (_event, value) => {
      if (typeof value !== "string") throw new TypeError("Expected a web link");
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new TypeError("Only HTTPS links without credentials can be opened");
      }
      await shell.openExternal(url.href);
    },
  );
  handleTrustedIpc(
    IPC_CHANNELS.native.openLicenseInformation,
    context.isTrustedSender,
    async () => {
      // Fixed unpacked asset: the renderer cannot supply an arbitrary local path.
      const error = await shell.openPath(licenseInformation);
      if (error) throw new Error(error);
    },
  );
  handleTrustedIpc(
    IPC_CHANNELS.native.chooseDirectory,
    context.isTrustedSender,
    async (event, defaultPath: unknown) => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner) throw new Error("Directory picker requires an owning application window");
      if (
        defaultPath !== undefined &&
        (typeof defaultPath !== "string" || !isAbsolute(defaultPath))
      )
        throw new TypeError("Invalid directory picker start folder");
      const result = await dialog.showOpenDialog(owner, {
        properties: ["openDirectory"],
        ...(defaultPath === undefined ? {} : { defaultPath }),
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );

  handleTrustedIpc(
    IPC_CHANNELS.native.chooseVisualSearchImage,
    context.isTrustedSender,
    async (event) => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner) throw new Error("Image picker requires an owning application window");
      const result = await dialog.showOpenDialog(owner, {
        properties: ["openFile"],
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] }],
      });
      const path = result.canceled ? undefined : result.filePaths[0];
      if (!path) return null;
      const info = await stat(path);
      const limit = 16 * 1024 * 1024;
      if (!info.isFile() || info.size > limit) {
        throw new Error("Choose an image smaller than 16 MB for visual search.");
      }
      const bytes = await readFile(path);
      return {
        displayName: path.split(/[\\/]/).pop() ?? "Selected image",
        bytesBase64: bytes.toString("base64"),
      };
    },
  );

  handleTrustedIpc(
    IPC_CHANNELS.native.showFileContextMenu,
    context.isTrustedSender,
    async (event, value: unknown) => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner) throw new Error("File menu requires an owning application window");
      if (!context.client) throw new Error("File actions require the catalog backend");

      const files = await resolveFileTargets(context.client, parseAssetIds(value));
      if (!files.length) return;
      Menu.buildFromTemplate(
        fileMenuTemplate(owner, files, (replace) =>
          event.sender.send(
            IPC_CHANNELS.native.addToVisualSearch,
            files.map((file) => file.id),
            replace,
          ),
        ),
      ).popup({ window: owner });
    },
  );
}

function parseAssetIds(value: unknown, limit = 512): string[] {
  if (!value || typeof value !== "object" || !("assetIds" in value)) {
    throw new TypeError("File action request must contain assetIds");
  }
  const assetIds = (value as { assetIds?: unknown }).assetIds;
  if (!Array.isArray(assetIds) || assetIds.length < 1 || assetIds.length > limit) {
    throw new TypeError(`File actions require between 1 and ${limit} asset IDs`);
  }
  const unique = new Set<string>();
  for (const id of assetIds) {
    if (typeof id !== "string" || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
      throw new TypeError("File action asset IDs must be safe positive decimal strings");
    }
    unique.add(id);
  }
  return [...unique];
}

function fileMenuTemplate(
  owner: BrowserWindow,
  files: readonly ResolvedFileTarget[],
  visualSearch: (replace: boolean) => void,
): MenuItemConstructorOptions[] {
  const multiple = files.length > 1;
  return [
    {
      label: "Find similar images",
      click: () => visualSearch(true),
    },
    {
      label: multiple ? `Add ${files.length} images to visual search` : "Add to visual search",
      click: () => visualSearch(false),
    },
    { type: "separator" },
    {
      label: multiple ? `Open ${files.length} items in default apps` : "Open in default app",
      click: () => runFileAction(owner, "Open failed", () => openFiles(files)),
    },
    { type: "separator" },
    {
      label: multiple ? `Copy ${files.length} items` : "Copy",
      click: () => runFileAction(owner, "Copy failed", () => copyFiles(files)),
    },
    {
      label: multiple ? `Copy ${files.length} paths` : "Copy as path",
      click: () => runFileAction(owner, "Copy as Path failed", () => copyFilePaths(files)),
    },
    { type: "separator" },
    {
      label: revealLabel(multiple),
      click: () => runFileAction(owner, "Reveal failed", () => revealFile(files[0])),
    },
  ];
}

function revealLabel(multiple: boolean): string {
  if (process.platform === "darwin")
    return multiple ? "Reveal clicked item in Finder" : "Reveal in Finder";
  if (process.platform === "win32")
    return multiple ? "Reveal clicked item in Explorer" : "Reveal in Explorer";
  return multiple ? "Open clicked item's folder" : "Open Containing Folder";
}

function runFileAction(owner: BrowserWindow, title: string, action: () => Promise<void>): void {
  void action().catch((error: unknown) =>
    dialog.showMessageBox(owner, {
      type: "error",
      title,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}
