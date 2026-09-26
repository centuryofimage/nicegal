import { ipcMain, type IpcMainInvokeEvent } from "electron";

import { encodeIpcError } from "../shared/ipc-error";

export type IpcSenderValidator = (event: IpcMainInvokeEvent) => boolean;

/**
 * Registers an invoke handler that is only reachable from the app's top-level renderer frame.
 * Every renderer-to-main capability crosses this guard before it reaches a domain handler.
 */
export function handleTrustedIpc(
  channel: string,
  isTrustedSender: IpcSenderValidator,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!isTrustedSender(event)) throw new Error("Rejected IPC from an untrusted renderer");
    let result: unknown;
    try {
      result = handler(event, ...args);
    } catch (error) {
      throw withIpcCode(error);
    }
    return result instanceof Promise
      ? result.catch((error: unknown) => {
          throw withIpcCode(error);
        })
      : result;
  });
}

/** Keeps a backend error's code, which Electron would otherwise drop with every other property. */
function withIpcCode(error: unknown): unknown {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string")
    return error;
  return new Error(encodeIpcError({ code: error.code, message: error.message }));
}
