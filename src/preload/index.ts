import { contextBridge, ipcRenderer } from "electron";

import type {
  BackendStatus,
  AssetMetadata,
  CreateLibraryRequest,
  Library,
  LibraryDefinition,
  LibraryId,
  TextEmbeddingCoverage,
  ImageEmbeddingCoverage,
  EnsureThumbnailsRequest,
  EnsureThumbnailsResponse,
  ExecutionProviderId,
  FolderEntry,
  GalleryAsset,
  JobListResponse,
  JobRequest,
  JobSnapshot,
  NativeBridge,
  ExternalVisualReference,
  NativeFileMenuRequest,
  NicegalBridge,
  OcrModelsResponse,
  SearchModelsResponse,
  RuntimeStatus,
  SearchRequest,
  SearchResponse,
  Timeline,
} from "../shared/backend";
import type { RemoteAccessBridge, RemoteAccessStatus } from "../shared/remote";
import type { UpdateBridge, UpdateStatus } from "../shared/updates";

import { IPC_CHANNELS } from "../shared/ipc-channels";

/** Report rejected IPC once at the transport boundary, preserving the caller's error. */
const invoke: typeof ipcRenderer.invoke = (channel, ...args) =>
  ipcRenderer.invoke(channel, ...args).catch((error: unknown) => {
    console.error(`IPC ${channel} failed`, error);
    throw error;
  });

const searchClient = crypto.randomUUID();
let viewGeneration = 0;

const updates: UpdateBridge = {
  getPreferences: () => invoke(IPC_CHANNELS.updates.preferences),
  setEnabled: (enabled) => invoke(IPC_CHANNELS.updates.setEnabled, enabled),
  getStatus: () => invoke(IPC_CHANNELS.updates.status),
  onStatusChanged(listener) {
    const handler = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void =>
      listener(status);
    ipcRenderer.on(IPC_CHANNELS.updates.statusChanged, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.updates.statusChanged, handler);
  },
  openReleaseNotes: () => invoke(IPC_CHANNELS.updates.releaseNotes),
  restartAndInstall: () => invoke(IPC_CHANNELS.updates.restartAndInstall),
};

const remote: RemoteAccessBridge = {
  getStatus: () => invoke(IPC_CHANNELS.remote.status),
  setEnabled: (enabled) => invoke(IPC_CHANNELS.remote.setEnabled, enabled),
  renewPairingCode: () => invoke(IPC_CHANNELS.remote.renewPairingCode),
  removeDevice: (deviceId) => invoke(IPC_CHANNELS.remote.removeDevice, deviceId),
  setHttps: (enabled) => invoke(IPC_CHANNELS.remote.setHttps, enabled),
  setBackground: (change) => invoke(IPC_CHANNELS.remote.setBackground, change),
  onStatusChanged(listener) {
    const handler = (_event: Electron.IpcRendererEvent, status: RemoteAccessStatus): void =>
      listener(status);
    ipcRenderer.on(IPC_CHANNELS.remote.statusChanged, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.remote.statusChanged, handler);
  },
};

const backend: NicegalBridge["backend"] = {
  getBackendStatus(): Promise<BackendStatus> {
    return invoke(IPC_CHANNELS.backend.status);
  },
  restartServer(): Promise<void> {
    return invoke(IPC_CHANNELS.backend.restartServer);
  },
  onBackendStatusChanged(listener: (status: BackendStatus) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, status: unknown): void => {
      listener(status as BackendStatus);
    };
    ipcRenderer.on(IPC_CHANNELS.backend.statusChanged, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.backend.statusChanged, handler);
  },
  getRuntimeStatus(): Promise<RuntimeStatus> {
    return invoke(IPC_CHANNELS.backend.getRuntimeStatus);
  },
  setImageModel(model: string): Promise<RuntimeStatus> {
    return invoke(IPC_CHANNELS.backend.setImageModel, model);
  },
  setExecutionProvider(executionProvider: ExecutionProviderId): Promise<RuntimeStatus> {
    return invoke(IPC_CHANNELS.backend.setExecutionProvider, executionProvider);
  },
  setLibraryView(libraryId: LibraryId | null): Promise<void> {
    return invoke(IPC_CHANNELS.backend.setLibraryView, libraryId, ++viewGeneration);
  },
  listLibraries(): Promise<Library[]> {
    return invoke(IPC_CHANNELS.backend.listLibraries);
  },
  createLibrary(request: CreateLibraryRequest): Promise<Library> {
    return invoke(IPC_CHANNELS.backend.createLibrary, request);
  },
  updateLibrary(libraryId: LibraryId, definition: LibraryDefinition): Promise<Library> {
    return invoke(IPC_CHANNELS.backend.updateLibrary, libraryId, definition);
  },
  deleteLibrary(libraryId: LibraryId): Promise<void> {
    return invoke(IPC_CHANNELS.backend.deleteLibrary, libraryId);
  },
  listAssets(options: { libraryId: LibraryId; timeline: Timeline }): Promise<GalleryAsset[]> {
    return invoke(IPC_CHANNELS.backend.listAssets, options);
  },
  listFolders(libraryId: LibraryId): Promise<FolderEntry[]> {
    return invoke(IPC_CHANNELS.backend.listFolders, libraryId);
  },
  getAssetMetadata(assetId: string): Promise<AssetMetadata> {
    return invoke(IPC_CHANNELS.backend.assetMetadata, assetId);
  },
  countAssets(libraryId: LibraryId): Promise<number> {
    return invoke(IPC_CHANNELS.backend.countAssets, libraryId);
  },
  getCatalogRevision(): Promise<string> {
    return invoke(IPC_CHANNELS.backend.catalogRevision);
  },
  getTextEmbeddingCoverage(libraryId: LibraryId): Promise<TextEmbeddingCoverage> {
    return invoke(IPC_CHANNELS.backend.getTextEmbeddingCoverage, libraryId);
  },
  getImageEmbeddingCoverage(libraryId: LibraryId): Promise<ImageEmbeddingCoverage> {
    return invoke(IPC_CHANNELS.backend.getImageEmbeddingCoverage, libraryId);
  },
  getOcrModels(): Promise<OcrModelsResponse> {
    return invoke(IPC_CHANNELS.backend.getOcrModels);
  },
  getSearchModels(): Promise<SearchModelsResponse> {
    return invoke(IPC_CHANNELS.backend.getSearchModels);
  },
  loadCachedModel(model: "clipText"): Promise<boolean> {
    return invoke(IPC_CHANNELS.backend.loadCachedModel, model);
  },
  searchOcr(request: SearchRequest): Promise<SearchResponse> {
    return invoke(IPC_CHANNELS.backend.search, request, searchClient);
  },
  cancelSearch(throughSession: number): Promise<void> {
    return invoke(IPC_CHANNELS.backend.cancelSearch, throughSession, searchClient);
  },
  startJob(request: JobRequest, requestId = crypto.randomUUID()): Promise<JobSnapshot> {
    return invoke(IPC_CHANNELS.backend.startJob, request, requestId);
  },
  listJobs(): Promise<JobListResponse> {
    return invoke(IPC_CHANNELS.backend.listJobs);
  },
  cancelJob(jobId: string): Promise<JobSnapshot> {
    return invoke(IPC_CHANNELS.backend.cancelJob, jobId);
  },
  ensureThumbnails(request: EnsureThumbnailsRequest): Promise<EnsureThumbnailsResponse> {
    return invoke(IPC_CHANNELS.backend.ensureThumbnails, request);
  },
  subscribeJob(
    jobId: string,
    listener: (snapshot: JobSnapshot) => void,
    onConnection?: (error: string | null) => void,
  ): () => void {
    let disposed = false;
    const subscriptionId = crypto.randomUUID();
    const handleSnapshot = (
      _event: Electron.IpcRendererEvent,
      message: { subscriptionId: string; snapshot: JobSnapshot },
    ): void => {
      if (message.subscriptionId === subscriptionId) listener(message.snapshot);
    };
    ipcRenderer.on(IPC_CHANNELS.backend.jobSnapshot, handleSnapshot);
    const handleConnection = (
      _event: Electron.IpcRendererEvent,
      message: { subscriptionId: string; error: string | null },
    ): void => {
      if (!disposed && message.subscriptionId === subscriptionId) onConnection?.(message.error);
    };
    ipcRenderer.on(IPC_CHANNELS.backend.jobConnection, handleConnection);
    const pending = invoke(IPC_CHANNELS.backend.subscribeJob, jobId, subscriptionId).catch(
      (error: unknown) => {
        if (!disposed) onConnection?.(error instanceof Error ? error.message : String(error));
      },
    );

    return (): void => {
      if (disposed) return;
      disposed = true;
      ipcRenderer.removeListener(IPC_CHANNELS.backend.jobSnapshot, handleSnapshot);
      ipcRenderer.removeListener(IPC_CHANNELS.backend.jobConnection, handleConnection);
      void pending
        .then(() => invoke(IPC_CHANNELS.backend.unsubscribeJob, jobId, subscriptionId))
        .catch(() => undefined);
    };
  },
};

const native: NativeBridge = {
  getAppInfo: () => invoke(IPC_CHANNELS.native.appInfo),
  collectDiagnostics: () => invoke(IPC_CHANNELS.native.collectDiagnostics),
  recentBackendLog: () => invoke(IPC_CHANNELS.native.recentBackendLog),
  prepareFileDrag: (request) => invoke(IPC_CHANNELS.native.prepareFileDrag, request),
  startFileDrag: (token) => invoke(IPC_CHANNELS.native.startFileDrag, token),
  openExternalUrl(url: string): Promise<void> {
    return invoke(IPC_CHANNELS.native.openExternalUrl, url);
  },
  openLicenseInformation(): Promise<void> {
    return invoke(IPC_CHANNELS.native.openLicenseInformation);
  },
  chooseDirectory(defaultPath?: string): Promise<string | null> {
    return invoke(IPC_CHANNELS.native.chooseDirectory, defaultPath);
  },
  chooseVisualSearchImage(): Promise<ExternalVisualReference | null> {
    return invoke(IPC_CHANNELS.native.chooseVisualSearchImage);
  },
  onAddToVisualSearch(listener: (assetIds: string[], replace: boolean) => void): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      assetIds: unknown,
      replace: unknown,
    ): void => {
      if (Array.isArray(assetIds) && assetIds.every((id) => typeof id === "string"))
        listener(assetIds, replace === true);
    };
    ipcRenderer.on(IPC_CHANNELS.native.addToVisualSearch, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.native.addToVisualSearch, handler);
  },
  showFileContextMenu(request: NativeFileMenuRequest): Promise<void> {
    return invoke(IPC_CHANNELS.native.showFileContextMenu, request);
  },
};

contextBridge.exposeInMainWorld("nicegal", {
  backend,
  native,
  updates,
  remote,
  isRemote: false,
  connection: { onReconnectingChanged: () => () => undefined },
} satisfies NicegalBridge);
