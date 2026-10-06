import { unwrapCallResult, type CallResult } from "../../src/shared/ipc-error.ts";

type Handler = (...args: unknown[]) => unknown;

/**
 * Collects mocked `ipcMain.handle` registrations as the renderer sees them: each call is awaited
 * and its `CallResult` unwrapped into a value or a rejection, as the preload does.
 */
export class RendererHandlers extends Map<string, (...args: unknown[]) => Promise<unknown>> {
  override set(channel: string, handler: Handler): this {
    return super.set(channel, async (...args) =>
      unwrapCallResult((await handler(...args)) as CallResult),
    );
  }
}
