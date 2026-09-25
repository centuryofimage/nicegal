<script lang="ts">
  import { onMount } from "svelte";

  import AppMessage from "./AppMessage.svelte";

  const BUG_REPORT_URL = "https://github.com/centuryofimage/nicegal/issues";

  let { error }: { error: string } = $props();
  let recentLog = $state("Loading recent log lines…");
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
          recentLog = `Could not read recent log lines: ${cause instanceof Error ? cause.message : String(cause)}`;
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
  title="Backend unavailable"
  guidance="The gallery service could not start or stopped unexpectedly. Try restarting the service. If it fails again, restart the app. If an app update made the index incompatible, preserve the index until migration or rebuilding is chosen."
  message={`${error}\n\nRecent backend log lines:\n${recentLog}`}
  placement="overlay"
>
  <div class="crash-report">
    <div class="crash-actions">
      <button class="ui-button" type="button" onclick={restartServer} disabled={restarting}>
        {restarting ? "Restarting…" : "Restart server"}
      </button>
      <button class="ui-button" type="button" onclick={collectDiagnostics} disabled={collecting}>
        {collecting ? "Collecting…" : "Collect diagnostics"}
      </button>
    </div>
    <p>
      Feel free to make a bug report <a href={BUG_REPORT_URL} onclick={openBugReport}>here</a> and
      attach this zip.
    </p>
    {#if savedPath}<p role="status">Diagnostics saved to {savedPath}</p>{/if}
    {#if restartError}<p role="alert">Could not restart server: {restartError}</p>{/if}
    {#if collectionError}<p role="alert">Could not save diagnostics: {collectionError}</p>{/if}
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
