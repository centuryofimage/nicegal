<script lang="ts">
  import type { JobSnapshot } from "../../../shared/backend";

  import { m } from "../../../shared/paraglide/messages.js";
  import Modal from "./Modal.svelte";

  let { errors, onclose }: { errors: JobSnapshot["errors"]; onclose: () => void } = $props();
  let selectedIndex = $state(0);
  const selected = $derived(errors[Math.min(selectedIndex, errors.length - 1)]);

  function fileName(path: string | null | undefined): string {
    return path?.split(/[\\/]/).pop() || m.job_errors_fallback_file_name();
  }
</script>

<Modal labelledby="job-errors-title" {onclose}>
  <section class="dialog-panel">
    <header>
      <h1 id="job-errors-title">{m.job_errors_title({ count: errors.length })}</h1>
      <button class="ui-button ui-button-compact" onclick={onclose}>{m.common_close()}</button>
    </header>
    <p>{m.job_errors_intro()}</p>
    <div class="error-browser">
      <nav aria-label={m.job_errors_list_aria()}>
        {#each errors as error, index (index)}
          <button
            class:selected={selectedIndex === index}
            aria-current={selectedIndex === index ? "true" : undefined}
            title={error.path || error.message}
            onclick={() => (selectedIndex = index)}
          >
            <span class="error-number">{index + 1}</span>
            <span class="file-name">{fileName(error.path)}</span>
          </button>
        {/each}
      </nav>
      <section class="error-detail" aria-label={m.job_errors_selected_aria()} aria-live="polite">
        {#if selected}
          <h2>{fileName(selected.path)}</h2>
          {#if selected.path}<p class="path">{selected.path}</p>{/if}
          <h3>{m.job_errors_details_heading()}</h3>
          <p class="message">{selected.message}</p>
        {/if}
      </section>
    </div>
  </section>
</Modal>

<style>
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
  }
  h1,
  h2,
  h3,
  p {
    margin: 0;
  }
  h1 {
    font-size: var(--dialog-title-size);
  }
  .path,
  .error-number {
    color: var(--text-secondary);
  }
  .dialog-panel > p {
    color: var(--text-secondary);
  }
  button {
    font: inherit;
    color: var(--text-primary);
    cursor: pointer;
  }
  .error-browser {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr);
    height: min(340px, 55dvh);
    border: 1px solid var(--border);
    background: var(--surface-1);
  }
  nav {
    overflow: auto;
    border-right: 1px solid var(--border);
  }
  nav button {
    display: flex;
    width: 100%;
    gap: var(--space-8);
    padding: var(--space-7);
    border: 0;
    border-bottom: 1px solid var(--border-subtle);
    background: transparent;
    text-align: left;
  }
  nav button:hover {
    background: var(--surface-hover);
  }
  nav button.selected {
    background: var(--surface-hover);
    box-shadow: inset 3px 0 var(--accent);
  }
  .error-number {
    flex: none;
    min-width: 2ch;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .file-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .error-detail {
    min-width: 0;
    overflow: auto;
    padding: var(--space-12);
    overflow-wrap: anywhere;
  }
  h2 {
    font-size: var(--font-size-md);
  }
  .path {
    margin-top: var(--space-4);
    font-size: var(--font-size-sm);
  }
  h3 {
    margin: var(--space-12) 0 var(--space-5);
    font-size: var(--font-size-sm);
  }
  .message {
    white-space: pre-wrap;
    user-select: text;
  }
  .path {
    user-select: text;
  }
  button:focus-visible,
  .error-detail:focus-visible {
    outline: var(--focus-ring);
    outline-offset: -2px;
  }
  @media (width < 40rem) {
    .error-browser {
      grid-template-columns: 1fr;
      grid-template-rows: 40% minmax(0, 1fr);
      height: 55dvh;
    }
    nav {
      border-right: 0;
      border-bottom: 1px solid var(--border);
    }
  }
</style>
