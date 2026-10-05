import AdmZip from "adm-zip";
import { app, dialog, type BrowserWindow } from "electron";
import { open } from "node:fs/promises";
import { release, type as osType, version as osVersion } from "node:os";
import { join } from "node:path";
import { arch, platform, versions } from "node:process";
import { stripVTControlCharacters } from "node:util";

import type { BackendStatus } from "../shared/backend";
import type { AppInfo } from "../shared/diagnostics";

declare const __NICEGAL_FRONTEND_COMMIT__: string;
declare const __NICEGAL_BACKEND_COMMIT__: string;

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const RECENT_LOG_BYTES = 64 * 1024;
const RECENT_LOG_LINES = 12;
const REDACTED_PATH = "[redacted local path]";
// Preserve the error around a path, including an error chain after ": " and stack line numbers.
// Quoted paths may contain spaces; unquoted paths end at punctuation or an error-chain delimiter.
const LOCAL_PATH =
  /(^|[\s"'`=(:])(?:file:\/\/\/?)?(?:[A-Za-z]:[\\/]|\\\\(?:\?\\)?|\/(?!v1(?:\/|\b)))[^\r\n"'`<>|:;,()[\]]+/gm;

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

export function getSystemInfo(): Record<string, string> {
  return { platform, architecture: arch, type: osType(), release: release(), version: osVersion() };
}

export async function getGpuInfo(): Promise<unknown> {
  return {
    source: "Electron/Chromium adapter inventory; ONNX Runtime may select a different adapter",
    info: await withDeadline(app.getGPUInfo("complete"), 3_000, "reading GPU information"),
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
    await withDeadline(options.flushBackendLog(), 3_000, "flushing the desktop log");
  } catch (error) {
    issues.push(`Could not flush the current backend log: ${formatError(error)}`);
  }

  const stateDirectory =
    process.env["NICEGAL_STATE_DIR"] ?? join(app.getPath("userData"), "nicegal-server");
  const requestedFiles = [
    ...["backend.log", "nicegal-server.log", "nicegal-panic.log"].flatMap((base) =>
      ["", ".1", ".2"].map((suffix) => ({
        archiveName: base + suffix,
        path: join(stateDirectory, base + suffix),
        limit: MAX_LOG_BYTES,
      })),
    ),
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

  const gpu = await collectOptional("GPU information", getGpuInfo, issues);
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
      ...getSystemInfo(),
      // Chromium's adapter inventory is not proof of the device ONNX Runtime selected.
      gpu: sanitizeDiagnosticValue(gpu),
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
  return stripVTControlCharacters(value).replace(
    LOCAL_PATH,
    (_match, prefix: string) => `${prefix}${REDACTED_PATH}`,
  );
}

async function collectOptional(
  label: string,
  collect: () => Promise<unknown>,
  issues: string[],
): Promise<unknown> {
  try {
    return await collect();
  } catch (error) {
    issues.push(`Could not collect ${label}: ${formatError(error)}`);
    return null;
  }
}

async function withDeadline<T>(
  task: Promise<T>,
  milliseconds: number,
  operation: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
