import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "electron-vite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { paraglideOptions } from "./scripts/paraglide-options.mjs";

const repositoryDirectory = fileURLToPath(new URL(".", import.meta.url));

function readCommit(directory: string): string {
  try {
    return execFileSync("git", ["-C", directory, "rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

const frontendCommit = process.env["NICEGAL_FRONTEND_COMMIT"] ?? readCommit(repositoryDirectory);
const backendCommit =
  process.env["NICEGAL_BACKEND_COMMIT"] ??
  readCommit(fileURLToPath(new URL("./nicegal-server", import.meta.url)));
const releaseUpdatesEnabled = process.env["NICEGAL_RELEASE_UPDATES"] === "1";

export default defineConfig({
  main: {
    define: {
      __NICEGAL_FRONTEND_COMMIT__: JSON.stringify(frontendCommit),
      __NICEGAL_BACKEND_COMMIT__: JSON.stringify(backendCommit),
      __NICEGAL_RELEASE_UPDATES__: JSON.stringify(releaseUpdatesEnabled),
    },
    build: {
      sourcemap: true,
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
    },
  },
  renderer: {
    build: {
      cssMinify: true,
      sourcemap: true,
    },
    // Main and preload use the output of `pnpm run messages`; this keeps it fresh while the dev server runs.
    plugins: [svelte(), paraglideVitePlugin(paraglideOptions)],
  },
});
