<!--
  @component
  Opened from the status bar's search warning: what went wrong, the one action that fixes it, and
  the technical text for a bug report.
-->
<script lang="ts">
  import type { SearchIssue } from "../lib/search-issue";

  import { m } from "../../../shared/paraglide/messages.js";
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

<Modal
  labelledby="search-problem-title"
  describedby="search-problem-guidance"
  {onclose}
  --modal-width="480px"
>
  <section class="dialog-panel">
    <h1 id="search-problem-title">{issue.label}</h1>
    <p id="search-problem-guidance">{issue.guidance}</p>
    {#if issue.detail}<TechnicalDetails text={issue.detail} copyHeading={issue.label} />{/if}
    <footer class="dialog-footer">
      {#if issue.action === "rescan"}
        <button class="ui-button" onclick={onrescan} disabled={!canRescan}
          >{m.common_rescan_library()}</button
        >
        <button class="ui-button" onclick={onsettings}>{m.common_search_settings_ellipsis()}</button
        >
      {:else if issue.action === "retry"}
        <button class="ui-button" onclick={onretry}>{m.common_try_again()}</button>
      {:else}
        <button class="ui-button" onclick={onsettings}>{m.common_search_settings_ellipsis()}</button
        >
      {/if}
      <button class="ui-button" onclick={onclose}>{m.common_close()}</button>
    </footer>
  </section>
</Modal>

<style>
  p {
    color: var(--text-secondary);
    overflow-wrap: anywhere;
  }
</style>
