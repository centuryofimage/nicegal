<script lang="ts">
  import { onMount } from "svelte";

  import type { BackgroundChange, RemoteAccessStatus, RemoteDevice } from "../../../shared/remote";

  import { m } from "../../../shared/paraglide/messages.js";
  import { errorMessage } from "../lib/errors";

  let status = $state.raw<RemoteAccessStatus | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  onMount(() => {
    // Subscribe before reading the snapshot; an intervening event is newer than that read.
    let receivedEvent = false;
    let disposed = false;
    const unsubscribe = window.nicegal.remote.onStatusChanged((value) => {
      receivedEvent = true;
      status = value;
    });
    void window.nicegal.remote.getStatus().then(
      (value) => {
        if (!disposed && !receivedEvent) status = value;
      },
      (cause: unknown) => {
        if (!disposed) error = errorMessage(cause);
      },
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  });

  async function run(action: () => Promise<RemoteAccessStatus>): Promise<void> {
    busy = true;
    error = null;
    try {
      status = await action();
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      busy = false;
    }
  }

  function setHttps(event: Event & { currentTarget: HTMLInputElement }): void {
    const checkbox = event.currentTarget;
    void run(() => window.nicegal.remote.setHttps(checkbox.checked)).then(() => {
      checkbox.checked = status?.https ?? false;
    });
  }

  function setEnabled(event: Event & { currentTarget: HTMLInputElement }): void {
    const checkbox = event.currentTarget;
    void run(() => window.nicegal.remote.setEnabled(checkbox.checked)).then(() => {
      checkbox.checked = status?.enabled ?? false;
    });
  }

  function setBackground(
    option: keyof BackgroundChange,
    event: Event & { currentTarget: HTMLInputElement },
  ): void {
    const checkbox = event.currentTarget;
    void run(() => window.nicegal.remote.setBackground({ [option]: checkbox.checked })).then(() => {
      checkbox.checked = status?.background[option] ?? false;
    });
  }

  const time = (ms: number): string =>
    new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const date = (ms: number): string =>
    new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  function pairedSummary(device: RemoteDevice): string {
    const pairedDate = date(device.pairedAt);
    return device.lastSeenAt === null
      ? m.remote_access_paired_date({ pairedDate })
      : m.remote_access_paired_last_used({
          pairedDate,
          lastUsedDate: date(device.lastSeenAt),
          lastUsedTime: time(device.lastSeenAt),
        });
  }
</script>

<section class="settings-group" aria-labelledby="remote-title">
  <h2 id="remote-title">{m.common_remote_access()}</h2>
  <label class="row">
    <span class="setting-label"
      >{m.remote_access_allow_label()}<small>{m.remote_access_allow_hint()}</small></span
    >
    <input
      type="checkbox"
      checked={status?.enabled ?? false}
      disabled={!status || busy}
      onchange={setEnabled}
    />
  </label>
  <label class="row">
    <span class="setting-label"
      >{m.remote_access_https_label()}<small>{m.remote_access_https_hint()}</small
      >{#if status && !status.https}<small class="recommend"
          >{m.remote_access_https_recommend()}</small
        >{/if}</span
    >
    <input
      type="checkbox"
      checked={status?.https ?? false}
      disabled={!status || busy}
      onchange={setHttps}
    />
  </label>
  {#if status?.https && status.running}
    <div class="row certificate-row">
      <span class="setting-label"
        >{m.remote_access_first_visit()}<small>{m.remote_access_first_visit_hint()}</small></span
      >
    </div>
    {#if status.certificateFingerprint}
      <div class="row certificate-row">
        <span class="setting-label"
          >{m.remote_access_fingerprint_label()}<small>{m.remote_access_fingerprint_hint()}</small
          ><span class="fingerprint">{status.certificateFingerprint}</span></span
        >
      </div>
    {/if}
  {/if}
  {#if status?.error}
    <p class="settings-error" role="alert">{status.error}</p>
  {/if}
  {#if status?.running}
    <div class="row address-row">
      <span class="setting-label"
        >{m.remote_access_open_on_device()}<small>{m.remote_access_wifi_hint()}</small></span
      >
      <span class="addresses">
        {#each status.urls as url, index (url)}
          <span class={["address", index > 0 && "secondary"]}>{url}</span>
        {:else}
          <span class="secondary">{m.remote_access_no_network()}</span>
        {/each}
      </span>
    </div>
    <div class="row">
      {#if status.pairingCode}
        <span class="setting-label"
          >{m.common_pairing_code()}<small
            >{m.remote_access_pairing_code_hint({
              time: time(status.pairingExpiresAt ?? 0),
            })}</small
          ></span
        >
        <span class="pairing-code" aria-live="polite">{status.pairingCode}</span>
      {:else}
        <span class="setting-label"
          >{m.remote_access_pair_device()}<small>{m.remote_access_pair_device_hint()}</small></span
        >
        <button
          class="ui-button"
          disabled={busy}
          onclick={() => run(() => window.nicegal.remote.renewPairingCode())}
          >{m.remote_access_pair_device()}</button
        >
      {/if}
    </div>
  {/if}
  {#if status?.devices.length}
    <h3>{m.remote_access_paired_devices_heading()}</h3>
    <ul class="devices">
      {#each status.devices as device (device.id)}
        <li class="row">
          <span class="setting-label"
            ><span
              >{device.name}{#each status.connected.filter((c) => c.deviceId === device.id) as connection (connection.browser)}<span
                  class="connected"
                  >{m.remote_access_connected_in({ browser: connection.browser })}</span
                >{/each}</span
            ><small>{pairedSummary(device)}</small></span
          >
          <button
            class="ui-button"
            disabled={busy}
            onclick={() => run(() => window.nicegal.remote.removeDevice(device.id))}
            >{m.remote_access_remove_device()}</button
          >
        </li>
      {/each}
    </ul>
  {/if}
  {#if error}<p class="settings-error" role="alert">{error}</p>{/if}
</section>

<section class="settings-group" aria-labelledby="background-title">
  <h2 id="background-title">{m.remote_access_background_heading()}</h2>
  <label class="row">
    <span class="setting-label"
      >{m.remote_access_minimize_to_tray()}<small>{m.remote_access_minimize_to_tray_hint()}</small
      ></span
    >
    <input
      type="checkbox"
      checked={status?.background.minimizeToTray ?? false}
      disabled={!status || busy}
      onchange={(event) => setBackground("minimizeToTray", event)}
    />
  </label>
  <label class="row">
    <span class="setting-label"
      >{m.remote_access_close_to_tray()}<small>{m.remote_access_close_to_tray_hint()}</small></span
    >
    <input
      type="checkbox"
      checked={status?.background.closeToTray ?? false}
      disabled={!status || busy}
      onchange={(event) => setBackground("closeToTray", event)}
    />
  </label>
  <label class="row">
    <span class="setting-label"
      >{m.remote_access_open_at_login()}<small
        >{status && !status.background.openAtLoginAvailable
          ? m.remote_access_open_at_login_available()
          : m.remote_access_open_at_login_tray()}</small
      ></span
    >
    <input
      type="checkbox"
      checked={status?.background.openAtLogin ?? false}
      disabled={!status?.background.openAtLoginAvailable || busy}
      onchange={(event) => setBackground("openAtLogin", event)}
    />
  </label>
</section>

<style>
  .settings-group {
    border: 1px solid var(--border);
    background: var(--surface-1);
  }
  h2,
  h3,
  p {
    margin: 0;
  }
  h2,
  h3 {
    padding: var(--space-7) var(--space-9);
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-primary);
    font-size: var(--font-size-md);
    font-weight: var(--font-weight-semibold);
  }
  h3 {
    border-top: 1px solid var(--border-subtle);
    font-weight: var(--font-weight-normal);
    color: var(--text-secondary);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
    min-height: var(--control-height);
    padding: var(--space-5) var(--space-9);
    color: var(--text-primary);
    font-size: var(--font-size-md);
  }
  .setting-label {
    display: grid;
    gap: var(--space-2);
  }
  .setting-label small,
  .secondary {
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .address-row {
    align-items: start;
  }
  .addresses {
    display: grid;
    justify-items: end;
    gap: var(--space-2);
  }
  .address {
    font-family: var(--font-mono);
    user-select: all;
  }
  .pairing-code {
    font-family: var(--font-mono);
    font-size: 20px;
    letter-spacing: 4px;
    user-select: all;
  }
  .setting-label small.recommend {
    color: var(--danger);
  }
  .certificate-row {
    align-items: start;
  }
  .fingerprint {
    overflow-wrap: anywhere;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    user-select: all;
  }
  .connected {
    margin-left: var(--space-6);
    color: var(--accent);
    font-size: var(--font-size-sm);
  }
  .devices {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .settings-error {
    padding: var(--space-5) var(--space-9);
    border-top: 1px solid var(--border-subtle);
    color: var(--danger);
    font-size: var(--font-size-sm);
  }
  input[type="checkbox"] {
    width: 14px;
    height: 14px;
    accent-color: var(--accent);
  }
</style>
