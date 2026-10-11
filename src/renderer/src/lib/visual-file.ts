import { m } from "../../../shared/paraglide/messages.js";

/** Native asynchronous encoding avoids constructing a large binary string on the UI thread. */
export function visualFileBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string" || !result.includes(",")) {
        reject(new Error(m.visual_file_read_failed()));
        return;
      }
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error(m.visual_file_read_failed()));
    reader.onabort = () => reject(new Error(m.visual_file_read_cancelled()));
    reader.readAsDataURL(file);
  });
}
