declare global {
  interface Window {
    /** Dev builds only: folders the next pickers return instead of opening the native dialog,
     * so CDP tests can drive folder flows. Set it with `window.__nicegalPickFolders = [path]`. */
    __nicegalPickFolders?: string[];
  }
}

/** Opens the native folder picker. Resolves null when the user cancels. */
export function chooseDirectory(defaultPath?: string): Promise<string | null> {
  if (import.meta.env.DEV) {
    const folder = window.__nicegalPickFolders?.shift();
    if (folder !== undefined) return Promise.resolve(folder);
  }
  return window.nicegal.native.chooseDirectory(defaultPath);
}
