/** Native asynchronous encoding avoids constructing a large binary string on the UI thread. */
export function visualFileBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string" || !result.includes(",")) {
        reject(new Error("Couldn't read the image."));
        return;
      }
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the image."));
    reader.onabort = () => reject(new Error("Reading the visual-search image was cancelled."));
    reader.readAsDataURL(file);
  });
}
