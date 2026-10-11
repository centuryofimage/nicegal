<script lang="ts">
  import type { ThumbnailFailure } from "../lib/gallery/thumbnail-scheduler";

  import { m } from "../../../shared/paraglide/messages.js";
  import { errorMessage } from "../lib/errors";

  let {
    failures,
    onretry,
  }: {
    failures: readonly (ThumbnailFailure & { name?: string })[];
    onretry: () => void;
  } = $props();
  let showDetails = $state(false);
  let copyStatus = $state("");
  const diagnostic = $derived(
    failures
      .map(
        (failure) =>
          `${failure.name || failure.assetId}\nAsset: ${failure.assetId}\nAttempts: ${failure.attempts}\n${errorMessage(failure.error)}`,
      )
      .join("\n\n"),
  );

  async function copyDetails(): Promise<void> {
    try {
      await navigator.clipboard.writeText(diagnostic);
      copyStatus = m.common_copied();
    } catch {
      copyStatus = m.common_copy_failed();
    }
  }

  function retry(): void {
    showDetails = false;
    onretry();
  }
</script>

{#if failures.length}
  <details class="thumbnail-diagnostics" bind:open={showDetails}>
    <summary>{m.thumbnail_failures_summary({ count: failures.length })}</summary>
    <div class="thumbnail-details">
      <p>{m.thumbnail_failures_retry_help()}</p>
      <textarea readonly aria-label={m.thumbnail_failures_details_aria()} value={diagnostic}
      ></textarea>
      <span role="status">{copyStatus}</span>
      <div class="actions">
        <button class="ui-button" type="button" onclick={copyDetails}
          >{m.common_copy_details()}</button
        >
        <button class="ui-button" type="button" onclick={retry} disabled={!failures.length}
          >{m.thumbnail_failures_retry_button()}</button
        >
        <button
          class="ui-button"
          type="button"
          onclick={(event) => {
            showDetails = false;
            event.currentTarget.closest("details")?.querySelector("summary")?.focus();
          }}>{m.common_dismiss()}</button
        >
      </div>
    </div>
  </details>
{/if}

<style>
  .thumbnail-diagnostics {
    padding-block: var(--space-8);
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-primary);
    font-size: var(--font-size-md);
  }
  summary {
    cursor: pointer;
  }
  summary:focus-visible {
    outline: var(--focus-ring);
  }
  .thumbnail-details {
    display: grid;
    gap: var(--space-6);
    padding-top: var(--space-6);
    font-size: var(--font-size-md);
  }
  p {
    margin: 0;
  }
  textarea {
    width: 100%;
    min-width: 0;
    height: min(220px, 30vh);
    resize: none;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
    color: var(--text-primary);
    background: var(--surface-1);
    border: 1px solid var(--border);
    font-size: var(--font-size-sm);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--space-6);
  }
</style>
