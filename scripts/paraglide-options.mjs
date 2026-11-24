import { fileURLToPath } from "node:url";

/**
 * Shared by `compile-messages.mjs` and the renderer's Vite plugin so both emit the same output.
 * Paths are absolute because the renderer build runs from `src/renderer`.
 * @type {import("@inlang/paraglide-js").CompilerOptions}
 */
export const paraglideOptions = {
  project: fileURLToPath(new URL("../project.inlang", import.meta.url)),
  outdir: fileURLToPath(new URL("../src/shared/paraglide", import.meta.url)),
  // The desktop window sets a global from the locale main chose; a phone over remote access has
  // no preload, so it follows the browser's languages.
  strategy: ["globalVariable", "preferredLanguage", "baseLocale"],
  // Keep physical per-message modules. Paraglide 3 defaults the Vite plugin to "virtual-modules",
  // which rewrites messages.js into a `virtual:` facade and drops the on-disk message files. The
  // Electron main process imports this shared output directly from disk, so it must stay physical.
  outputStructure: "message-modules",
  emitTsDeclarations: true,
  emitReadme: false,
  emitPrettierIgnore: false,
};
