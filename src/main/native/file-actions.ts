import { clipboard, ClipboardItem, shell } from "electron";
import { dirname, isAbsolute, posix } from "node:path";
import { pathToFileURL } from "node:url";

import type { NicegalServerClient } from "../backend/nicegal-server-client";

export interface ResolvedFileTarget {
  id: string;
  path: string;
  hostPath?: string;
  displayName: string;
}

/** Paths exported to host apps must not use the sandbox-only /run/flatpak/doc
 * spelling. Old portals lack host-path xattrs, but their host document mount
 * still gives other applications a usable reference to the granted file. */
export function externalFilePath(
  file: ResolvedFileTarget,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (file.hostPath) return file.hostPath;
  const prefix = "/run/flatpak/doc/";
  if (environment.FLATPAK_ID && file.path.startsWith(prefix) && environment.XDG_RUNTIME_DIR) {
    return posix.join(environment.XDG_RUNTIME_DIR, "doc", file.path.slice(prefix.length));
  }
  return file.path;
}

/** Resolves renderer-owned IDs at the trusted Rust boundary for menus and native dragging,
 * without exposing paths to the renderer or adding another catalog read path. */
export async function resolveFileTargets(
  client: NicegalServerClient,
  assetIds: readonly string[],
): Promise<ResolvedFileTarget[]> {
  const response = await client.resolveAssets(assetIds);
  const byId = new Map(
    response.assets
      .filter((asset) => isAbsolute(asset.path))
      .map((asset) => [
        asset.id,
        {
          id: asset.id,
          path: asset.path,
          hostPath: asset.hostPath,
          displayName: asset.displayName,
        },
      ]),
  );
  return assetIds.flatMap((id) => {
    const target = byId.get(id);
    return target ? [target] : [];
  });
}

export async function openFiles(files: readonly ResolvedFileTarget[]): Promise<void> {
  const results = await Promise.all(
    files.map(async (file) => ({ file, error: await shell.openPath(file.path) })),
  );
  const failures = results.filter((result) => result.error);
  if (failures.length) {
    throw new Error(failures.map(({ file, error }) => `${file.displayName}: ${error}`).join("\n"));
  }
}

/** Electron can select only one file per reveal. The caller passes the clicked item. */
export async function revealFile(file: ResolvedFileTarget): Promise<void> {
  if (process.platform !== "linux") {
    shell.showItemInFolder(file.path);
    return;
  }

  const error = await shell.openPath(dirname(file.path));
  if (error) throw new Error(`${file.displayName}: ${error}`);
}

/** Places file references on the clipboard rather than exposing paths to renderer code. */
export async function copyFiles(files: readonly ResolvedFileTarget[]): Promise<void> {
  const uriList = `${files.map((file) => pathToFileURL(externalFilePath(file)).href).join("\r\n")}\r\n`;
  await clipboard.write([new ClipboardItem({ "text/uri-list": uriList })]);
}

export async function copyFilePaths(files: readonly ResolvedFileTarget[]): Promise<void> {
  await clipboard.writeText(files.map((file) => externalFilePath(file)).join("\n"));
}
