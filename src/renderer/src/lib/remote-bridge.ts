import { v4 as uuid } from "@lukeed/uuid";

import type {
  BackendBridge,
  BackendStatus,
  ConnectionBridge,
  ExternalVisualReference,
  JobSnapshot,
  NativeBridge,
  NicegalBridge,
} from "../../../shared/backend";
import type { RemoteAccessBridge } from "../../../shared/remote";
import type { UpdateBridge } from "../../../shared/updates";

import { IPC_CHANNELS } from "../../../shared/ipc-channels";
import { REMOTE_CLIENT_HEADER, type RemoteEvent } from "../../../shared/remote";
import { visualFileBase64 } from "./visual-file";

type Listener = (...args: unknown[]) => void;

const RECONNECTING_GRACE_MS = 1000;
/** A phone that suspended the tab this long may hold a stream that looks open but is dead. */
const STALE_AFTER_HIDDEN_MS = 5000;
/** A suspended phone can leave a request hanging on a dead connection. Polls skip while their
 * previous request is pending, so their cheap reads give up and let the next poll run. */
const POLL_TIMEOUT_MS = 15_000;
const POLLED_CHANNELS: ReadonlySet<string> = new Set([
  IPC_CHANNELS.backend.status,
  IPC_CHANNELS.backend.catalogRevision,
  IPC_CHANNELS.backend.getImageEmbeddingCoverage,
  IPC_CHANNELS.backend.listJobs,
]);

/**
 * `window.nicegal` for a browser connected over remote access. Calls become `POST /rpc/<channel>`
 * against the same handlers the desktop window reaches over IPC; pushed events arrive on one
 * server-sent event stream. Capabilities that only make sense at the PC say so when used.
 */
export function createRemoteBridge(): NicegalBridge {
  const clientId = uuid();
  let viewGeneration = 0;
  const subscriptions = new Map<string, () => void>();
  const listeners = new Map<string, Set<Listener>>();

  const on = (channel: string, listener: Listener): (() => void) => {
    let set = listeners.get(channel);
    if (!set) listeners.set(channel, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  };
  let statusRevision = 0;
  const emit = (channel: string, args: unknown[]): void => {
    if (channel === IPC_CHANNELS.backend.statusChanged) statusRevision += 1;
    for (const listener of listeners.get(channel) ?? []) listener(...args);
  };

  const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    try {
      while (args.length && args[args.length - 1] === undefined) args.pop();
      let response: Response;
      try {
        response = await fetch(`/rpc/${encodeURIComponent(channel)}`, {
          method: "POST",
          headers: { "content-type": "application/json", [REMOTE_CLIENT_HEADER]: clientId },
          body: JSON.stringify(args),
          signal: POLLED_CHANNELS.has(channel) ? AbortSignal.timeout(POLL_TIMEOUT_MS) : undefined,
        });
      } catch (cause) {
        throw new Error("Can't reach Nicegal on your PC.", { cause });
      }
      if (response.status === 401) {
        location.assign("/pair");
        throw new Error("This device is no longer paired.");
      }
      if (!response.ok)
        throw new Error((await response.text()) || `Request failed (${response.status})`);
      const body = (await response.json()) as {
        value?: unknown;
        error?: { name: string; message: string };
      };
      if (body.error) {
        const error = new Error(body.error.message);
        error.name = body.error.name;
        throw error;
      }
      return body.value as T;
    } catch (error) {
      console.error(`IPC ${channel} failed`, error);
      throw error;
    }
  };

  // The event stream is the connection's heartbeat. While it is down the status bar says
  // "Reconnecting…"; the gallery stays usable. A short grace hides blips.
  const reconnectingListeners = new Set<(reconnecting: boolean) => void>();
  let reconnecting = false;
  let lostTimer: ReturnType<typeof setTimeout> | undefined;
  const setReconnecting = (value: boolean): void => {
    clearTimeout(lostTimer);
    if (value === reconnecting) return;
    reconnecting = value;
    for (const listener of reconnectingListeners) listener(value);
  };
  let connectionRevision = 0;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  const recoverStatus = async (revision: number): Promise<void> => {
    const statusAtStart = statusRevision;
    try {
      const status = await call<BackendStatus>(IPC_CHANNELS.backend.status);
      if (revision === connectionRevision) {
        if (statusAtStart === statusRevision) emit(IPC_CHANNELS.backend.statusChanged, [status]);
        for (const subscribe of subscriptions.values()) subscribe();
      }
    } catch {
      if (revision === connectionRevision && statusAtStart === statusRevision)
        recoveryTimer = setTimeout(() => void recoverStatus(revision), 3000);
    }
  };
  connectEvents(clientId, emit, {
    reopened: () => {
      clearTimeout(recoveryTimer);
      setReconnecting(false);
      void recoverStatus(++connectionRevision);
    },
    dropped: () => {
      ++connectionRevision;
      clearTimeout(recoveryTimer);
      if (reconnecting) return;
      clearTimeout(lostTimer);
      lostTimer = setTimeout(() => setReconnecting(true), RECONNECTING_GRACE_MS);
    },
  });
  const connection: ConnectionBridge = {
    onReconnectingChanged(listener) {
      reconnectingListeners.add(listener);
      listener(reconnecting);
      return () => reconnectingListeners.delete(listener);
    },
  };

  const channels = IPC_CHANNELS.backend;
  const backend: BackendBridge = {
    getBackendStatus: () => call(channels.status),
    onBackendStatusChanged: (listener) =>
      on(channels.statusChanged, (status) => listener(status as BackendStatus)),
    restartServer: () => call(channels.restartServer),
    getRuntimeStatus: () => call(channels.getRuntimeStatus),
    setImageModel: (model) => call(channels.setImageModel, model),
    setExecutionProvider: (provider) => call(channels.setExecutionProvider, provider),
    listLibraries: () => call(channels.listLibraries),
    setLibraryView: (libraryId) => call(channels.setLibraryView, libraryId, ++viewGeneration),
    createLibrary: (request) => call(channels.createLibrary, request),
    updateLibrary: (libraryId, definition) => call(channels.updateLibrary, libraryId, definition),
    deleteLibrary: (libraryId) => call(channels.deleteLibrary, libraryId),
    listAssets: (options) => call(channels.listAssets, options),
    listFolders: (libraryId) => call(channels.listFolders, libraryId),
    countAssets: (libraryId) => call(channels.countAssets, libraryId),
    getAssetMetadata: (assetId) => call(channels.assetMetadata, assetId),
    getCatalogRevision: () => call(channels.catalogRevision),
    getOcrModels: () => call(channels.getOcrModels),
    getSearchModels: () => call(channels.getSearchModels),
    loadCachedModel: (model) => call(channels.loadCachedModel, model),
    searchOcr: (request) => call(channels.search, request, clientId),
    cancelSearch: (throughSession) => call(channels.cancelSearch, throughSession, clientId),
    getTextEmbeddingCoverage: (libraryId) => call(channels.getTextEmbeddingCoverage, libraryId),
    getImageEmbeddingCoverage: (libraryId) => call(channels.getImageEmbeddingCoverage, libraryId),
    startJob: (request, requestId = uuid()) => call(channels.startJob, request, requestId),
    listJobs: () => call(channels.listJobs),
    cancelJob: (jobId) => call(channels.cancelJob, jobId),
    ensureThumbnails: (request) => call(channels.ensureThumbnails, request),
    subscribeJob(jobId, listener, onConnection) {
      let disposed = false;
      const subscriptionId = uuid();
      const offSnapshot = on(channels.jobSnapshot, (message) => {
        const { subscriptionId: id, snapshot } = message as {
          subscriptionId: string;
          snapshot: JobSnapshot;
        };
        if (!disposed && id === subscriptionId) listener(snapshot);
      });
      const offConnection = on(channels.jobConnection, (message) => {
        const { subscriptionId: id, error } = message as {
          subscriptionId: string;
          error: string | null;
        };
        if (!disposed && id === subscriptionId) onConnection?.(error);
      });
      let pending: Promise<void> = Promise.resolve();
      const subscribe = (): void => {
        pending = pending
          .then(async () => {
            if (!disposed) await call(channels.subscribeJob, jobId, subscriptionId);
          })
          .catch((error: unknown) => {
            if (!disposed) onConnection?.(error instanceof Error ? error.message : String(error));
          });
      };
      subscriptions.set(subscriptionId, subscribe);
      subscribe();
      return () => {
        if (disposed) return;
        disposed = true;
        subscriptions.delete(subscriptionId);
        offSnapshot();
        offConnection();
        void pending
          .then(() => call(channels.unsubscribeJob, jobId, subscriptionId))
          .catch(() => undefined);
      };
    },
  };

  const atThePc = (action: string) => (): Promise<never> =>
    Promise.reject(new Error(`${action} on the PC running Nicegal.`));
  const native: NativeBridge = {
    getAppInfo: () => call(IPC_CHANNELS.native.appInfo),
    recentBackendLog: () => call(IPC_CHANNELS.native.recentBackendLog),
    collectDiagnostics: atThePc("Save diagnostics"),
    openLicenseInformation: atThePc("Open license information"),
    chooseDirectory: atThePc("Choose folders"),
    prepareFileDrag: atThePc("Drag files"),
    openExternalUrl: async (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    chooseVisualSearchImage: chooseImageFile,
    onAddToVisualSearch: () => () => undefined,
    showFileContextMenu: async () => undefined,
    startFileDrag: async () => undefined,
  };

  const updates: UpdateBridge = {
    getPreferences: async () => ({ enabled: false, mode: "none" }),
    setEnabled: atThePc("Change update settings"),
    getStatus: async () => ({ phase: "disabled", version: null }),
    onStatusChanged: () => () => undefined,
    openReleaseNotes: async () => undefined,
    restartAndInstall: atThePc("Install updates"),
  };

  const remote: RemoteAccessBridge = {
    getStatus: atThePc("Manage remote access"),
    setEnabled: atThePc("Manage remote access"),
    renewPairingCode: atThePc("Manage remote access"),
    removeDevice: atThePc("Manage remote access"),
    setBackground: atThePc("Manage remote access"),
    setHttps: atThePc("Manage remote access"),
    onStatusChanged: () => () => undefined,
  };

  return { backend, native, updates, remote, isRemote: true, connection };
}

/**
 * Keeps one server-sent event stream open. EventSource retries network errors by itself; after an
 * HTTP error it gives up, which is also how a device removed on the PC finds out. A tab coming
 * back after a while opens a fresh stream at once instead of waiting on a possibly dead one.
 */
function connectEvents(
  clientId: string,
  emit: (channel: string, args: unknown[]) => void,
  connection: { reopened: () => void; dropped: () => void },
): void {
  let source: EventSource | null = null;
  let hiddenAt = 0;

  const open = (): void => {
    if (source) {
      connection.dropped();
      source.close();
    }
    const current = new EventSource(`/events?client=${clientId}`);
    source = current;
    current.onopen = () => {
      if (source === current) connection.reopened();
    };
    current.onmessage = (message: MessageEvent<string>) => {
      if (source !== current) return;
      const event = JSON.parse(message.data) as RemoteEvent;
      emit(event.channel, event.args);
    };
    current.onerror = () => {
      if (source !== current) return;
      connection.dropped();
      if (current.readyState !== EventSource.CLOSED) return;
      const retry = (): void => {
        setTimeout(() => {
          if (source === current) open();
        }, 3000);
      };
      void fetch("/", { method: "HEAD" }).then((response) => {
        if (source !== current) return;
        if (response.status === 401) location.assign("/pair");
        else retry();
      }, retry);
    };
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    if (source?.readyState !== EventSource.OPEN || Date.now() - hiddenAt > STALE_AFTER_HIDDEN_MS)
      open();
  });
  open();
}

function chooseImageFile(): Promise<ExternalVisualReference | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("cancel", () => resolve(null));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      if (file.size > 16 * 1024 * 1024)
        return reject(new Error("Choose an image smaller than 16 MB for visual search."));
      visualFileBase64(file).then(
        (bytesBase64) => resolve({ displayName: file.name, bytesBase64 }),
        reject,
      );
    });
    input.click();
  });
}
