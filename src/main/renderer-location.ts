export const APP_SCHEME = "app";
export const APP_HOST = "renderer";
export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

/** Viewer history changes the fragment, not the document's IPC trust. Keep every other
 * part exact: custom-scheme origins alone cannot distinguish trusted app documents. */
export function isRendererEntryUrl(url: string, entryUrl = APP_ENTRY_URL): boolean {
  return url.split("#", 1)[0] === entryUrl;
}
