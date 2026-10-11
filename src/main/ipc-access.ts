import { IPC_CHANNELS } from "../shared/ipc-channels";

/**
 * "window": only the desktop app's own renderer. "remote": also paired browsers on the LAN,
 * through `/rpc/<channel>`. Every invoke channel is listed here; `handleTrustedIpc` and
 * `handleRemotableIpc` accept only channels with the matching access, so this table is the whole
 * remote surface.
 */
export const IPC_ACCESS = {
  [IPC_CHANNELS.updates.preferences]: "window",
  [IPC_CHANNELS.updates.setEnabled]: "window",
  [IPC_CHANNELS.updates.status]: "window",
  [IPC_CHANNELS.updates.releaseNotes]: "window",
  [IPC_CHANNELS.updates.restartAndInstall]: "window",

  [IPC_CHANNELS.backend.status]: "remote",
  [IPC_CHANNELS.backend.restartServer]: "remote",
  [IPC_CHANNELS.backend.getRuntimeStatus]: "remote",
  [IPC_CHANNELS.backend.setImageModel]: "remote",
  [IPC_CHANNELS.backend.setExecutionProvider]: "remote",
  [IPC_CHANNELS.backend.listLibraries]: "remote",
  [IPC_CHANNELS.backend.setLibraryView]: "remote",
  // Library folders decide which files `/original/` serves, so only the PC changes them.
  [IPC_CHANNELS.backend.createLibrary]: "window",
  [IPC_CHANNELS.backend.updateLibrary]: "window",
  [IPC_CHANNELS.backend.deleteLibrary]: "window",
  [IPC_CHANNELS.backend.assetMetadata]: "remote",
  [IPC_CHANNELS.backend.listAssets]: "remote",
  [IPC_CHANNELS.backend.listFolders]: "remote",
  [IPC_CHANNELS.backend.countAssets]: "remote",
  [IPC_CHANNELS.backend.catalogRevision]: "remote",
  [IPC_CHANNELS.backend.getTextEmbeddingCoverage]: "remote",
  [IPC_CHANNELS.backend.getImageEmbeddingCoverage]: "remote",
  [IPC_CHANNELS.backend.getOcrModels]: "remote",
  [IPC_CHANNELS.backend.getSearchModels]: "remote",
  [IPC_CHANNELS.backend.search]: "remote",
  [IPC_CHANNELS.backend.cancelSearch]: "remote",
  // Remote browsers may start only `REMOTE_JOB_TYPES`; see backend/ipc.ts.
  [IPC_CHANNELS.backend.startJob]: "remote",
  [IPC_CHANNELS.backend.listJobs]: "remote",
  [IPC_CHANNELS.backend.cancelJobs]: "remote",
  [IPC_CHANNELS.backend.subscribeJob]: "remote",
  [IPC_CHANNELS.backend.unsubscribeJob]: "remote",
  [IPC_CHANNELS.backend.ensureThumbnails]: "remote",

  [IPC_CHANNELS.remote.status]: "window",
  [IPC_CHANNELS.remote.setEnabled]: "window",
  [IPC_CHANNELS.remote.renewPairingCode]: "window",
  [IPC_CHANNELS.remote.removeDevice]: "window",
  [IPC_CHANNELS.remote.setBackground]: "window",
  [IPC_CHANNELS.remote.setHttps]: "window",

  [IPC_CHANNELS.native.appInfo]: "remote",
  [IPC_CHANNELS.native.collectDiagnostics]: "window",
  [IPC_CHANNELS.native.recentBackendLog]: "remote",
  [IPC_CHANNELS.native.openExternalUrl]: "window",
  [IPC_CHANNELS.native.openLicenseInformation]: "window",
  [IPC_CHANNELS.native.chooseDirectory]: "window",
  [IPC_CHANNELS.native.chooseVisualSearchImage]: "window",
  [IPC_CHANNELS.native.showFileContextMenu]: "window",
  [IPC_CHANNELS.native.showFolderContextMenu]: "window",
  [IPC_CHANNELS.native.prepareFileDrag]: "window",
  [IPC_CHANNELS.native.startFileDrag]: "window",
} as const satisfies Record<string, "window" | "remote">;

export type IpcChannel = keyof typeof IPC_ACCESS;
export type RemoteChannel = {
  [C in IpcChannel]: (typeof IPC_ACCESS)[C] extends "remote" ? C : never;
}[IpcChannel];
export type WindowChannel = Exclude<IpcChannel, RemoteChannel>;

export function isRemoteChannel(channel: string): channel is RemoteChannel {
  return Object.hasOwn(IPC_ACCESS, channel) && IPC_ACCESS[channel as IpcChannel] === "remote";
}
