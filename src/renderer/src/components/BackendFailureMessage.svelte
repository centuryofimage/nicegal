<script lang="ts">
  import { ParaglideMessage } from "@inlang/paraglide-js-svelte";
  import { onMount } from "svelte";

  import { m } from "../../../shared/paraglide/messages.js";
  import { desktopOnlyTitle, isRemote } from "../lib/platform";
  import AppMessage from "./AppMessage.svelte";

  const BUG_REPORT_URL = "https://github.com/centuryofimage/nicegal/issues";

  let { error }: { error: string } = $props();
  let recentLog = $state<string>(m.backend_failure_loading_log());
  let restarting = $state(false);
  let restartError = $state<string | null>(null);
  let collecting = $state(false);
  let savedPath = $state<string | null>(null);
  let collectionError = $state<string | null>(null);

  onMount(() => {
    let disposed = false;
    void Promise.resolve()
      .then(() => window.nicegal.native.recentBackendLog())
      .then((log) => {
        if (!disposed) recentLog = log;
      })
      .catch((cause: unknown) => {
        if (!disposed)
          recentLog = m.backend_failure_read_log_failed({
            reason: cause instanceof Error ? cause.message : String(cause),
          });
      });
    return () => {
      disposed = true;
    };
  });

  async function collectDiagnostics(): Promise<void> {
    if (collecting) return;
    collecting = true;
    collectionError = null;
    try {
      savedPath = await window.nicegal.native.collectDiagnostics();
    } catch (cause) {
      collectionError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      collecting = false;
    }
  }

  async function restartServer(): Promise<void> {
    if (restarting) return;
    restarting = true;
    restartError = null;
    try {
      await window.nicegal.backend.restartServer();
    } catch (cause) {
      restartError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      restarting = false;
    }
  }

  async function openBugReport(event: MouseEvent): Promise<void> {
    event.preventDefault();
    await window.nicegal.native.openExternalUrl(BUG_REPORT_URL);
  }
</script>

<AppMessage
  title={m.backend_failure_title()}
  guidance={m.backend_failure_guidance()}
  message={`${error}\n\nRecent backend log lines:\n${recentLog}`}
  placement="overlay"
>
  <div class="crash-report">
    <div class="crash-actions">
      <button class="ui-button" type="button" onclick={restartServer} disabled={restarting}>
        {restarting ? m.backend_failure_restarting() : m.backend_failure_restart_service()}
      </button>
      <button
        class="ui-button"
        type="button"
        onclick={collectDiagnostics}
        title={isRemote() ? desktopOnlyTitle() : undefined}
        disabled={collecting || isRemote()}
      >
        {collecting ? m.common_collecting_diagnostics() : m.common_collect_diagnostics()}
      </button>
    </div>
    <p>
      <ParaglideMessage message={m.backend_failure_report_problem} inputs={{}}>
        {#snippet link({ children })}
          <a href={BUG_REPORT_URL} onclick={openBugReport}>{@render children?.()}</a>
        {/snippet}
      </ParaglideMessage>
    </p>
    {#if savedPath}<p role="status">
        {m.backend_failure_diagnostics_saved({ path: savedPath })}
      </p>{/if}
    {#if restartError}<p role="alert">
        {m.backend_failure_restart_failed({ reason: restartError })}
      </p>{/if}
    {#if collectionError}<p role="alert">
        {m.backend_failure_save_diagnostics_failed({ reason: collectionError })}
      </p>{/if}
  </div>
</AppMessage>

<style>
  .crash-report {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-6);
  }

  .crash-report p {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .crash-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-6);
  }
</style>
