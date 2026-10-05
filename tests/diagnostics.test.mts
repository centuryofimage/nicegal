import AdmZip from "adm-zip";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createServer } from "vite";

const directory = await mkdtemp(join(tmpdir(), "nicegal-diagnostics-test-"));
const outputPath = join(directory, "nicegal-diagnostics.zip");
const dialogResult = { canceled: false, filePath: outputPath };
const calls = { flushes: 0 };
let gpuFailure = false;
const mocks = {
  app: {
    getVersion: () => "1.2.3",
    getName: () => "Nicegal",
    getPath: () => directory,
    isPackaged: true,
    getGPUInfo: async () => {
      if (gpuFailure) throw new Error("GPU unavailable");
      return { gpuDevice: [{ vendorId: 4318, deviceId: 1234, driverVersion: "test-driver" }] };
    },
  },
  dialog: {
    showSaveDialog: async () => dialogResult,
  },
};
Object.assign(globalThis, { __diagnosticMocks: mocks });
process.env["NICEGAL_STATE_DIR"] = directory;

const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-diagnostics-tests",
  define: {
    __NICEGAL_FRONTEND_COMMIT__: JSON.stringify("front1234567"),
    __NICEGAL_BACKEND_COMMIT__: JSON.stringify("back12345678"),
  },
  plugins: [
    {
      name: "mock-diagnostics-electron",
      enforce: "pre",
      resolveId: (id) => (id === "electron" ? "\0diagnostics-electron" : undefined),
      load: (id) =>
        id === "\0diagnostics-electron"
          ? `export const app = globalThis.__diagnosticMocks.app;
             export const dialog = globalThis.__diagnosticMocks.dialog;`
          : undefined,
    },
  ],
  ssr: { noExternal: ["electron"] },
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});

after(async () => {
  delete process.env["NICEGAL_STATE_DIR"];
  await vite.close();
  await rm(directory, { recursive: true, force: true });
});

const diagnostics = await vite.ssrLoadModule("/src/main/diagnostics.ts");

test("collectDiagnostics saves build details and backend files in a zip", async () => {
  const privatePath = String.raw`C:\Users\someone\Pictures\private.jpg`;
  const networkPath = String.raw`\\nas\photos\family.jpg`;
  const posixPath = "/home/alice/photos/private.jpg";
  const entries = [
    { source: "desktop", event: "server-spawned", data: { executable: privatePath } },
    {
      source: "job",
      event: "snapshot",
      data: { folders: [{ path: privatePath }, { path: networkPath }, { path: posixPath }] },
    },
    { source: "server", event: "stderr", data: { line: `failed to index ${privatePath}` } },
    { source: "server", event: "stderr", data: { line: "folder=/data/alice/secret.jpg" } },
    { source: "http", event: "request-started", data: { path: "/v1/jobs" } },
  ];
  await writeFile(
    join(directory, "backend.log"),
    `${entries.map(JSON.stringify).join("\n")}\n`,
    "utf8",
  );
  await writeFile(join(directory, "backend.log.1"), `previous error: ${privatePath}\n`, "utf8");
  await writeFile(
    join(directory, "runtime.json"),
    JSON.stringify({ executionProvider: "cpu", cachePath: privatePath }),
    "utf8",
  );

  await writeFile(
    join(directory, "nicegal-server.log"),
    JSON.stringify({
      fields: { path: privatePath, error: `decoding ${privatePath}: invalid PNG signature` },
    }) + "\n",
  );
  await writeFile(join(directory, "nicegal-server.log.2"), '{"event":"older-rust-log"}\n');
  await writeFile(
    join(directory, "nicegal-panic.log"),
    JSON.stringify({
      event: "rust-panic",
      backtrace: `worker panic\n  at ${privatePath}:42:5`,
    }) + "\n",
  );
  await writeFile(join(directory, "private.dmp"), "raw memory must stay local");
  const savedPath = await diagnostics.collectDiagnostics(
    {},
    {
      backendStatus: { ready: false, error: `failed to start at ${privatePath}` },
      flushBackendLog: async () => {
        calls.flushes += 1;
      },
    },
  );

  assert.equal(savedPath, outputPath);
  assert.equal(calls.flushes, 1);
  const zip = new AdmZip(await readFile(outputPath));
  assert.deepEqual(
    zip
      .getEntries()
      .map((entry) => entry.entryName)
      .toSorted(),
    [
      "backend.log",
      "backend.log.1",
      "diagnostics.json",
      "nicegal-panic.log",
      "nicegal-server.log",
      "nicegal-server.log.2",
      "runtime.json",
    ],
  );
  const savedLog = zip.readAsText("backend.log");
  assert.match(savedLog, /\[redacted local path\]/);
  assert.match(savedLog, /"path":"\/v1\/jobs"/);
  for (const entry of zip.getEntries()) {
    const contents = zip.readAsText(entry);
    assert.doesNotMatch(
      contents,
      /someone|private\.jpg|nas|family\.jpg|alice|secret\.jpg/,
      `${entry.entryName} leaked a path`,
    );
  }
  const manifest = JSON.parse(zip.readAsText("diagnostics.json"));
  assert.deepEqual(manifest.application, {
    name: "Nicegal",
    version: "1.2.3",
    packaged: true,
    frontendCommit: "front1234567",
    backendCommit: "back12345678",
  });
  assert.deepEqual(manifest.backend, {
    ready: false,
    error: "failed to start at [redacted local path]",
  });
  assert.ok(manifest.system.release);
  assert.ok(manifest.system.version);
  assert.equal(manifest.system.gpu.info.gpuDevice[0].driverVersion, "test-driver");
  assert.match(zip.readAsText("nicegal-server.log"), /invalid PNG signature/);
  assert.match(zip.readAsText("nicegal-panic.log"), /:42:5/);
  assert.deepEqual(
    manifest.files.map((file: { name: string }) => file.name),
    [
      "backend.log",
      "backend.log.1",
      "nicegal-server.log",
      "nicegal-server.log.2",
      "nicegal-panic.log",
      "runtime.json",
    ],
  );
});

test("collectDiagnostics stops when the save dialog is canceled", async () => {
  const flushesBefore = calls.flushes;
  dialogResult.canceled = true;
  try {
    const savedPath = await diagnostics.collectDiagnostics(
      {},
      {
        backendStatus: { ready: false, error: "offline" },
        flushBackendLog: async () => {
          calls.flushes += 1;
        },
      },
    );
    assert.equal(savedPath, null);
    assert.equal(calls.flushes, flushesBefore, "canceling does not collect diagnostics");
  } finally {
    dialogResult.canceled = false;
  }
});

test("recentBackendLog keeps local paths in the last twelve complete lines", async () => {
  const lines = Array.from({ length: 20 }, (_, index) => `log entry ${index + 1}`);
  lines[19] = JSON.stringify({ event: "stderr", data: { line: "folder=/home/alice/private.jpg" } });
  await writeFile(join(directory, "backend.log"), `${lines.join("\n")}\n`, "utf8");
  const recent = await diagnostics.recentBackendLog();
  assert.equal(recent, lines.slice(-12).join("\n"));
});

test("failed GPU collection does not prevent exporting useful logs", async () => {
  gpuFailure = true;
  try {
    await diagnostics.collectDiagnostics(
      {},
      {
        backendStatus: { ready: false, error: "crashed" },
        flushBackendLog: async () => {},
      },
    );
    const zip = new AdmZip(await readFile(outputPath));
    const manifest = JSON.parse(zip.readAsText("diagnostics.json"));
    assert.equal(manifest.system.gpu, null);
    assert.ok(manifest.issues.some((issue: string) => issue.includes("GPU unavailable")));
    assert.ok(zip.getEntry("nicegal-server.log"));
  } finally {
    gpuFailure = false;
  }
});
