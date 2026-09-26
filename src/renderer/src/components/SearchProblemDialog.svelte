<!--
  @component
  Opened from the status bar's search warning: what went wrong, the one action that fixes it, and
  the technical text for a bug report.
-->
<script lang="ts">
  import type { SearchIssue } from "../lib/search-issue";

  import Modal from "./Modal.svelte";
  import TechnicalDetails from "./TechnicalDetails.svelte";

  let {
    issue,
    canRescan,
    onrescan,
    onsettings,
    onretry,
    onclose,
  }: {
    issue: SearchIssue;
    /** A library is selected and the service is ready. */
    canRescan: boolean;
    onrescan: () => void;
    onsettings: () => void;
    onretry: () => void;
    onclose: () => void;
  } = $props();
</script>

<Modal labelledby="search-problem-title" describedby="search-problem-guidance" {onclose}>
  <section class="search-problem">
    <h1 id="search-problem-title">{issue.label}</h1>
    <p id="search-problem-guidance">{issue.guidance}</p>
    {#if issue.detail}<TechnicalDetails text={issue.detail} copyHeading={issue.label} />{/if}
    <footer>
      {#if issue.action === "rescan"}
        <button class="ui-button" onclick={onrescan} disabled={!canRescan}>Rescan library</button>
        <button class="ui-button" onclick={onsettings}>Search settings…</button>
      {:else if issue.action === "retry"}
        <button class="ui-button" onclick={onretry}>Try again</button>
      {:else}
        <button class="ui-button" onclick={onsettings}>Search settings…</button>
      {/if}
      <button class="ui-button" onclick={onclose}>Close</button>
    </footer>
  </section>
</Modal>

<style>
  .search-problem {
    display: grid;
    gap: var(--space-8);
    box-sizing: border-box;
    width: min(480px, calc(100vw - var(--space-16) * 2));
    padding: var(--space-12);
    border: 1px solid var(--border-strong);
    background: var(--surface-0);
    box-shadow: var(--shadow-overlay);
    color: var(--text-primary);
    font-size: var(--font-size-md);
  }
  h1,
  p {
    margin: 0;
  }
  h1 {
    font-size: var(--dialog-title-size);
  }
  p {
    color: var(--text-secondary);
    overflow-wrap: anywhere;
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--space-6);
  }
</style>
