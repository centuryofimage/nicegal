/**
 * Where the renderer's media and API requests go. The desktop window uses privileged custom
 * schemes; a browser connected over remote access uses same-origin paths on the LAN server.
 */
export function isRemote(): boolean {
  return globalThis.window?.nicegal?.isRemote === true;
}

/** Tooltip for controls a remote browser shows greyed out, such as native folder pickers. */
export const DESKTOP_ONLY_TITLE = "Available on the PC running Nicegal";

/** `path` is `asset/<id>?<query>`. */
export function thumbnailUrl(path: string): string {
  return isRemote() ? `/thumb/${path}` : `thumb://${path}`;
}

/** `path` is `asset/<id>?<query>`. */
export function originalUrl(path: string): string {
  return isRemote() ? `/original/${path}` : `original://${path}`;
}

/** `path` is a nicegal-server path such as `/v1/image-embeddings/patches`. */
export function apiUrl(path: string): string {
  return isRemote() ? `/api${path}` : `api://server${path}`;
}
