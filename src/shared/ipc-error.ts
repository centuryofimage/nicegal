/**
 * Backend error codes crossing IPC. Electron copies only an error's message from the main process
 * (and again across the context bridge), so the code travels inside the message as a marked JSON
 * payload that only `encodeIpcError` writes and only `decodeIpcError` reads. Nothing parses the
 * human-readable text.
 */
const MARKER = "nicegal-error:";

export interface CodedError {
  /** A `nicegal-server` API error code, e.g. `models_not_ready` or `query_syntax`. */
  code: string;
  message: string;
}

export function encodeIpcError(error: CodedError): string {
  return MARKER + JSON.stringify({ code: error.code, message: error.message });
}

/** Finds the payload after whatever prefix Electron adds, or returns null for an uncoded error. */
export function decodeIpcError(text: string): CodedError | null {
  const start = text.indexOf(MARKER);
  if (start < 0) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start + MARKER.length));
    if (
      typeof value === "object" &&
      value !== null &&
      "code" in value &&
      "message" in value &&
      typeof value.code === "string" &&
      typeof value.message === "string"
    )
      return { code: value.code, message: value.message };
  } catch {
    // A marker without a valid payload is not ours; show the text as it is.
  }
  return null;
}
