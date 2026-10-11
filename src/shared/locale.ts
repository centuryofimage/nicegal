/** Window argument carrying the locale main chose, e.g. `--nicegal-locale=en`. */
export const LOCALE_ARG_PREFIX = "--nicegal-locale=";

export interface LanguageSettings {
  /** The saved choice, or null to follow the system languages. */
  preference: string | null;
  /** What "follow the system" resolves to. */
  system: string;
  /** The locale this run uses. A change applies after a restart. */
  active: string;
  available: readonly string[];
}

export interface LanguageBridge {
  getSettings(): Promise<LanguageSettings>;
  setPreference(locale: string | null): Promise<LanguageSettings>;
  restart(): Promise<void>;
}
