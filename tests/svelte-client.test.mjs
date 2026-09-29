import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

for (const [name, script] of [
  [
    "selection cancels stale gestures and file drag preparation respects release",
    "gallery-selection",
  ],
  ["library effects ignore scroll persistence and unchanged OCR state", "library-reactivity"],
]) {
  test(name, () => {
    const result = spawnSync(
      process.execPath,
      [
        "--conditions=browser",
        "--import",
        new URL("./helpers/svelte-client-loader.mjs", import.meta.url).href,
        fileURLToPath(new URL(`./helpers/${script}.svelte.ts`, import.meta.url)),
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}
