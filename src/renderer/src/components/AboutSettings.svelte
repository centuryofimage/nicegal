<script lang="ts">
  import { ParaglideMessage } from "@inlang/paraglide-js-svelte";
  import { TriangleAlert } from "@lucide/svelte";
  import { onMount } from "svelte";

  import type { AppInfo } from "../../../shared/diagnostics";

  import { version } from "../../../../package.json";
  import { m } from "../../../shared/paraglide/messages.js";
  import { desktopOnlyTitle, isRemote } from "../lib/platform";

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
      if (savedPath) status = m.about_settings_diagnostics_saved();
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
  <p>{m.about_settings_description()}</p>
  <p>{m.about_settings_copyright()}</p>
  <dl class="about-build-info">
    <dt>Electron</dt>
    <dd>{appInfo?.electronVersion ?? m.common_loading()}</dd>
    <dt>{m.about_settings_frontend_commit_label()}</dt>
    <dd>{appInfo?.frontendCommit ?? m.common_loading()}</dd>
    <dt>{m.about_settings_backend_commit_label()}</dt>
    <dd>{appInfo?.backendCommit ?? m.common_loading()}</dd>
  </dl>
  <p class="about-links">
    <a href="https://github.com/centuryofimage/nicegal" onclick={openLink}
      >{m.about_settings_frontend_source_link()}</a
    >
    <a href="https://github.com/centuryofimage/nicegal-server" onclick={openLink}
      >{m.about_settings_backend_source_link()}</a
    >
  </p>
  <p>
    <ParaglideMessage message={m.about_settings_license_summary} inputs={{}}>
      {#snippet mit({ children })}
        <a href="https://opensource.org/license/mit" onclick={openLink}>{@render children?.()}</a>
      {/snippet}
      {#snippet agpl({ children })}
        <a href="https://www.gnu.org/licenses/agpl-3.0.html" onclick={openLink}
          >{@render children?.()}</a
        >
      {/snippet}
    </ParaglideMessage>
  </p>
  <p>
    {#if isRemote()}
      <span class="about-desktop-only" title={desktopOnlyTitle()}
        >{m.about_settings_license_information()}</span
      >
    {:else}
      <a href="#license-information" onclick={openLicenses}
        >{m.about_settings_license_information()}</a
      >
    {/if}
  </p>
  <div class="about-diagnostics">
    <button
      class="ui-button"
      type="button"
      onclick={collectDiagnostics}
      title={isRemote() ? desktopOnlyTitle() : undefined}
      disabled={collecting || isRemote()}
    >
      {collecting ? m.common_collecting_diagnostics() : m.common_collect_diagnostics()}
    </button>
    <p class="about-warning">
      <TriangleAlert size={13} aria-hidden="true" />
      {m.about_settings_diagnostics_warning()}
    </p>
  </div>
  {#if status}<p class="about-status" aria-live="polite">{status}</p>{/if}
  {#if error}<p class="about-error" role="alert">{error}</p>{/if}
</section>
