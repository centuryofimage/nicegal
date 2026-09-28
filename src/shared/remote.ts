/** Drawn at random from 20000-45000, clear of Windows' services list. */
export const DEFAULT_REMOTE_PORT = 30351;

export interface RemoteDevice {
  id: string;
  name: string;
  /** Milliseconds since the epoch. */
  pairedAt: number;
  lastSeenAt: number | null;
}

export interface RemoteConnection {
  deviceId: string;
  name: string;
  /** From the browser's user agent, e.g. "Safari" or "Firefox". */
  browser: string;
}

/** "iPhone (Safari)" */
export function connectionLabel(connection: RemoteConnection): string {
  return `${connection.name} (${connection.browser})`;
}

export interface RemoteAccessStatus {
  enabled: boolean;
  port: number;
  /** True once the server is listening. */
  running: boolean;
  /** Encrypts connections with a certificate this PC makes for itself. */
  https: boolean;
  /** SHA-256 of the certificate being served, colon-separated, as browsers show it. */
  certificateFingerprint: string | null;
  error: string | null;
  /** Addresses a phone on the same network can open, most likely first. */
  urls: string[];
  /** Six digits a new device enters once. Null while remote access is off. */
  pairingCode: string | null;
  pairingExpiresAt: number | null;
  devices: RemoteDevice[];
  /** Paired devices with the gallery open right now, one entry per browser. */
  connected: RemoteConnection[];
  background: BackgroundOptions;
}

/** Keeping Nicegal running without a window, so devices can connect. */
export interface BackgroundOptions {
  minimizeToTray: boolean;
  closeToTray: boolean;
  openAtLogin: boolean;
  /** Development builds would register the development Electron binary, so they cannot. */
  openAtLoginAvailable: boolean;
}

export type BackgroundChange = Partial<
  Pick<BackgroundOptions, "minimizeToTray" | "closeToTray" | "openAtLogin">
>;

/** Desktop-window only: remote browsers can never change who may connect. */
export interface RemoteAccessBridge {
  getStatus(): Promise<RemoteAccessStatus>;
  setEnabled(enabled: boolean): Promise<RemoteAccessStatus>;
  setHttps(enabled: boolean): Promise<RemoteAccessStatus>;
  renewPairingCode(): Promise<RemoteAccessStatus>;
  removeDevice(deviceId: string): Promise<RemoteAccessStatus>;
  setBackground(change: BackgroundChange): Promise<RemoteAccessStatus>;
  onStatusChanged(listener: (status: RemoteAccessStatus) => void): () => void;
}

/** One pushed event on a remote browser's `/events` stream. */
export interface RemoteEvent {
  channel: string;
  args: unknown[];
}

export const REMOTE_CLIENT_HEADER = "x-nicegal-client";
