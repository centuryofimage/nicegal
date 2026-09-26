/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone Node JavaScript, matching repository scripts. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "resources/licenses/license-information.html");
const backend = JSON.parse(
  await readFile(resolve(root, "nicegal-server/third-party-licenses.json"), "utf8"),
);
const backendLock = (await readFile(resolve(root, "nicegal-server/Cargo.lock"), "utf8")).replace(
  /\r\n/g,
  "\n",
);
if (backend.lockfileSha256 !== createHash("sha256").update(backendLock).digest("hex")) {
  throw new Error(
    "Backend license inventory is stale. Run python nicegal-server/scripts/collect-licenses.py and commit it first.",
  );
}
const command = process.platform === "win32" ? "cmd.exe" : "pnpm";
const args =
  process.platform === "win32"
    ? ["/d", "/c", "pnpm list --json --depth Infinity"]
    : ["list", "--json", "--depth", "Infinity"];
const report = JSON.parse(
  execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  }),
);

// pnpm's license command reads its content-addressed store, which can fail even
// when the installed packages are intact. The dependency tree supplies paths;
// installed manifests supply the license and project URL for each version.
const packages = new Map();
const paths = new Set();
function collectPaths(node) {
  for (const entry of Object.values({
    ...node.dependencies,
    ...node.devDependencies,
    ...node.optionalDependencies,
  })) {
    if (entry.path) paths.add(entry.path);
    collectPaths(entry);
  }
}
for (const project of report) collectPaths(project);
for (const packagePath of paths) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolve(packagePath, "package.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") continue; // Optional package for another platform.
    throw error;
  }
  const repository =
    typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  const candidates = [
    manifest.homepage,
    repository,
    `https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}`,
  ];
  let url;
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate
      .replace(/^git\+/, "")
      .replace(/^git:\/\//, "https://")
      .replace(/\.git$/, "");
    try {
      const parsed = new URL(normalized);
      if (parsed.protocol === "https:" && !parsed.username && !parsed.password) {
        url = parsed.href;
        break;
      }
    } catch {
      /* Fall back to the package registry for non-web repository URLs. */
    }
  }
  if (!url) throw new Error(`No project URL for ${manifest.name}`);
  const noticeFiles = (await readdir(packagePath, { withFileTypes: true }))
    .filter(
      (file) =>
        file.isFile() && /^(licen[sc]e|copying|notice|copyright)(?:$|[._-])/i.test(file.name),
    )
    .map((file) => file.name)
    .sort();
  const notices = await Promise.all(
    noticeFiles.map(async (file) => ({
      file,
      text: await readFile(resolve(packagePath, file), "utf8"),
    })),
  );
  packages.set(`${manifest.name}@${manifest.version}`, {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license || "Not specified",
    url,
    notices,
  });
}
if (
  !packages.has(
    `electron@${JSON.parse(await readFile(resolve(root, "node_modules/electron/package.json"), "utf8")).version}`,
  )
) {
  throw new Error(
    "The license report is missing Electron. Install development dependencies first.",
  );
}

const application = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const frontendLicense = await readFile(resolve(root, "LICENSE"), "utf8");
const backendLicense = await readFile(resolve(root, "nicegal-server/LICENSE"), "utf8");
const frontendPackages = [...packages.values()].sort(
  (a, b) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en"),
);
// Packaged document lives at resources/app.asar.unpacked/resources/licenses/.
// Development uses the Electron distribution installed by pnpm instead.
const electronNotices = process.argv.includes("--dev")
  ? pathToFileURL(resolve(root, "node_modules/electron/dist/LICENSES.chromium.html")).href
  : process.platform === "darwin"
    ? "../../../../../Frameworks/Electron%20Framework.framework/Versions/A/Resources/LICENSES.chromium.html"
    : "../../../../LICENSES.chromium.html";
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
const packageHtml = (entry) => `<details class="package">
<summary><strong>${escape(entry.name)}</strong> ${escape(entry.version)} — ${escape(entry.license)}</summary>
<p><a href="${escape(entry.url)}">Project / license source</a></p>
${(entry.notices ?? []).map((notice) => `<h4>${escape(notice.file)}</h4><pre>${escape(notice.text)}</pre>`).join("\n")}
${entry.notices?.length ? "" : "<p>See the project link for license terms.</p>"}
</details>`;
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Nicegal — License information</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;color:#222;background:#fff;max-width:72rem;margin:2rem auto;padding:0 1rem}
a{color:#075baf}h1{font-size:1.5rem}h2{font-size:1.2rem;margin-top:2rem}h4{margin-bottom:.3rem}
summary{cursor:pointer;padding:.4rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
.package{border-bottom:1px solid #ddd;padding:.25rem 0}nav{display:flex;flex-wrap:wrap;gap:1rem}
:focus-visible{outline:2px solid #075baf;outline-offset:2px}
</style></head><body>
<h1>Nicegal ${escape(application.version)} — License information</h1>
<p>Copyright 2026 bep</p>
<nav aria-label="License sections"><a href="#application">Application</a><a href="#frontend">Frontend dependencies</a><a href="#backend">Backend dependencies</a><a href="#runtimes">Native runtimes</a></nav>
<h2 id="application">Application licenses</h2>
<p><a href="https://github.com/centuryofimage/nicegal">Frontend source</a> · <a href="https://github.com/centuryofimage/nicegal-server">Backend source</a></p>
<details><summary>Frontend — MIT</summary><pre>${escape(frontendLicense)}</pre></details>
<details><summary>Backend — AGPL-3.0-only</summary><pre>${escape(backendLicense)}</pre></details>
<p>Third-party components and downloaded models retain their publishers' licenses.</p>
<p><a href="${escape(electronNotices)}">Electron / Chromium bundled notices</a></p>
<h2 id="frontend">Frontend dependencies (${frontendPackages.length})</h2>
<p>Packages used by the desktop app and its build tools.</p>
${frontendPackages.map(packageHtml).join("\n")}
<h2 id="backend">Backend dependencies (${backend.packages.length})</h2>
<p>Rust libraries used by the gallery service and its build tools.</p>
${backend.packages.map(packageHtml).join("\n")}
<h2 id="runtimes">Native runtimes</h2>
<p>Native runtimes used for search acceleration. Included components vary by platform.</p>
${backend.runtimePackages.map(packageHtml).join("\n")}
</body></html>\n`;
await mkdir(dirname(output), { recursive: true });
await writeFile(output, html);
console.log(
  `Wrote license information for ${frontendPackages.length} frontend packages, ${backend.packages.length} Rust packages and ${backend.runtimePackages.length} native runtimes.`,
);
