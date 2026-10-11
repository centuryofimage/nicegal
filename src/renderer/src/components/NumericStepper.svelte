<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronUp from "@lucide/svelte/icons/chevron-up";
  import { untrack } from "svelte";

  import { m } from "../../../shared/paraglide/messages.js";

  let {
    value,
    label,
    onvaluechange,
  }: {
    value: number;
    label: string;
    onvaluechange: (value: number) => void;
  } = $props();

  // This is an editable draft, not mirrored reactive state. The parent owns accepted numeric
  // values; the field retains partial input such as `2.` until the user finishes editing it.
  let text = $state(untrack(() => format(value)));
  let lastWrittenValue = untrack(() => value);

  // A direction change in the adjacent select must update the signed weight too. Local
  // keystrokes still retain drafts such as `2.` until blur.
  $effect(() => {
    if (value === lastWrittenValue) return;
    text = format(value);
    lastWrittenValue = value;
  });

  function format(next: number): string {
    return next.toFixed(2);
  }

  function commit(next: number, zeroDirection = 0): void {
    if (!Number.isFinite(next)) {
      text = format(value);
      return;
    }
    // A zero vector is invalid for CLIP composition. Stepping through zero changes directly from
    // +1.00 to -1.00 (or back), rather than producing an arbitrary epsilon that looks like a bug.
    if (next === 0) next = zeroDirection || Math.sign(value) || 1;
    const bounded = Math.max(-100, Math.min(100, next));
    text = format(bounded);
    lastWrittenValue = bounded;
    onvaluechange(bounded);
  }

  function input(event: Event): void {
    text = (event.currentTarget as HTMLInputElement).value;
    const next = Number(text);
    if (Number.isFinite(next) && next !== 0) {
      lastWrittenValue = Math.max(-100, Math.min(100, next));
      onvaluechange(lastWrittenValue);
    }
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const parsed = Number(text);
    const direction = event.key === "ArrowUp" ? 1 : -1;
    commit((Number.isFinite(parsed) ? parsed : value) + direction, direction);
  }
</script>

<div class="numeric-stepper">
  <input
    aria-label={label}
    type="text"
    inputmode="decimal"
    value={text}
    oninput={input}
    onkeydown={keydown}
    onblur={() => commit(Number(text))}
  />
  <span class="step-buttons" aria-hidden="false">
    <button
      type="button"
      aria-label={m.numeric_stepper_increase({ label })}
      onclick={() => commit(value + 1, 1)}><ChevronUp size={10} aria-hidden="true" /></button
    >
    <button
      type="button"
      aria-label={m.numeric_stepper_decrease({ label })}
      onclick={() => commit(value - 1, -1)}><ChevronDown size={10} aria-hidden="true" /></button
    >
  </span>
</div>

<style>
  .numeric-stepper {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 15px;
    height: 25px;
    border-right: 1px solid var(--border-subtle);
  }
  input {
    min-width: 0;
    padding: 0 var(--space-3);
    border: 0;
    background: var(--surface-1);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--font-size-md);
    text-align: right;
  }
  .step-buttons {
    display: grid;
    grid-template-rows: 1fr 1fr;
    border-left: 1px solid var(--border-subtle);
  }
  .step-buttons button {
    display: grid;
    place-items: center;
    min-width: 0;
    padding: 0;
    border: 0;
    background: var(--surface-1);
    color: var(--text-secondary);
  }
  .step-buttons button + button {
    border-top: 1px solid var(--border-subtle);
  }
  .step-buttons button:hover {
    background: var(--surface-hover);
    color: var(--text-primary);
  }
  input:focus-visible,
  .step-buttons button:focus-visible {
    outline: var(--focus-ring);
    outline-offset: calc(-1 * var(--focus-ring-offset));
  }
</style>
