import { isAbsolute, posix, win32 } from "node:path";

import type { Library, NativeFolderMenuRequest } from "../../shared/backend";

import { m } from "../../shared/paraglide/messages.js";

export interface ResolvedFolderTarget {
  /** The backend's spelling, usable by this process. */
  path: string;
  /** The spelling other applications use, e.g. outside a Flatpak sandbox. */
  externalPath: string;
}

function pathApi(path: string): typeof posix {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(path) ? win32 : posix;
}

/** `path` relative to `folder`, or null when it is neither the folder nor inside it. */
function relativeInside(path: string, folder: string): string | null {
  const api = pathApi(folder);
  const relative = api.relative(folder, path);
  if (relative === "") return "";
  if (relative.startsWith("..") || api.isAbsolute(relative)) return null;
  return relative;
}

/**
 * Accepts a renderer-supplied folder only when it lies in one of the library's included folders
 * and outside its exclusions, so the menu can't open or copy arbitrary paths.
 */
export function resolveFolderTarget(
  libraries: readonly Library[],
  request: unknown,
): ResolvedFolderTarget & Omit<NativeFolderMenuRequest, "path"> {
  if (!request || typeof request !== "object") throw new TypeError("Expected a folder request");
  const { libraryId, path, canRemove } = request as Record<string, unknown>;
  if (typeof libraryId !== "number" || !Number.isSafeInteger(libraryId))
    throw new TypeError("Folder request needs a library ID");
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 32_768)
    throw new TypeError("Folder request needs an absolute path");
  if (typeof canRemove !== "boolean") throw new TypeError("Folder request needs canRemove");

  const library = libraries.find((candidate) => candidate.id === libraryId);
  if (!library) throw new Error(m.common_library_missing());
  for (const root of library.include) {
    const relative = relativeInside(path, root.path);
    if (relative === null) continue;
    if (library.exclude.some((excluded) => relativeInside(path, excluded) !== null)) break;
    const externalPath = root.hostPath
      ? relative
        ? pathApi(root.hostPath).join(root.hostPath, relative)
        : root.hostPath
      : path;
    return { libraryId, path, externalPath, canRemove };
  }
  throw new Error(m.native_folder_not_in_library());
}

export function openFolderLabel(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return m.native_folder_open_in_explorer();
  if (platform === "darwin") return m.native_folder_open_in_finder();
  return m.native_folder_open_in_file_manager();
}
