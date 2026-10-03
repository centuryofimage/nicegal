import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { randomUUID } from "node:crypto";

import { encodeIpcError } from "../shared/ipc-error";
import { isRemoteChannel, type RemoteChannel, type WindowChannel } from "./ipc-access";

export type IpcSenderValidator = (event: IpcMainInvokeEvent) => boolean;

/**
 * One connected renderer, whichever transport it uses: the desktop window over IPC, or a
 * remote browser over HTTP. Handlers that keep per-renderer state (searches, job subscriptions)
 * key it by `id` and push events with `send`.
 */
export interface BridgeClient {
  readonly id: string;
  /** A paired LAN browser rather than the desktop window. */
  readonly remote: boolean;
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
    remote: false,
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

const remotableHandlers = new Map<RemoteChannel, BridgeHandler>();

/** The handler a paired browser may call on `channel`, if `IPC_ACCESS` marks it remote. */
export function remotableHandler(channel: string): BridgeHandler | undefined {
  return isRemoteChannel(channel) ? remotableHandlers.get(channel) : undefined;
}

/** Registers a handler reachable only from the app's top-level renderer frame. */
export function handleTrustedIpc(
  channel: WindowChannel,
  isTrustedSender: IpcSenderValidator,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
): void {
  if (isRemoteChannel(channel)) throw new Error(`${channel} is remote in IPC_ACCESS`);
  handleInvoke(channel, isTrustedSender, handler);
}

/**
 * Registers a handler for the window and for paired remote browsers. The handler sees only a
 * `BridgeClient`, never the Electron event, so it cannot reach window-only APIs by accident.
 */
export function handleRemotableIpc(
  channel: RemoteChannel,
  isTrustedSender: IpcSenderValidator,
  handler: BridgeHandler,
): void {
  if (!isRemoteChannel(channel)) throw new Error(`${channel} is not remote in IPC_ACCESS`);
  remotableHandlers.set(channel, handler);
  handleInvoke(channel, isTrustedSender, (event, ...args) =>
    handler(windowClient(event.sender), ...args),
  );
}

function handleInvoke(
  channel: string,
  isTrustedSender: IpcSenderValidator,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!isTrustedSender(event))
      throw new Error("Untrusted IPC: rejected a call from an untrusted renderer");
    return callWithIpcCode(() => handler(event, ...args));
  });
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
