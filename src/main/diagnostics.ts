import AdmZip from "adm-zip";
import { app, dialog, type BrowserWindow } from "electron";
import { open } from "node:fs/promises";
import { release, type as osType, version as osVersion } from "node:os";
import { join } from "node:path";
import { arch, platform, versions } from "node:process";

import type { BackendStatus } from "../shared/backend";
import type { AppInfo } from "../shared/diagnostics";

declare const __NICEGAL_FRONTEND_COMMIT__: string;
declare const __NICEGAL_BACKEND_COMMIT__: string;

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const RECENT_LOG_BYTES = 64 * 1024;
const RECENT_LOG_LINES = 12;
const REDACTED_PATH = "[redacted local path]";
const WINDOWS_PATH = /(?:^|[^A-Za-z0-9_])[A-Za-z]:[\\/]/;
const UNC_PATH = /\\\\(?:\?\\)?[^\\\s]+\\[^\\\s]+/;
const POSIX_PATH =
  /(?:^|[\s"'=(])\/(?:Users|home|mnt|media|Volumes|var|tmp|opt|etc|private|run|srv|root|Applications)\//i;
const LABELED_POSIX_PATH = /\b(?:path|directory|folder|file|root)\s*[=:]\s*\/(?!\/)/i;

interface DiagnosticFile {
  archiveName: string;
  data: Buffer;
  originalBytes: number;
  truncated: boolean;
}

interface CollectionOptions {
  backendStatus: BackendStatus;
  flushBackendLog: () => Promise<void>;
}

export function getAppInfo(): AppInfo {
  return {
    appVersion: app.getVersion(),
    electronVersion: versions.electron ?? "unknown",
    frontendCommit: __NICEGAL_FRONTEND_COMMIT__,
    backendCommit: __NICEGAL_BACKEND_COMMIT__,
  };
}

/** A short, unredacted excerpt for the local crash dialog. ZIP exports are sanitized separately. */
export async function recentBackendLog(): Promise<string> {
  const stateDirectory =
    process.env["NICEGAL_STATE_DIR"] ?? join(app.getPath("userData"), "nicegal-server");
  const file = await readFileTail(
    "backend.log",
    join(stateDirectory, "backend.log"),
    RECENT_LOG_BYTES,
  );
  if (!file) return "Backend log is unavailable.";
  const text = file.data.toString("utf8");
  const firstNewline = text.indexOf("\n");
  const complete = file.truncated ? (firstNewline < 0 ? "" : text.slice(firstNewline + 1)) : text;
  const lines = complete.trimEnd().split("\n").filter(Boolean).slice(-RECENT_LOG_LINES);
  return (
    lines.map((line) => (line.length > 1200 ? `${line.slice(0, 1200)}…` : line)).join("\n") ||
    "Backend log has no recent entries."
  );
}

export async function collectDiagnostics(
  owner: BrowserWindow,
  options: CollectionOptions,
): Promise<string | null> {
  const result = await dialog.showSaveDialog(owner, {
    title: "Save diagnostics",
    defaultPath: join(app.getPath("documents"), diagnosticArchiveName()),
    filters: [{ name: "ZIP archive", extensions: ["zip"] }],
  });
  if (result.canceled || !result.filePath) return null;

  const issues: string[] = [];
  try {
    await options.flushBackendLog();
  } catch (error) {
    issues.push(`Could not flush the current backend log: ${formatError(error)}`);
  }

  const stateDirectory =
    process.env["NICEGAL_STATE_DIR"] ?? join(app.getPath("userData"), "nicegal-server");
  const requestedFiles = [
    { archiveName: "backend.log", path: join(stateDirectory, "backend.log"), limit: MAX_LOG_BYTES },
    {
      archiveName: "backend.log.1",
      path: join(stateDirectory, "backend.log.1"),
      limit: MAX_LOG_BYTES,
    },
    {
      archiveName: "backend.log.2",
      path: join(stateDirectory, "backend.log.2"),
      limit: MAX_LOG_BYTES,
    },
    {
      archiveName: "runtime.json",
      path: join(stateDirectory, "runtime.json"),
      limit: MAX_SETTINGS_BYTES,
    },
  ];
  const files: DiagnosticFile[] = [];
  for (const request of requestedFiles) {
    try {
      const file = await readFileTail(request.archiveName, request.path, request.limit);
      if (file) files.push(sanitizeDiagnosticFile(file));
    } catch (error) {
      issues.push(
        `Could not include ${request.archiveName}: ${redactDiagnosticString(formatError(error))}`,
      );
    }
  }

  const info = getAppInfo();
  const manifest = {
    collectedAt: new Date().toISOString(),
    application: {
      name: app.getName(),
      version: info.appVersion,
      packaged: app.isPackaged,
      frontendCommit: info.frontendCommit,
      backendCommit: info.backendCommit,
    },
    runtime: {
      electron: info.electronVersion,
      chrome: versions.chrome ?? "unknown",
      node: versions.node,
    },
    system: {
      platform,
      architecture: arch,
      type: osType(),
      release: release(),
      version: osVersion(),
    },
    backend: sanitizeDiagnosticValue(options.backendStatus),
    files: files.map(({ archiveName, originalBytes, data, truncated }) => ({
      name: archiveName,
      originalBytes,
      includedBytes: data.byteLength,
      truncated,
    })),
    issues: issues.map(redactDiagnosticString),
  };

  const archive = new AdmZip();
  archive.addFile("diagnostics.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  for (const file of files) archive.addFile(file.archiveName, file.data);

  await archive.writeZipPromise(result.filePath, { overwrite: true });
  return result.filePath;
}

function sanitizeDiagnosticFile(file: DiagnosticFile): DiagnosticFile {
  const text = file.data.toString("utf8");
  let sanitized: string;
  if (file.archiveName === "runtime.json") {
    sanitized = `${JSON.stringify(sanitizeDiagnosticValue(JSON.parse(text)), null, 2)}\n`;
  } else {
    const firstNewline = text.indexOf("\n");
    const complete = file.truncated ? (firstNewline < 0 ? "" : text.slice(firstNewline + 1)) : text;
    sanitized = complete.split("\n").filter(Boolean).map(sanitizeLogLine).join("\n");
    if (sanitized) sanitized += "\n";
  }
  return { ...file, data: Buffer.from(sanitized, "utf8") };
}

function sanitizeLogLine(line: string): string {
  try {
    return JSON.stringify(sanitizeDiagnosticValue(JSON.parse(line)));
  } catch {
    return redactDiagnosticString(line);
  }
}

function sanitizeDiagnosticValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    const route = /^\/v1(?:\/|$)/.test(value);
    if (/path|folder|directory|file/i.test(key) && value.startsWith("/") && !route)
      return REDACTED_PATH;
    return redactDiagnosticString(value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeDiagnosticValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, sanitizeDiagnosticValue(item, name)]),
    );
  }
  return value;
}

function redactDiagnosticString(value: string): string {
  return WINDOWS_PATH.test(value) ||
    UNC_PATH.test(value) ||
    POSIX_PATH.test(value) ||
    LABELED_POSIX_PATH.test(value)
    ? REDACTED_PATH
    : value;
}

async function readFileTail(
  archiveName: string,
  path: string,
  limit: number,
): Promise<DiagnosticFile | null> {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  try {
    const stats = await file.stat();
    if (!stats.isFile()) return null;
    const includedBytes = Math.min(stats.size, limit);
    const data = Buffer.alloc(includedBytes);
    const { bytesRead } = await file.read(data, 0, includedBytes, stats.size - includedBytes);
    return {
      archiveName,
      data: bytesRead === data.byteLength ? data : data.subarray(0, bytesRead),
      originalBytes: stats.size,
      truncated: stats.size > includedBytes,
    };
  } finally {
    await file.close();
  }
}

function diagnosticArchiveName(): string {
  const timestamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-").replace("T", "-");
  return `nicegal-diagnostics-${timestamp}.zip`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
