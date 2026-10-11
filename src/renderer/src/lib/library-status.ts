/**
 * How a library's folders are described in the libraries pane and the Edit dialog. Only what a
 * multi-folder library adds is shown here: a folder that is offline or whose scan was paused.
 * Scan progress, skipped files and failures belong to the toolbar job indicator.
 */
import type { Library, LibraryFolder, ScanOutcome } from "../../../shared/backend";

import { m } from "../../../shared/paraglide/messages.js";
import { rootKey } from "./library-root";

export type StatusTone = "normal" | "attention";

export interface StatusText {
  text: string;
  tone: StatusTone;
  /** Longer explanation, e.g. the backend's error detail, for a tooltip. */
  detail?: string;
}

/** Compact description of the search features enabled for one library. */
export function searchTypesSummary(library: Pick<Library, "image" | "ocr">): string {
  const types = [
    library.image ? m.library_status_image_search() : "",
    library.ocr ? m.library_status_text_recognition() : "",
  ].filter(Boolean);
  return types.length ? types.join(" + ") : m.library_status_search_off();
}

/** Search choices and exclusions shown in both library lists. */
export function libraryOptionsSummary(library: Pick<Library, "image" | "ocr" | "exclude">): string {
  const search = searchTypesSummary(library);
  return library.exclude.length
    ? m.library_status_options_summary({ search, count: library.exclude.length })
    : search;
}

function outcomes(): Partial<Record<ScanOutcome, StatusText>> {
  return {
    unavailable: { text: m.library_status_offline(), tone: "attention" },
    cancelled: { text: m.library_status_paused(), tone: "normal" },
  };
}

export function formatScanTime(ns: string | null): string {
  if (!ns) return "";
  return new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleString();
}

/**
 * One included folder's lasting state, or an empty text when there is nothing to say. `folder`
 * is undefined for a folder added in an unsaved edit.
 */
export function folderStatus(folder: LibraryFolder | undefined): StatusText {
  if (!folder)
    return {
      text: m.library_status_added(),
      tone: "normal",
      detail: m.library_status_added_detail(),
    };
  const outcome = folder.scanOutcome ? outcomes()[folder.scanOutcome] : undefined;
  if (outcome) return { ...outcome, detail: folder.scanError ?? undefined };
  const scanned = formatScanTime(folder.lastScanCompletedNs);
  return {
    text: "",
    tone: "normal",
    detail: scanned ? m.library_status_last_scanned({ time: scanned }) : undefined,
  };
}

/** The selected library's folders that are offline, whose files cannot be shown. */
export function offlineFolders(library: Library | undefined): LibraryFolder[] {
  return library?.include.filter((folder) => folder.scanOutcome === "unavailable") ?? [];
}

/** True when `path` is `parent` or inside it, with the platform's case rule. */
export function isWithin(path: string, parent: string): boolean {
  const normalize = (value: string): string =>
    rootKey(value.replace(/[\\/]+/g, "/").replace(/\/$/, ""));
  const child = normalize(path);
  const ancestor = normalize(parent);
  return child === ancestor || child.startsWith(`${ancestor}/`);
}
