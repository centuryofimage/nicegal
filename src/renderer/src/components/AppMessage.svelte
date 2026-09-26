<script lang="ts">
  import type { Snippet } from "svelte";

  import { cleanDiagnostic } from "../lib/errors";
  import TechnicalDetails from "./TechnicalDetails.svelte";

  let {
    title,
    message,
    placement = "inline",
    tone = "error",
    actionLabel,
    onaction,
    children,
    guidance,
  }: {
    title?: string;
    message: string;
    placement?: "overlay" | "inline";
    tone?: "error" | "neutral";
    /** Renders a centered button under the message (e.g. "Choose image folder…"). */
    actionLabel?: string;
    onaction?: () => void;
    children?: Snippet;
    /** What to do next. An error overlay shows this and keeps `message` under Technical details. */
    guidance?: string;
  } = $props();
  const diagnostic = $derived(cleanDiagnostic(message));
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
    {#if guidance}<span role="alert">{guidance}</span>{/if}
    {#if message}<TechnicalDetails text={message} copyHeading={title ?? "Error"} />{/if}
  {:else}
    <span>{diagnostic}</span>
  {/if}
  {#if actionLabel}
    <button class="ui-button message-action" type="button" onclick={onaction}>{actionLabel}</button>
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
  }
</style>
