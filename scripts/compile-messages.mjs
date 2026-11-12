/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone Node JavaScript, matching repository scripts. */
import { compile } from "@inlang/paraglide-js";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { paraglideOptions } from "./paraglide-options.mjs";

/**
 * Hashes the existing output the way Paraglide's writeOutput does, so an unchanged compile writes
 * nothing. A running dev server's Vite plugin serves the same directory; a clean rewrite would
 * briefly remove files it imports.
 * @param {string} directory
 * @returns {Promise<Record<string, string> | undefined>}
 */
async function hashOutput(directory) {
  let entries;
  try {
    entries = await readdir(directory, { recursive: true, withFileTypes: true });
  } catch {
    return undefined;
  }
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const relative = path.relative(directory, absolute).split(path.sep).join("/");
    const content = await readFile(absolute, "utf8");
    hashes[relative] = createHash("sha256")
      .update(content + path.resolve(directory, relative))
      .digest("hex");
  }
  return hashes;
}

const outputHashes = await hashOutput(paraglideOptions.outdir);
await compile({
  ...paraglideOptions,
  cleanOutdir: false,
  previousCompilation: outputHashes ? { outputHashes } : undefined,
});
