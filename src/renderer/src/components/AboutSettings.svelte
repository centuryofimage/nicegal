<script lang="ts">
  import { TriangleAlert } from "@lucide/svelte";
  import { onMount } from "svelte";

  import type { AppInfo } from "../../../shared/diagnostics";

  import { version } from "../../../../package.json";

  let appInfo = $state<AppInfo | null>(null);
  let collecting = $state(false);
  let error = $state<string | null>(null);
  let status = $state<string | null>(null);

  onMount(() => {
    let disposed = false;
    void window.nicegal.native
      .getAppInfo()
      .then((info) => {
        if (!disposed) appInfo = info;
      })
      .catch((cause: unknown) => {
        if (!disposed) error = formatError(cause);
      });
    return () => {
      disposed = true;
    };
  });

  async function openLink(event: MouseEvent & { currentTarget: HTMLAnchorElement }): Promise<void> {
    event.preventDefault();
    error = null;
    try {
      await window.nicegal.native.openExternalUrl(event.currentTarget.href);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function openLicenses(event: MouseEvent): Promise<void> {
    event.preventDefault();
    error = null;
    try {
      await window.nicegal.native.openLicenseInformation();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function collectDiagnostics(): Promise<void> {
    error = null;
    status = null;
    collecting = true;
    try {
      const savedPath = await window.nicegal.native.collectDiagnostics();
      if (savedPath) status = "Diagnostics saved.";
    } catch (cause) {
      error = formatError(cause);
    } finally {
      collecting = false;
    }
  }

  function formatError(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
  }
</script>

<section class="about-settings" aria-labelledby="about-title">
  <h2 id="about-title">Nicegal <span class="about-version">{version}</span></h2>
  <p>A desktop gallery with local OCR, text and image search.</p>
  <p>Copyright 2026 bep</p>
  <dl class="about-build-info">
    <dt>Electron</dt>
    <dd>{appInfo?.electronVersion ?? "Loading…"}</dd>
    <dt>Frontend commit</dt>
    <dd>{appInfo?.frontendCommit ?? "Loading…"}</dd>
    <dt>Backend commit</dt>
    <dd>{appInfo?.backendCommit ?? "Loading…"}</dd>
  </dl>
  <p class="about-links">
    <a href="https://github.com/centuryofimage/nicegal" onclick={openLink}>Frontend source</a>
    <a href="https://github.com/centuryofimage/nicegal-server" onclick={openLink}>Backend source</a>
  </p>
  <p>
    Frontend: <a href="https://opensource.org/license/mit" onclick={openLink}>MIT</a>. Backend:
    <a href="https://www.gnu.org/licenses/agpl-3.0.html" onclick={openLink}>AGPL-3.0-only</a>.
  </p>
  <p><a href="#license-information" onclick={openLicenses}>License information</a></p>
  <div class="about-diagnostics">
    <button class="ui-button" type="button" onclick={collectDiagnostics} disabled={collecting}>
      {collecting ? "Collecting…" : "Collect diagnostics"}
    </button>
    <p class="about-warning">
      <TriangleAlert size={13} aria-hidden="true" />
      Diagnostics may contain file names and error details.
    </p>
  </div>
  {#if status}<p class="about-status" aria-live="polite">{status}</p>{/if}
  {#if error}<p class="about-error" role="alert">{error}</p>{/if}
</section>
