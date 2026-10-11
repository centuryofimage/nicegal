import {
  getLocale,
  getTextDirection,
  setLocale,
  toLocale,
} from "../../../shared/paraglide/runtime.js";

// The desktop window speaks the locale main chose. A remote browser has none and resolves its own
// from navigator.languages. Imported by main.ts right after the bridge, before any module that
// builds messages at load time.
const locale = toLocale(window.nicegal.locale);
if (locale) setLocale(locale, { reload: false });
document.documentElement.lang = getLocale();
document.documentElement.dir = getTextDirection();
