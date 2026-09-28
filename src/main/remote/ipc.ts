import type { BackgroundChange } from "../../shared/remote";
import type { RemoteAccess } from "./remote-access";

import { IPC_CHANNELS } from "../../shared/ipc-channels";
import { handleTrustedIpc, type IpcSenderValidator } from "../ipc";

/** Desktop-window only, by design: pairing and device removal are never remotable. */
export function registerRemoteIpc(remote: RemoteAccess, isTrustedSender: IpcSenderValidator): void {
  handleTrustedIpc(IPC_CHANNELS.remote.status, isTrustedSender, () => remote.status());
  handleTrustedIpc(IPC_CHANNELS.remote.setEnabled, isTrustedSender, (_event, enabled) => {
    if (typeof enabled !== "boolean") throw new TypeError("Expected true or false");
    return remote.setEnabled(enabled);
  });
  handleTrustedIpc(IPC_CHANNELS.remote.renewPairingCode, isTrustedSender, () =>
    remote.renewPairingCode(),
  );
  handleTrustedIpc(IPC_CHANNELS.remote.setHttps, isTrustedSender, (_event, enabled) => {
    if (typeof enabled !== "boolean") throw new TypeError("Expected true or false");
    return remote.setHttps(enabled);
  });
  handleTrustedIpc(IPC_CHANNELS.remote.setBackground, isTrustedSender, (_event, value) =>
    remote.setBackground(validateBackgroundChange(value)),
  );
  handleTrustedIpc(IPC_CHANNELS.remote.removeDevice, isTrustedSender, (_event, deviceId) => {
    if (typeof deviceId !== "string" || deviceId.length > 100)
      throw new TypeError("Invalid device");
    return remote.removeDevice(deviceId);
  });
}

function validateBackgroundChange(value: unknown): BackgroundChange {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Invalid background options");
  const change: BackgroundChange = {};
  for (const [key, option] of Object.entries(value)) {
    if (
      (key !== "minimizeToTray" && key !== "closeToTray" && key !== "openAtLogin") ||
      typeof option !== "boolean"
    )
      throw new TypeError("Invalid background options");
    change[key] = option;
  }
  return change;
}
