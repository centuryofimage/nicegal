/** Registered roots compare without case on Windows. */
export function rootKey(root: string): string {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)
    ? root.toLowerCase()
    : root;
}

export function rootsMatch(left: string, right: string): boolean {
  return rootKey(left) === rootKey(right);
}

/** Compare picker and stored folder spellings, including Windows separators and casing. */
export function sameFolder(left: string, right: string): boolean {
  const key = (path: string): string => rootKey(path.replace(/\\/g, "/").replace(/\/+$/, "") || "/");
  return key(left) === key(right);
}

/** The last path segment, which names a folder in the tree and the search chip. */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || path;
}
