import { decodeIpcError } from "../../../shared/ipc-error";

function rawMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorMessage(error: unknown): string {
  const coded = decodeIpcError(rawMessage(error));
  if (coded) return cleanDiagnostic(coded.message);
  const message = cleanDiagnostic(rawMessage(error));
  const prefix = /^Error invoking remote method '[^']*':\s*/;

  if (!prefix.test(message)) return message;
  return message.replace(prefix, "").replace(/^Error:\s*/, "");
}

/** The backend's API error code, e.g. `models_not_ready`, when the failure came from it. */
export function errorCode(error: unknown): string | undefined {
  return decodeIpcError(rawMessage(error))?.code;
}

/** Terminal formatting is never useful in UI text or copied diagnostic reports. */
export function cleanDiagnostic(message: string): string {
  /* eslint-disable no-control-regex -- intentionally remove terminal control sequences */
  return (
    message
      // OSC (including hyperlink titles), CSI colour/cursor sequences, and stray controls.
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .trim()
  );
  /* eslint-enable no-control-regex */
}
