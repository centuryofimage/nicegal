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
  emitTsDeclarations: true,
  emitReadme: false,
  emitPrettierIgnore: false,
};
