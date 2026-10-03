import { randomInt } from "node:crypto";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

import type { BackgroundChange, RemoteAccessStatus, RemoteConnection } from "../../shared/remote";

import { loadCertificate } from "./remote-certificate";
import { RemoteServer, type RemoteServerHost, type TlsIdentity } from "./remote-server";
import { RemoteStore } from "./remote-store";

const PAIRING_CODE_MS = 5 * 60_000;
/** Wrong codes one address may try per code. Another address on the LAN cannot use them up. */
const MAX_FAILURES_PER_ADDRESS = 5;
/** Wrong codes across all addresses before the code is voided. Keeps a guess at 1 in 20,000
 * however many addresses an attacker has. */
const MAX_PAIRING_FAILURES = 50;

export type RemoteServices = Omit<
  RemoteServerHost,
  "authenticate" | "pair" | "onConnectionsChanged"
>;

/** The OS login item, which Electron owns. */
export interface LoginItem {
  readonly available: boolean;
  get(): boolean;
  set(openAtLogin: boolean): void;
}

/**
 * Owns the opt-in LAN server and who may use it. A device pairs once with a short-lived code
 * shown in the desktop window, then keeps a long-lived cookie until it is removed here.
 */
export class RemoteAccess {
  private readonly store: RemoteStore;
  private readonly certificatePath: string;
  private server: RemoteServer | null = null;
  private fingerprint: string | null = null;
  private error: string | null = null;
  private pairing: {
    code: string;
    expiresAt: number;
    failures: number;
    failuresByAddress: Map<string, number>;
  } | null = null;
  private pairingTimer: ReturnType<typeof setTimeout> | null = null;
  private transition: Promise<void> = Promise.resolve();

  constructor(
    settingsPath: string,
    private readonly services: RemoteServices,
    private readonly publish: (status: RemoteAccessStatus) => void,
    private readonly loginItem: LoginItem,
  ) {
    this.store = new RemoteStore(settingsPath);
    this.certificatePath = join(dirname(settingsPath), "remote-certificate.json");
  }

  /** Starts the server if it was left on. Failure is reported in the status, not thrown. */
  start(): Promise<void> {
    return this.store.enabled ? this.serialize(() => this.open()) : Promise.resolve();
  }

  status(): RemoteAccessStatus {
    const pairing = this.pairing && this.pairing.expiresAt > Date.now() ? this.pairing : null;
    return {
      enabled: this.store.enabled,
      port: this.store.port,
      running: this.server !== null,
      https: this.store.https,
      certificateFingerprint: this.server?.secure ? this.fingerprint : null,
      error: this.error,
      urls: this.server
        ? lanAddresses().map(
            (address) =>
              `${this.server?.secure ? "https" : "http"}://${address}:${this.store.port}`,
          )
        : [],
      pairingCode: pairing?.code ?? null,
      pairingExpiresAt: pairing?.expiresAt ?? null,
      devices: this.store.devices(),
      connected: this.connections(),
      background: {
        ...this.store.tray,
        openAtLogin: this.loginItem.available && this.loginItem.get(),
        openAtLoginAvailable: this.loginItem.available,
      },
    };
  }

  setBackground(change: BackgroundChange): RemoteAccessStatus {
    const { openAtLogin, ...tray } = change;
    if (openAtLogin !== undefined) {
      if (!this.loginItem.available) throw new Error("Open at sign-in needs the installed app");
      this.loginItem.set(openAtLogin);
    }
    this.store.setTray(tray);
    return this.changed();
  }

  get tray(): { minimizeToTray: boolean; closeToTray: boolean } {
    return this.store.tray;
  }

  private connections(): RemoteConnection[] {
    const names = new Map(this.store.devices().map((device) => [device.id, device.name]));
    return (this.server?.connections() ?? []).flatMap((connection) => {
      const name = names.get(connection.deviceId);
      return name ? [{ ...connection, name }] : [];
    });
  }

  async setEnabled(enabled: boolean): Promise<RemoteAccessStatus> {
    await this.serialize(async () => {
      this.store.setEnabled(enabled);
      if (enabled) await this.open();
      else await this.shut();
    });
    return this.status();
  }

  /** Restarts a running server on the new protocol. Paired devices stay paired. */
  async setHttps(https: boolean): Promise<RemoteAccessStatus> {
    await this.serialize(async () => {
      this.store.setHttps(https);
      if (!this.server) {
        this.changed();
        return;
      }
      await this.shut();
      await this.open();
    });
    return this.status();
  }

  renewPairingCode(): RemoteAccessStatus {
    if (!this.server) throw new Error("Turn on remote access first");
    this.pairing = {
      code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      expiresAt: Date.now() + PAIRING_CODE_MS,
      failures: 0,
      failuresByAddress: new Map(),
    };
    if (this.pairingTimer) clearTimeout(this.pairingTimer);
    this.pairingTimer = setTimeout(() => this.endPairing(), PAIRING_CODE_MS);
    this.pairingTimer.unref();
    return this.changed();
  }

  removeDevice(deviceId: string): RemoteAccessStatus {
    if (this.store.removeDevice(deviceId)) this.server?.disconnectDevice(deviceId);
    return this.changed();
  }

  broadcast(channel: string, ...args: unknown[]): void {
    this.server?.broadcast(channel, ...args);
  }

  stop(): Promise<void> {
    return this.serialize(() => this.shut());
  }

  private pair(code: string, name: string, address: string): { token: string } | { error: string } {
    const pairing = this.pairing;
    if (!pairing || pairing.expiresAt <= Date.now())
      return { error: "No pairing code is active. Select Pair a device on your PC." };
    const tooMany = { error: "Too many wrong codes. Select Pair a device on your PC again." };
    const addressFailures = pairing.failuresByAddress.get(address) ?? 0;
    if (addressFailures >= MAX_FAILURES_PER_ADDRESS) return tooMany;
    if (code !== pairing.code) {
      pairing.failuresByAddress.set(address, addressFailures + 1);
      pairing.failures += 1;
      if (pairing.failures >= MAX_PAIRING_FAILURES) {
        this.endPairing();
        return tooMany;
      }
      return addressFailures + 1 >= MAX_FAILURES_PER_ADDRESS
        ? tooMany
        : { error: "That code doesn't match. Check the code on your PC." };
    }
    const { token } = this.store.addDevice(name);
    // One code, one device.
    this.endPairing();
    return { token };
  }

  private async open(): Promise<void> {
    if (this.server) return;
    try {
      let tls: TlsIdentity | null = null;
      if (this.store.https) {
        const certificate = await loadCertificate(this.certificatePath, lanAddresses());
        tls = { key: certificate.key, cert: certificate.cert };
        this.fingerprint = certificate.fingerprint;
      }
      const server = new RemoteServer(
        {
          ...this.services,
          authenticate: (token) => this.store.authenticate(token),
          pair: (code, name, address) => this.pair(code, name, address),
          onConnectionsChanged: () => this.changed(),
        },
        tls,
      );
      await server.listen(this.store.port);
      this.server = server;
      this.error = null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.error =
        code === "EADDRINUSE"
          ? `Port ${this.store.port} is in use by another app.`
          : error instanceof Error
            ? error.message
            : String(error);
      console.error("Remote access server failed to start", error);
    }
    this.changed();
  }

  private async shut(): Promise<void> {
    this.pairing = null;
    this.error = null;
    const server = this.server;
    this.server = null;
    await server?.close();
    this.changed();
  }

  private endPairing(): void {
    if (this.pairingTimer) clearTimeout(this.pairingTimer);
    this.pairingTimer = null;
    this.pairing = null;
    this.changed();
  }

  private changed(): RemoteAccessStatus {
    const status = this.status();
    this.publish(status);
    return status;
  }

  private serialize(step: () => Promise<void>): Promise<void> {
    this.transition = this.transition.then(step, step);
    return this.transition;
  }
}

/** IPv4 LAN addresses, physical adapters first. Virtual switches rarely reach a phone. */
function lanAddresses(): string[] {
  const virtual = /vethernet|virtual|vmware|vbox|hyper-v|wsl|docker|loopback|tailscale|zerotier/i;
  const candidates: Array<{ address: string; rank: number }> = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || entry.address.startsWith("169.254."))
        continue;
      const privateRange = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address);
      candidates.push({
        address: entry.address,
        rank: (virtual.test(name) ? 2 : 0) + (privateRange ? 0 : 1),
      });
    }
  }
  return candidates.sort((a, b) => a.rank - b.rank).map((candidate) => candidate.address);
}
