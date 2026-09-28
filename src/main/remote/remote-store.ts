import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { DEFAULT_REMOTE_PORT, type RemoteDevice } from "../../shared/remote";

interface StoredDevice extends RemoteDevice {
  /** SHA-256 of the device's cookie token, so the file alone cannot sign anyone in. */
  tokenHash: string;
}

interface StoredSettings {
  enabled: boolean;
  https: boolean;
  /** Written only by hand. Absent means the default, so a new default reaches existing installs. */
  port?: number;
  devices: StoredDevice[];
  minimizeToTray: boolean;
  closeToTray: boolean;
}

/** Remote-access preferences and paired devices, persisted beside the other main-only settings. */
export class RemoteStore {
  private settings: StoredSettings;
  private lastSeenWrite = 0;

  constructor(private readonly path: string) {
    this.settings = load(path);
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  get https(): boolean {
    return this.settings.https;
  }

  setHttps(https: boolean): void {
    this.settings.https = https;
    this.save();
  }

  get port(): number {
    return this.settings.port ?? DEFAULT_REMOTE_PORT;
  }

  devices(): RemoteDevice[] {
    return this.settings.devices.map(visible);
  }

  setEnabled(enabled: boolean): void {
    this.settings.enabled = enabled;
    this.save();
  }

  get tray(): { minimizeToTray: boolean; closeToTray: boolean } {
    return {
      minimizeToTray: this.settings.minimizeToTray,
      closeToTray: this.settings.closeToTray,
    };
  }

  setTray(change: { minimizeToTray?: boolean; closeToTray?: boolean }): void {
    if (change.minimizeToTray !== undefined) this.settings.minimizeToTray = change.minimizeToTray;
    if (change.closeToTray !== undefined) this.settings.closeToTray = change.closeToTray;
    this.save();
  }

  /** Returns the new device's token; only its hash is kept. */
  addDevice(name: string): { device: RemoteDevice; token: string } {
    const token = randomBytes(32).toString("base64url");
    const device: StoredDevice = {
      id: randomUUID(),
      name,
      pairedAt: Date.now(),
      lastSeenAt: Date.now(),
      tokenHash: hashToken(token),
    };
    this.settings.devices.push(device);
    this.save();
    return { device: visible(device), token };
  }

  removeDevice(deviceId: string): boolean {
    const before = this.settings.devices.length;
    this.settings.devices = this.settings.devices.filter((device) => device.id !== deviceId);
    if (this.settings.devices.length === before) return false;
    this.save();
    return true;
  }

  /** The device holding `token`, if it is still paired. Records when it was last seen. */
  authenticate(token: string): RemoteDevice | null {
    const hash = Buffer.from(hashToken(token), "hex");
    const device = this.settings.devices.find((candidate) =>
      timingSafeEqual(Buffer.from(candidate.tokenHash, "hex"), hash),
    );
    if (!device) return null;
    device.lastSeenAt = Date.now();
    // Every request authenticates; persist the timestamp at most once a minute.
    if (device.lastSeenAt - this.lastSeenWrite > 60_000) {
      this.lastSeenWrite = device.lastSeenAt;
      this.save();
    }
    return visible(device);
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, `${JSON.stringify(this.settings, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(`${this.path}.tmp`, this.path);
  }
}

function visible(device: StoredDevice): RemoteDevice {
  return {
    id: device.id,
    name: device.name,
    pairedAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt,
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function load(path: string): StoredSettings {
  const defaults: StoredSettings = {
    enabled: false,
    https: false,
    devices: [],
    minimizeToTray: false,
    closeToTray: false,
  };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.error("Could not read remote access settings; remote access is off", error);
    return defaults;
  }
  if (typeof value !== "object" || value === null) return defaults;
  const stored = value as Partial<StoredSettings>;
  const port =
    Number.isInteger(stored.port) && stored.port! >= 1024 && stored.port! <= 65535
      ? stored.port
      : undefined;
  const devices = Array.isArray(stored.devices)
    ? stored.devices.filter(
        (device): device is StoredDevice =>
          typeof device?.id === "string" &&
          typeof device.name === "string" &&
          typeof device.tokenHash === "string" &&
          /^[0-9a-f]{64}$/.test(device.tokenHash) &&
          typeof device.pairedAt === "number",
      )
    : [];
  return {
    enabled: stored.enabled === true,
    https: stored.https === true,
    ...(port === undefined ? {} : { port }),
    devices,
    minimizeToTray: stored.minimizeToTray === true,
    closeToTray: stored.closeToTray === true,
  };
}
