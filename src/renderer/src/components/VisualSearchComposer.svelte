<script lang="ts">
  import { ParaglideMessage } from "@inlang/paraglide-js-svelte";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";
  import { tick, untrack } from "svelte";

  import { m } from "../../../shared/paraglide/messages.js";
  import { popoverDismiss } from "../lib/popover-dismiss";
  import {
    formatVisualTextTerms,
    parseVisualTextTerms,
    type VisualReferenceTerm,
    type VisualTextTerm,
  } from "../lib/visual-query";
  import NumericStepper from "./NumericStepper.svelte";

  let {
    expression = "",
    references = [],
    onexpressionchange,
    onreferenceschange,
    onchoosefile,
    onaddlibrary,
    onclose,
    onclear,
    selectedPhotoCount = 0,
    supportsTextQueries = true,
    modelName = null,
    onopensettings,
  }: {
    expression?: string;
    references?: VisualReferenceTerm[];
    onexpressionchange: (expression: string) => void;
    onreferenceschange: (references: VisualReferenceTerm[]) => void;
    onchoosefile: () => void;
    onaddlibrary: () => void;
    onclose: () => void;
    onclear: () => void;
    selectedPhotoCount?: number;
    supportsTextQueries?: boolean;
    /** The image model in use, named when it cannot search from descriptions. */
    modelName?: string | null;
    onopensettings?: () => void;
  } = $props();

  // The popover is recreated when it closes. Its rows are a deliberately local editing draft,
  // so capture the opening expression once rather than reactively resetting it while a user types.
  const initialExpression = untrack(() => expression.trim());
  let terms = $state<VisualTextTerm[]>(parseVisualTextTerms(initialExpression));
  let lastWrittenExpression = initialExpression;
  let nextId = 0;
  let addMenuOpen = $state(false);
  let addButton: HTMLButtonElement;
  /** Description inputs in row order, filled by the attachment on each row. */
  const descriptionInputs: HTMLInputElement[] = [];
  const exampleCount = $derived(
    (supportsTextQueries ? parseVisualTextTerms(expression).length : 0) + references.length,
  );

  function formattedExpression(): string {
    return formatVisualTextTerms(terms);
  }

  function sync(): void {
    const nextExpression = formattedExpression();
    lastWrittenExpression = nextExpression.trim();
    onexpressionchange(nextExpression);
  }

  // The main field can be edited while this popover is open. Synchronize only those outside
  // edits; writes made from a row keep their draft and focus instead of remounting on each key.
  $effect(() => {
    if (expression.trim() === lastWrittenExpression) return;
    terms = parseVisualTextTerms(expression);
    lastWrittenExpression = expression.trim();
  });

  function addText(): void {
    terms = [...terms, { id: `new-${nextId++}`, text: "", polarity: "more", strength: 1 }];
    addMenuOpen = false;
    void tick().then(() => descriptionInputs.at(-1)?.focus());
  }

  function trackDescription(input: HTMLInputElement): () => void {
    descriptionInputs.push(input);
    return () => {
      const at = descriptionInputs.indexOf(input);
      if (at >= 0) descriptionInputs.splice(at, 1);
    };
  }

  function remove(id: string): void {
    terms = terms.filter((term) => term.id !== id);
    sync();
  }

  function update(index: number, changes: Partial<VisualTextTerm>): void {
    terms = terms.map((term, current) => (current === index ? { ...term, ...changes } : term));
    sync();
  }

  function updateReference(index: number, changes: Partial<VisualReferenceTerm>): void {
    onreferenceschange(
      references.map((reference, current) =>
        current === index ? { ...reference, ...changes } : reference,
      ),
    );
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && addMenuOpen) {
      event.preventDefault();
      event.stopPropagation();
      addMenuOpen = false;
      addButton?.focus();
    }
  }
</script>

<div
  class="visual-composer viewport-popup"
  role="dialog"
  aria-label={m.common_compose_visual_search()}
  tabindex="-1"
  onkeydown={keydown}
>
  <div class="composer-body">
    <div class="composer-heading">
      <span>{m.visual_composer_heading()}</span>
      <span class="composer-heading-actions">
        <span>{m.visual_composer_example_count({ count: exampleCount })}</span>
        <button
          class="close-composer"
          type="button"
          onclick={onclose}
          aria-label={m.visual_composer_close_aria()}
          title={m.visual_composer_close_tooltip()}><X size={13} aria-hidden="true" /></button
        >
      </span>
    </div>
    <p>{m.visual_composer_less_like_note()}</p>
    {#if !supportsTextQueries}
      <p class="model-note">
        <ParaglideMessage
          message={m.visual_composer_model_image_only_note}
          inputs={{ model: modelName ?? m.visual_composer_default_model() }}
        >
          {#snippet link({ children })}
            <a
              href="#search-settings"
              onclick={(event) => {
                event.preventDefault();
                onopensettings?.();
              }}>{@render children?.()}</a
            >
          {/snippet}
        </ParaglideMessage>
      </p>
      {#if terms.length}
        <div class="unsupported-terms" role="alert">
          <p>{m.visual_composer_unsupported_terms_heading()}</p>
          {#each terms as term, index (term.id)}
            <div>
              <span>{term.text || m.visual_composer_empty_description()}</span>
              <button
                type="button"
                class="remove"
                onclick={() => remove(term.id)}
                aria-label={term.text
                  ? m.visual_composer_remove_description_aria({ text: term.text })
                  : m.visual_composer_remove_example_aria({ n: index + 1 })}
                ><X size={13} aria-hidden="true" /></button
              >
            </div>
          {/each}
        </div>
      {/if}
    {/if}
    <div class="term-list">
      <div class="term-head" aria-hidden="true">
        <span>{m.visual_composer_head_match()}</span><span
          >{supportsTextQueries
            ? m.visual_composer_head_description_or_image()
            : m.visual_composer_head_image()}</span
        ><span>{m.visual_composer_head_weight()}</span><span></span>
      </div>
      {#each supportsTextQueries ? terms : [] as term, index (term.id)}
        <div class="term-row">
          <select
            aria-label={m.visual_composer_match_direction_aria({
              name: term.text || m.visual_composer_example_name({ n: index + 1 }),
            })}
            value={term.polarity}
            onchange={(event) =>
              update(index, {
                polarity: (event.currentTarget as HTMLSelectElement)
                  .value as VisualTextTerm["polarity"],
              })}
          >
            <option value="more">{m.visual_composer_more_like()}</option>
            <option value="less">{m.visual_composer_less_like()}</option>
          </select>
          <input
            {@attach trackDescription}
            aria-label={m.visual_composer_description_aria({ n: index + 1 })}
            value={term.text}
            placeholder={m.visual_composer_description_placeholder()}
            oninput={(event) =>
              update(index, { text: (event.currentTarget as HTMLInputElement).value })}
          />
          <NumericStepper
            value={term.polarity === "more" ? term.strength : -term.strength}
            label={m.visual_composer_weight_for_aria({
              name: term.text || m.visual_composer_example_name({ n: index + 1 }),
            })}
            onvaluechange={(weight) =>
              update(index, {
                polarity: weight < 0 ? "less" : "more",
                strength: Math.abs(weight),
              })}
          />
          <button
            class="remove"
            type="button"
            onclick={() => remove(term.id)}
            aria-label={m.visual_composer_remove_example_aria({ n: index + 1 })}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      {/each}
      {#each references as reference, index (reference.id)}
        <div class="term-row">
          <select
            aria-label={m.visual_composer_match_direction_aria({ name: reference.displayName })}
            value={reference.polarity}
            onchange={(event) =>
              updateReference(index, {
                polarity: (event.currentTarget as HTMLSelectElement)
                  .value as VisualReferenceTerm["polarity"],
              })}
            ><option value="more">{m.visual_composer_more_like()}</option><option value="less"
              >{m.visual_composer_less_like()}</option
            ></select
          >
          <span class="image-reference" title={reference.displayName}
            >{m.visual_composer_reference_label({
              source:
                reference.source === "library"
                  ? m.visual_composer_reference_source_library()
                  : m.visual_composer_reference_source_file(),
              name: reference.displayName,
            })}</span
          >
          <NumericStepper
            value={reference.polarity === "more" ? reference.strength : -reference.strength}
            label={m.visual_composer_weight_for_aria({ name: reference.displayName })}
            onvaluechange={(weight) =>
              updateReference(index, {
                polarity: weight < 0 ? "less" : "more",
                strength: Math.abs(weight),
              })}
          />
          <button
            class="remove"
            type="button"
            onclick={() => onreferenceschange(references.filter((_, current) => current !== index))}
            aria-label={m.visual_composer_remove_reference_aria({ name: reference.displayName })}
            ><X size={13} aria-hidden="true" /></button
          >
        </div>
      {/each}
    </div>
    <div class="composer-actions">
      <div class="add-menu" {@attach popoverDismiss(addMenuOpen, () => (addMenuOpen = false))}>
        <button
          bind:this={addButton}
          class="ui-button"
          type="button"
          aria-haspopup="menu"
          aria-expanded={addMenuOpen}
          onclick={() => (addMenuOpen = !addMenuOpen)}
          ><Plus size={13} aria-hidden="true" />
          {m.visual_composer_add_button()}
          <ChevronDown size={11} aria-hidden="true" /></button
        >
        {#if addMenuOpen}
          <div class="add-menu-popup" role="menu" aria-label={m.visual_composer_add_menu_aria()}>
            {#if supportsTextQueries}
              <button type="button" role="menuitem" onclick={addText}
                >{m.visual_composer_add_text_description()}</button
              >
            {/if}
            <button
              type="button"
              role="menuitem"
              disabled={!selectedPhotoCount}
              title={selectedPhotoCount
                ? m.visual_composer_add_selected_tooltip({ count: selectedPhotoCount })
                : m.visual_composer_select_photos_first_tooltip()}
              onclick={() => {
                onaddlibrary();
                addMenuOpen = false;
              }}
              >{selectedPhotoCount
                ? m.visual_composer_add_selected_library({ count: selectedPhotoCount })
                : m.visual_composer_add_library_photos()}</button
            >
            <button
              type="button"
              role="menuitem"
              onclick={() => {
                onchoosefile();
                addMenuOpen = false;
              }}>{m.visual_composer_choose_file()}</button
            >
          </div>
        {/if}
      </div>
      <button class="ui-button" type="button" onclick={onclear}>{m.common_clear_search()}</button>
    </div>
  </div>
</div>

<style>
  .visual-composer {
    --popup-anchor: --search-field;
    --popup-width: 520px;
    position: absolute;
    z-index: var(--z-popover);
    top: calc(100% + var(--space-3));
    left: 0;
    overflow: auto;
    border: 1px solid var(--border);
    background: var(--surface-1);
    box-shadow: var(--shadow-overlay);
    color: var(--text-secondary);
    font-size: var(--font-size-md);
  }
  .composer-body {
    display: grid;
    gap: var(--space-4);
    padding: var(--space-5);
  }
  .composer-heading {
    display: flex;
    justify-content: space-between;
    color: var(--text-primary);
    font-size: var(--font-size-md);
    font-weight: 600;
  }
  .composer-heading span:last-child,
  p {
    color: var(--text-tertiary);
    font-weight: normal;
  }
  .composer-heading-actions {
    display: inline-flex;
    align-items: center;
    gap: var(--space-4);
  }
  .close-composer {
    display: inline-grid;
    place-items: center;
    padding: 0;
    width: 20px;
    height: 20px;
    border: 0;
    background: transparent;
    color: var(--text-secondary);
  }
  .close-composer:hover {
    background: var(--surface-hover);
    color: var(--text-primary);
  }
  .close-composer:focus-visible {
    outline: var(--focus-ring);
  }
  p {
    margin: 0;
    font-size: var(--font-size-md);
  }
  .model-note a {
    color: var(--accent-active);
    text-decoration: underline;
  }
  .model-note a:hover {
    color: var(--accent);
  }
  .term-list {
    display: grid;
    border: 1px solid var(--border);
  }
  .unsupported-terms {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--danger);
    background: color-mix(in srgb, var(--danger) 7%, var(--surface-1));
  }
  .unsupported-terms p {
    color: var(--danger);
  }
  .unsupported-terms > div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding-left: var(--space-3);
    border: 1px solid var(--border);
  }
  .unsupported-terms > div span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .unsupported-terms .remove {
    width: 28px;
    flex: none;
  }
  .term-head,
  .term-row {
    display: grid;
    grid-template-columns: 84px minmax(80px, 1fr) 64px 28px;
    gap: 0;
    min-width: 0;
  }
  .term-head {
    min-height: 18px;
    align-items: center;
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
    color: var(--text-tertiary);
    font-size: var(--font-size-sm);
  }
  .term-head span {
    padding: 0 var(--space-3);
    border-right: 1px solid var(--border-subtle);
  }
  .term-row + .term-row {
    border-top: 1px solid var(--border-subtle);
  }
  select,
  input {
    min-width: 0;
    height: 25px;
    box-sizing: border-box;
    padding: 0 var(--space-4);
    border: 0;
    border-right: 1px solid var(--border-subtle);
    border-radius: 0;
    background: var(--surface-1);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--font-size-md);
  }
  .image-reference {
    display: block;
    min-width: 0;
    height: 25px;
    box-sizing: border-box;
    padding: 4px var(--space-3);
    overflow: hidden;
    border-right: 1px solid var(--border-subtle);
    color: var(--text-primary);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .remove {
    display: inline-grid;
    width: 100%;
    height: 25px;
    place-items: center;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--text-secondary);
  }
  .remove:hover {
    border-color: var(--border);
    background: var(--surface-hover);
    color: var(--text-primary);
  }
  .composer-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }
  .composer-actions :global(.ui-button) {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    flex: none;
    white-space: nowrap;
  }
  .add-menu {
    position: relative;
    flex: none;
  }
  .add-menu-popup {
    position: absolute;
    z-index: 1;
    bottom: calc(100% + var(--space-2));
    left: 0;
    display: grid;
    min-width: 158px;
    padding: var(--space-2);
    border: 1px solid var(--border);
    background: var(--surface-0);
    box-shadow: var(--shadow-overlay);
  }
  .add-menu-popup button {
    height: 23px;
    padding: 0 var(--space-4);
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-primary);
    font: inherit;
    font-size: var(--font-size-md);
    text-align: left;
  }
  .add-menu-popup button:hover:not(:disabled) {
    border-color: var(--btn-border-hover);
    background: var(--surface-hover);
  }
  .add-menu-popup button:disabled {
    color: var(--text-tertiary);
  }
  select:focus-visible,
  input:focus-visible,
  .remove:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
  @media (max-width: 520px) {
    .term-head,
    .term-row {
      grid-template-columns: 75px minmax(40px, 1fr) 58px 28px;
    }
  }
</style>
