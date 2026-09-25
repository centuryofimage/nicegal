<script lang="ts">
  import type { Snippet } from "svelte";
  import { cleanDiagnostic } from "../lib/errors";
  let {
    title,
    message,
    placement = "inline",
    tone = "error",
    actionLabel,
    onaction,
    children,
    guidance = "The operation could not finish. Review the details below, then try again.",
  }: {
    title?: string;
    message: string;
    placement?: "overlay" | "inline";
    tone?: "error" | "neutral";
    /** Renders a centered button under the message (e.g. "Choose image folder…"). */
    actionLabel?: string;
    onaction?: () => void;
    children?: Snippet;
    guidance?: string;
  } = $props();
  let copyStatus = $state("");
  const diagnostic = $derived(cleanDiagnostic(message));
  async function copyDetails(): Promise<void> {
    try {
      await navigator.clipboard.writeText(`${title ?? "Error"}\n${diagnostic}`);
      copyStatus = "Copied";
    } catch {
      copyStatus = "Select the details and copy them manually.";
    }
  }
</script>

<div
  class={{
    overlay: placement === "overlay",
    inline: placement === "inline",
    error: tone === "error",
  }}
>
  {#if title}<strong>{title}</strong>{/if}
  {#if tone === "error" && placement === "overlay"}
    <span role="alert">{guidance}</span>
    <details>
      <summary>Technical details</summary>
      <textarea readonly aria-label="Technical error details" value={diagnostic}></textarea>
      <button class="ui-button" type="button" onclick={copyDetails}>Copy details</button>
      <span role="status">{copyStatus}</span>
    </details>
  {:else}
    <span>{diagnostic}</span>
  {/if}
  {#if actionLabel}
    <button class="message-action" type="button" onclick={onaction}>{actionLabel}</button>
  {/if}
  {#if children}{@render children()}{/if}
</div>

<style>
  .overlay {
    z-index: var(--z-overlay, 30);
    position: absolute;
    inset: 50% auto auto 50%;
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    box-sizing: border-box;
    width: min(560px, calc(100% - (var(--space-16) * 2)));
    max-height: calc(100% - var(--space-16) * 2);
    overflow: auto;
    padding: var(--space-14) var(--space-16);
    transform: translate(-50%, -50%);
    color: var(--text-secondary);
    background: var(--surface-0);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-overlay);
    text-align: center;
  }

  strong {
    color: var(--text-primary);
  }

  details {
    text-align: left;
    min-width: 0;
  }
  summary {
    cursor: pointer;
  }
  textarea {
    display: block;
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

  .error.overlay {
    border-color: color-mix(in srgb, var(--danger) 55%, var(--border));
  }

  span {
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .inline {
    color: var(--danger);
    overflow-wrap: anywhere;
  }

  .message-action {
    align-self: center;
    padding: var(--space-4) var(--space-14);
    border: 1px solid var(--btn-border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .message-action:hover {
    border-color: var(--btn-border-hover);
    background: var(--btn-face-hover);
  }

  .message-action:active {
    border-color: var(--btn-border-active);
    background: var(--btn-face-active);
  }
</style>
