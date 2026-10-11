import { app } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { IpcSenderValidator } from "./ipc";

import { IPC_CHANNELS } from "../shared/ipc-channels";
import { LOCALE_ARG_PREFIX, type LanguageSettings } from "../shared/locale";
import {
  baseLocale,
  getLocale,
  locales,
  setLocale,
  toLocale,
  type Locale,
} from "../shared/paraglide/runtime.js";
import { handleTrustedIpc } from "./ipc";

/** The first system language with a translation, matched exactly ("pt-BR") and then by language
 * ("pt-BR" to "pt"). */
function systemLocale(): Locale {
  const preferred = app.getPreferredSystemLanguages();
  for (const tag of preferred) {
    const exact = toLocale(tag);
    if (exact) return exact;
  }
  for (const tag of preferred) {
    const language = toLocale(tag.split("-")[0]);
    if (language) return language;
  }
  return baseLocale;
}

/** The saved language, or null to follow the system. A missing, unreadable or no longer
 * translated choice falls back to the system rather than failing startup. */
function loadPreference(path: string): Locale | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value === "object" && value !== null && "locale" in value) {
      return toLocale(value.locale) ?? null;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Could not read the language preference; following the system", error);
    }
  }
  return null;
}

function savePreference(path: string, locale: Locale | null): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ locale })}\n`);
  renameSync(`${path}.tmp`, path);
}

/** Picks the UI language for this run. A language change restarts the app, so main and every
 * window keep the locale chosen here. Call once `app` is ready, before building menus. */
export function initializeLocale(preferencePath: string): void {
  setLocale(loadPreference(preferencePath) ?? systemLocale(), { reload: false });
}

/** Hands the main process's locale to a window's preload. */
export function localeArgument(): string {
  return `${LOCALE_ARG_PREFIX}${getLocale()}`;
}

export function registerLanguageIpc(options: {
  preferencePath: string;
  isTrustedSender: IpcSenderValidator;
  restart: () => void;
}): void {
  const { preferencePath, isTrustedSender, restart } = options;
  const settings = (): LanguageSettings => ({
    preference: loadPreference(preferencePath),
    system: systemLocale(),
    active: getLocale(),
    available: locales,
  });
  handleTrustedIpc(IPC_CHANNELS.language.settings, isTrustedSender, settings);
  handleTrustedIpc(
    IPC_CHANNELS.language.setPreference,
    isTrustedSender,
    (_event, value: unknown) => {
      const locale = value === null ? null : toLocale(value);
      if (locale === undefined) throw new Error("Unknown language");
      savePreference(preferencePath, locale);
      return settings();
    },
  );
  handleTrustedIpc(IPC_CHANNELS.language.restart, isTrustedSender, () => {
    // Let the IPC response reach the renderer before before-quit closes its window.
    setImmediate(restart);
  });
}
