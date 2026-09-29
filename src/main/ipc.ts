import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { randomUUID } from "node:crypto";

import { encodeIpcError } from "../shared/ipc-error";

export type IpcSenderValidator = (event: IpcMainInvokeEvent) => boolean;

/**
 * One connected renderer, whichever transport it uses: the desktop window over IPC, or a
 * remote browser over HTTP. Handlers that keep per-renderer state (searches, job subscriptions)
 * key it by `id` and push events with `send`.
 */
export interface BridgeClient {
  readonly id: string;
  send(channel: string, ...args: unknown[]): void;
  isClosed(): boolean;
  /** Runs once when the renderer goes away for good. */
  onceClosed(listener: () => void): void;
}

export type BridgeHandler = (client: BridgeClient, ...args: unknown[]) => unknown;

const windowClients = new WeakMap<WebContents, BridgeClient>();

/** A client lives for one renderer document; hash navigation keeps the same client. */
export function windowClient(sender: WebContents): BridgeClient {
  const existing = windowClients.get(sender);
  if (existing) return existing;
  let closed = false;
  const listeners = new Set<() => void>();
  const close = (): void => {
    if (closed) return;
    closed = true;
    windowClients.delete(sender);
    sender.removeListener("destroyed", close);
    sender.removeListener("render-process-gone", close);
    sender.removeListener("did-start-navigation", navigating);
    for (const listener of listeners) listener();
    listeners.clear();
  };
  const navigating = (
    event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
  ): void => {
    if (event.isMainFrame && !event.isSameDocument) close();
  };
  const client: BridgeClient = {
    id: `window:${sender.id}:${randomUUID()}`,
    send: (channel, ...args) => {
      if (!closed && !sender.isDestroyed()) sender.send(channel, ...args);
    },
    isClosed: () => closed || sender.isDestroyed(),
    onceClosed: (listener) => {
      if (closed || sender.isDestroyed()) listener();
      else listeners.add(listener);
    },
  };
  sender.once("destroyed", close);
  sender.once("render-process-gone", close);
  sender.on("did-start-navigation", navigating);
  windowClients.set(sender, client);
  return client;
}

const remotableHandlers = new Map<string, BridgeHandler>();

/** Handlers that remote browsers may call. Everything else is reachable only from the window. */
export function remotableHandler(channel: string): BridgeHandler | undefined {
  return remotableHandlers.get(channel);
}

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
    return callWithIpcCode(() => handler(event, ...args));
  });
}

/**
 * Like `handleTrustedIpc`, and also callable by paired remote browsers. The handler sees only a
 * `BridgeClient`, never the Electron event, so it cannot reach window-only APIs by accident.
 */
export function handleRemotableIpc(
  channel: string,
  isTrustedSender: IpcSenderValidator,
  handler: BridgeHandler,
): void {
  remotableHandlers.set(channel, handler);
  handleTrustedIpc(channel, isTrustedSender, (event, ...args) =>
    handler(windowClient(event.sender), ...args),
  );
}

function callWithIpcCode(call: () => unknown): unknown {
  let result: unknown;
  try {
    result = call();
  } catch (error) {
    throw withIpcCode(error);
  }
  return result instanceof Promise
    ? result.catch((error: unknown) => {
        throw withIpcCode(error);
      })
    : result;
}

/** Keeps a backend error's code, which Electron would otherwise drop with every other property. */
export function withIpcCode(error: unknown): unknown {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string")
    return error;
  return new Error(encodeIpcError({ code: error.code, message: error.message }));
}
