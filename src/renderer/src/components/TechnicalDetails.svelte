<!--
  @component
  Collapsed, selectable diagnostic text with Copy details. Guidance stays outside it: this holds
  only what a bug report needs.
-->
<script lang="ts">
  import { cleanDiagnostic } from "../lib/errors";

  let {
    text,
    summary = "Technical details",
    copyHeading,
  }: {
    text: string;
    summary?: string;
    /** First line of the copied report, e.g. the message title. */
    copyHeading?: string;
  } = $props();
  let copyStatus = $state("");
  const diagnostic = $derived(cleanDiagnostic(text));

  async function copyDetails(): Promise<void> {
    try {
      await navigator.clipboard.writeText(
        copyHeading ? `${copyHeading}\n${diagnostic}` : diagnostic,
      );
      copyStatus = "Copied";
    } catch {
      copyStatus = "Select the details and copy them manually.";
    }
  }
</script>

<details class="technical-details">
  <summary>{summary}</summary>
  <textarea readonly aria-label={summary} value={diagnostic}></textarea>
  <button class="ui-button ui-button-compact" type="button" onclick={copyDetails}
    >Copy details</button
  >
  <span role="status">{copyStatus}</span>
</details>

<style>
  .technical-details {
    min-width: 0;
    text-align: left;
  }
  summary {
    cursor: pointer;
  }
  textarea {
    display: block;
    box-sizing: border-box;
    width: 100%;
    height: min(220px, 30vh);
    margin-block: var(--space-6);
    resize: vertical;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    background: var(--surface-1);
    border: 1px solid var(--border);
  }
  span {
    margin-left: var(--space-6);
    color: var(--text-secondary);
  }
</style>
