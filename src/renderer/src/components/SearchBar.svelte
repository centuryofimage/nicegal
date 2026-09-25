<script lang="ts">
  import CalendarDays from "@lucide/svelte/icons/calendar-days";
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import FileText from "@lucide/svelte/icons/file-text";
  import FolderSearch from "@lucide/svelte/icons/folder-search";
  import Images from "@lucide/svelte/icons/images";
  import Info from "@lucide/svelte/icons/info";
  import ScanEye from "@lucide/svelte/icons/scan-eye";
  import ScanText from "@lucide/svelte/icons/scan-text";
  import Search from "@lucide/svelte/icons/search";
  import TextSearch from "@lucide/svelte/icons/text-search";
  import X from "@lucide/svelte/icons/x";
  import { tick } from "svelte";

  import { useApplication } from "../lib/application.svelte";
  import { folderName } from "../lib/library-root";
  import { isQuerySyntaxError } from "../lib/errors";
  import { popoverDismiss } from "../lib/popover-dismiss";
  import {
    OCR_SYNTAX_NOTES,
    parseQuery,
    textWithoutFolder,
    textWithoutScope,
    withFolder,
    withScope,
    type SearchScope,
  } from "../lib/search-query";
  import { parseVisualTextTerms, type VisualReferenceTerm } from "../lib/visual-query";
  import VisualSearchComposer from "./VisualSearchComposer.svelte";
  const {
    services: { runtime, catalog, jobs },
  } = useApplication();

  // The match count used to sit at the right of the field; it lives in the status bar's items
  // segment now (see StatusBar.svelte), which has the width to spare and no duplicate denominator.
  let {
    value = $bindable(""),
    composerOpen = $bindable(false),
    message,
    infoNotice,
    textSetupRequired = false,
    semanticSuggestion = false,
    onsemanticsearch,
    onsetuptextsearch,
    visualReferences = [],
    onvisualreferenceschange,
    onchoosevisualfile,
    onaddlibraryvisual,
    ondropvisualfiles,
    selectedPhotoCount = 0,
  }: {
    value?: string;
    composerOpen?: boolean;
    message?: string | null;
    infoNotice?: string | null;
    textSetupRequired?: boolean;
    semanticSuggestion?: boolean;
    onsemanticsearch?: () => void;
    onsetuptextsearch: () => void;
    visualReferences?: VisualReferenceTerm[];
    onvisualreferenceschange?: (references: VisualReferenceTerm[]) => void;
    onchoosevisualfile?: () => void;
    onaddlibraryvisual?: () => void;
    ondropvisualfiles?: (files: File[]) => void;
    selectedPhotoCount?: number;
  } = $props();

  type ScopeOption = {
    scope: SearchScope;
    /** Text on the chip button. */
    label: string;
    /** Text on the menu row. */
    menuLabel: string;
    /** Prefix this scope types into the box, shown in the menu's accelerator column. */
    prefix: string;
    /** One line saying what the scope matches. The menu rows stay one line each, so this and
     * `syntax` are the only place the detail is written down. */
    summary: string;
    /** Syntax notes for scopes whose body is interpreted rather than taken literally. */
    syntax?: string[];
    icon: typeof Search;
  };

  const scopeOptions: ScopeOption[] = [
    {
      scope: "all",
      label: "All",
      menuLabel: "All",
      prefix: "",
      summary: "File names, exact text, related text, and visual results",
      icon: Search,
    },
    {
      scope: "like",
      label: "Visual search",
      menuLabel: "Visual search",
      prefix: "like:",
      summary: "Find images using descriptions or example images",
      icon: ScanEye,
    },
    {
      scope: "name",
      label: "Name",
      menuLabel: "File name",
      prefix: "name:",
      summary: "File names only",
      icon: FileText,
    },
    {
      scope: "ocr",
      label: "Text",
      menuLabel: "Exact text",
      prefix: "ocr:",
      summary: "Exact words read from the picture. All words must match.",
      syntax: [...OCR_SYNTAX_NOTES],
      icon: ScanText,
    },
    {
      scope: "meaning",
      label: "Related text",
      menuLabel: "Related text",
      prefix: "meaning:",
      summary: "Text found in pictures, matched by meaning instead of spelling",
      icon: TextSearch,
    },
  ];
  function localIsoDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  let exampleDate = $state(localIsoDate(new Date()));
  const filterExamples = $derived([
    { label: "Path", token: 'path:"Trips"', prefix: 'path:"Trips"', icon: FolderSearch },
    {
      label: "Before",
      token: `before:${exampleDate}`,
      prefix: `before:${exampleDate}`,
      icon: CalendarDays,
    },
    {
      label: "After",
      token: `after:${exampleDate}`,
      prefix: `after:${exampleDate}`,
      icon: CalendarDays,
    },
    {
      label: "During",
      token: `during:${exampleDate}`,
      prefix: `during:${exampleDate}`,
      icon: CalendarDays,
    },
    { label: "Type", token: "type:video", prefix: "type:video", icon: Images },
  ] as const);

  /** Wide enough that inline syntax notes read as separate items without a bullet between them.
   * Both places it lands are `white-space: pre`, so the run survives. */
  const SYNTAX_GAP = "     ";

  /** Tooltip: summary first, then one syntax note per line. */
  function scopeTitle(option: ScopeOption): string {
    if (!runtime.supportsImageTextQueries && option.scope === "like")
      return "Find similar images using image examples";
    return [option.summary, ...(option.syntax ?? [])].join("\n");
  }

  /**
   * The same copy as `scopeTitle`, laid out for one line inside the search box. Scopes with
   * syntax show only that: the summary restates the chip beside it, and the flattened whole runs
   * wider than the box at ordinary window sizes.
   */
  function scopeHintText(option: ScopeOption): string {
    if (!runtime.supportsImageTextQueries && option.scope === "like")
      return "Add an image example to find similar pictures";
    return option.syntax?.length ? option.syntax.join(SYNTAX_GAP) : option.summary;
  }

  let inputEl: HTMLInputElement;
  export function focus(): void {
    inputEl?.focus();
  }
  let backdropEl: HTMLDivElement;
  let menuOpen = $state(false);
  let searchBarEl: HTMLDivElement;
  const hintId = $props.id();

  const parsed = $derived(parseQuery(value));
  // Keep the scope in the serialized query, but outside the editable body. Typed scope
  // operators still override the picker; other operators remain part of the editable text.
  const inputValue = $derived.by(() => {
    const text = textWithoutScope(parseQuery(textWithoutFolder(parsed.tokens)).tokens);
    return parsed.scope === "all" ? text : text.replace(/^\s+/, "");
  });
  const inputTokens = $derived(parseQuery(inputValue).tokens);
  function setInputValue(text: string): void {
    const typed = parseQuery(text);
    const scoped =
      typed.scope !== "all" || parsed.scope === "all" ? text : `${parsed.scope}: ${text}`;
    value = typed.folder || !parsed.folder ? scoped : `in:"${parsed.folder}" ${scoped}`;
  }
  const preparingImages = $derived(
    catalog.selectedId !== null && jobs.scanState(catalog.selectedId) !== null,
  );
  const imageNotice = $derived(
    parsed.scope === "like" && (catalog.selectedStatus?.imageCoverage?.indexed ?? 0) === 0
      ? preparingImages
        ? "Preparing visual search… You can keep browsing."
        : "Visual search is not ready for this library yet."
      : "",
  );
  const exampleCount = $derived(parseVisualTextTerms(parsed.body).length + visualReferences.length);
  const selectedScope = $derived(
    scopeOptions.find((option) => option.scope === parsed.scope) ?? scopeOptions[0],
  );
  const noOcr = $derived(
    Boolean(
      catalog.selectedStatus &&
      !catalog.selectedStatus.loading &&
      !catalog.selectedStatus.error &&
      (catalog.selectedStatus.indexed === 0 ||
        (parsed.scope === "meaning" && catalog.selectedStatus.embedded === 0)),
    ),
  );
  const ocrNotice = $derived(
    (noOcr || textSetupRequired) && (parsed.scope === "ocr" || parsed.scope === "meaning")
      ? "Text search hasn’t been set up for this library."
      : "",
  );
  const ScopeIcon = $derived(selectedScope.icon);
  /**
   * Empty scoped fields show their syntax hints; filters are visible input, even when the
   * searchable body is empty. All uses the regular placeholder.
   */
  const scopeHint = $derived.by(() => {
    if (parsed.scope === "all" || inputValue.trim()) return "";
    const reference = visualReferences[0];
    const text =
      parsed.scope === "like" && reference
        ? visualReferences.length === 1
          ? `Images ${reference.polarity === "less" ? "less " : ""}like ${reference.displayName}`
          : `Visual search with ${visualReferences.length} images`
        : scopeHintText(selectedScope);
    return text;
  });
  /** Syntax reminder under a rejected query — the same line the empty box shows as ghost text,
   * repeated where the user actually is when they get it wrong. */
  const messageHint = $derived(
    message && isQuerySyntaxError(message) ? OCR_SYNTAX_NOTES.join(SYNTAX_GAP) : "",
  );
  // Scoped searches use the syntax hint instead.
  const placeholder = "Search file names, text, and images";

  function selectScope(scope: SearchScope): void {
    composerOpen = false;
    if (scope !== "like") onvisualreferenceschange?.([]);
    value = withScope(value, scope);
    menuOpen = false;
    inputEl?.focus();
  }

  function insertFilter(token: string): void {
    value = `${value.trimEnd()}${value.trim() ? " " : ""}${token}`;
    menuOpen = false;
    void tick().then(() => {
      inputEl?.focus();
      const end = inputValue.length;
      const quoted = token.includes(':"') && token.endsWith('"');
      inputEl?.setSelectionRange(
        end - token.length + token.indexOf(":") + 1 + (quoted ? 1 : 0),
        end - (quoted ? 1 : 0),
      );
    });
  }

  function toggleMenu(): void {
    composerOpen = false;
    if (!menuOpen) exampleDate = localIsoDate(new Date());
    menuOpen = !menuOpen;
  }

  function toggleComposer(): void {
    menuOpen = false;
    composerOpen = !composerOpen;
    if (composerOpen) {
      void tick().then(() => {
        const target =
          searchBarEl.querySelector<HTMLElement>(".visual-composer input") ??
          searchBarEl.querySelector<HTMLElement>(".visual-composer .add-menu > button");
        target?.focus();
      });
    }
  }

  function closeComposer(): void {
    composerOpen = false;
    inputEl?.focus();
  }

  function dismissPopovers(): void {
    menuOpen = false;
    composerOpen = false;
  }

  function focusout(event: FocusEvent): void {
    if (event.relatedTarget instanceof Node && !searchBarEl.contains(event.relatedTarget)) {
      dismissPopovers();
    }
  }

  function clear(): void {
    dismissPopovers();
    onvisualreferenceschange?.([]);
    value = withScope("", parsed.scope);
    inputEl?.focus();
  }

  function activateSemanticSearch(event: MouseEvent): void {
    event.preventDefault();
    onsemanticsearch?.();
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement && !event.isComposing) {
      event.preventDefault();
      dismissPopovers();
      inputEl?.focus();
      return;
    }
    if (event.key !== "Escape") return;

    if (menuOpen || composerOpen) {
      event.preventDefault();
      event.stopPropagation();
      dismissPopovers();
      inputEl?.focus();
      return;
    }

    if (event.target === inputEl && (inputValue || visualReferences.length)) {
      event.preventDefault();
      event.stopPropagation();
      clear();
    }
  }

  function syncBackdrop(event: Event): void {
    backdropEl.scrollLeft = (event.currentTarget as HTMLInputElement).scrollLeft;
  }

  /** The composer owns only the visual expression. Filters retain their effect when a visual term changes. */
  function setVisualExpression(expression: string): void {
    const filters = parsed.tokens
      .filter(
        (token) =>
          token.kind === "date" ||
          token.kind === "media" ||
          token.kind === "path" ||
          token.kind === "folder",
      )
      .map((token) => token.raw)
      .join(" ");
    value = `like:${expression ? ` ${expression}` : ""}${filters ? ` ${filters}` : ""}`;
  }

  function dropVisualFiles(event: DragEvent): void {
    if (parsed.scope !== "like") return;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    ondropvisualfiles?.(files);
  }
</script>

<!-- Keyboard events are delegated from the search controls and the nested composer. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="search-bar"
  bind:this={searchBarEl}
  role="search"
  {onkeydown}
  onfocusout={focusout}
  ondragover={(event) => parsed.scope === "like" && event.preventDefault()}
  ondrop={dropVisualFiles}
  {@attach popoverDismiss(menuOpen || composerOpen, dismissPopovers)}
>
  <div class="search-field">
    <div class="scope-control">
      <button
        class="scope-button"
        type="button"
        aria-label="Search scope: {selectedScope.label}"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onclick={toggleMenu}
      >
        <ScopeIcon size={12} aria-hidden="true" />
        <span>{selectedScope.label}</span>
        <ChevronDown size={11} aria-hidden="true" />
      </button>

      {#if menuOpen || semanticSuggestion}
        <div class="scope-popovers">
          {#if menuOpen}
            <div class="scope-menu" role="menu" aria-label="Search scope">
              {#each scopeOptions as option (option.scope)}
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.scope === parsed.scope}
                  title={scopeTitle(option)}
                  onclick={() => selectScope(option.scope)}
                >
                  <span class="scope-menu-mark" aria-hidden="true">
                    {#if option.scope === parsed.scope}<Check size={11} />{/if}
                  </span>
                  <option.icon class="scope-menu-icon" size={13} aria-hidden="true" />
                  <span class="scope-menu-label">{option.menuLabel}</span>
                  <span class="scope-menu-prefix">{option.prefix}</span>
                </button>
              {/each}
              <div class="scope-menu-separator" role="separator"></div>
              <div class="scope-menu-heading">Filters</div>
              {#each filterExamples as filter (filter.label)}
                <button type="button" role="menuitem" onclick={() => insertFilter(filter.token)}>
                  <span class="scope-menu-mark" aria-hidden="true"></span>
                  <filter.icon class="scope-menu-icon" size={13} aria-hidden="true" />
                  <span class="scope-menu-label">{filter.label}</span>
                  <span class="scope-menu-prefix">{filter.prefix}</span>
                </button>
              {/each}
            </div>
          {/if}
          {#if semanticSuggestion}
            <div class="semantic-suggestion" role="status">
              <TextSearch size={11} aria-hidden="true" />
              <span>Want broader results?</span>
              <a href="#meaning-search" onclick={activateSemanticSearch}>Find related text</a>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <div class="input-wrap">
      <!-- The hint rides a data attribute and a ::after rather than a trailing element: the
           backdrop is `white-space: pre`, so any markup added here prints its own indentation. -->
      <div class="input-backdrop" bind:this={backdropEl} data-hint={scopeHint} aria-hidden="true">
        {#each inputTokens as token (token)}{#if token.kind === "scope" || token.kind === "date" || token.kind === "media" || token.kind === "folder" || token.kind === "path"}<span
              class:token-invalid={token.kind === "date" && !token.valid}
              class="token">{token.raw}</span
            >{:else}{token.raw}{/if}{/each}
      </div>
      <input
        bind:this={inputEl}
        bind:value={() => inputValue, setInputValue}
        readonly={parsed.scope === "like" && !runtime.supportsImageTextQueries}
        onclick={() => {
          if (parsed.scope === "like" && !runtime.supportsImageTextQueries && !composerOpen)
            toggleComposer();
        }}
        onscroll={syncBackdrop}
        type="text"
        placeholder={parsed.scope === "all" ? placeholder : ""}
        spellcheck="false"
        autocomplete="off"
        aria-label="Search"
        aria-describedby={scopeHint ? hintId : undefined}
      />
      <span id={hintId} class="search-hint-accessible">{scopeHint.trim()}</span>
    </div>

    {#if parsed.folder}
      <button
        class="folder-focus-chip"
        type="button"
        title={parsed.folder}
        aria-label={`Show all folders; remove ${parsed.folder} filter`}
        onclick={() => (value = withFolder(value, null))}
      >
        <FolderSearch size={12} aria-hidden="true" /><span>{folderName(parsed.folder)}</span><X
          size={11}
          aria-hidden="true"
        />
      </button>
    {/if}

    {#if parsed.scope === "like" && visualReferences.length}
      <button
        class="scope-button photo-reference-chip"
        type="button"
        aria-label={`Visual search includes ${visualReferences.length} photo examples`}
        aria-expanded={composerOpen}
        aria-haspopup="dialog"
        onclick={toggleComposer}
      >
        <span>{visualReferences.length}</span><Images size={12} aria-hidden="true" />
        <ChevronDown size={11} aria-hidden="true" />
      </button>
    {/if}

    {#if inputValue || visualReferences.length}
      <button
        class="clear-button"
        type="button"
        onclick={clear}
        title="Clear search"
        aria-label="Clear search"
      >
        <X size={11} aria-hidden="true" />
      </button>
    {/if}
  </div>
  {#if parsed.scope === "like"}
    <div class="compose-chip-row">
      <button
        class="compose-chip"
        type="button"
        aria-expanded={composerOpen}
        aria-haspopup="dialog"
        onclick={toggleComposer}
      >
        <span
          >Compose visual search{exampleCount
            ? ` · ${exampleCount} example${exampleCount === 1 ? "" : "s"}`
            : ""}</span
        >
        <ChevronDown size={11} aria-hidden="true" />
      </button>
    </div>
  {/if}
  {#if parsed.scope === "like" && composerOpen}
    <VisualSearchComposer
      supportsTextQueries={runtime.supportsImageTextQueries}
      expression={parsed.body}
      references={visualReferences}
      onexpressionchange={setVisualExpression}
      onreferenceschange={(references) => onvisualreferenceschange?.(references)}
      onchoosefile={() => onchoosevisualfile?.()}
      onaddlibrary={() => onaddlibraryvisual?.()}
      {selectedPhotoCount}
      onclose={closeComposer}
      onclear={clear}
    />
  {/if}
  {#if message && !menuOpen && !composerOpen}
    <div class="search-message search-error" role="alert">
      <CircleAlert size={12} aria-hidden="true" />
      <div class="search-message-body">
        <span>{message}</span>
        {#if messageHint}<span class="search-message-hint">{messageHint}</span>{/if}
      </div>
    </div>
  {:else if (imageNotice || ocrNotice || infoNotice) && !menuOpen}
    <div class="search-message search-info" role="status">
      <Info size={12} aria-hidden="true" />
      <span>{imageNotice || ocrNotice || infoNotice}</span>
      {#if imageNotice && !preparingImages}
        <button class="ui-button" type="button" onclick={onsetuptextsearch}>Library manager</button>
      {:else if ocrNotice}
        <button class="ui-button" type="button" onclick={onsetuptextsearch}
          >Set up text search</button
        >
      {/if}
    </div>
  {/if}
</div>

<style>
  .search-bar {
    position: relative;
    width: 100%;
    min-width: 0;
    color: var(--text-secondary);
  }

  .search-field {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    /* The dedicated search row is deliberately roomier than --control-height. */
    height: var(--toolbar-control-height);
    min-width: 0;
    padding: 0 var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .search-field:focus-within {
    border-color: var(--accent);
  }
  .folder-focus-chip {
    display: inline-flex;
    flex: none;
    max-width: 120px;
    height: 21px;
    align-items: center;
    gap: var(--space-3);
    padding: 0 var(--space-4);
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    color: var(--text-secondary);
    font: inherit;
  }
  .folder-focus-chip:hover {
    background: var(--surface-hover);
  }
  .folder-focus-chip span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .folder-focus-chip:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .search-message {
    position: absolute;
    z-index: var(--z-panel);
    top: calc(100% + var(--space-3));
    left: var(--space-5);
    display: flex;
    width: max-content;
    max-width: calc(100% - var(--space-10));
    min-height: 23px;
    box-sizing: border-box;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-7);
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    box-shadow: var(--shadow-overlay);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    white-space: nowrap;
  }

  .semantic-suggestion {
    display: flex;
    width: max-content;
    min-height: 23px;
    box-sizing: border-box;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-7);
    overflow: hidden;
    border: 1px solid var(--semantic-tab-border);
    border-top: 0;
    border-radius: 0 0 var(--radius-sm) var(--radius-sm);
    background: var(--semantic-tab-background);
    color: var(--semantic-tab-text);
    font-size: 10px;
    white-space: nowrap;
    animation: semantic-suggestion-slide-down var(--duration-fast) ease-out both;
  }

  .semantic-suggestion :global(svg) {
    flex: none;
    color: var(--semantic-tab-text);
  }

  .semantic-suggestion a {
    color: var(--semantic-tab-link);
    text-decoration: underline;
  }

  .semantic-suggestion a:hover {
    color: var(--semantic-tab-link-hover);
  }

  .semantic-suggestion a:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  @keyframes semantic-suggestion-slide-down {
    from {
      opacity: 0;
      transform: translateY(calc(-1 * var(--space-4)));
    }

    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .search-error :global(svg) {
    flex: none;
    color: var(--danger);
  }

  .search-info :global(svg) {
    flex: none;
    color: var(--text-secondary);
  }

  .search-message span {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Stacked, not appended: the strip is a single nowrap line, so a hint tacked onto the message
     would push the error itself into the ellipsis. */
  .search-message-body {
    display: grid;
    min-width: 0;
    gap: var(--space-1);
  }

  .search-message-hint {
    color: var(--text-tertiary);
    font-size: var(--font-size-sm);
    /* `nowrap` on the strip would collapse the gaps between notes; `pre` keeps them and still
       holds the hint to one line. */
    white-space: pre;
  }

  .scope-control {
    position: relative;
    flex: none;
  }

  /* The menu and the semantic tab share one stacking container, so the tab follows an open menu
     rather than covering it. */
  .scope-popovers {
    position: absolute;
    z-index: var(--z-popover);
    top: calc(100% + var(--space-1));
    left: calc(-1 * var(--space-4));
    display: grid;
    justify-items: start;
  }

  .scope-button,
  .clear-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .photo-reference-chip {
    border-color: var(--accent);
    background: var(--surface-hover);
    color: var(--text-primary);
  }

  .photo-reference-chip[aria-expanded="true"] {
    border-color: var(--accent-active);
    color: var(--text-primary);
  }

  .compose-chip-row {
    display: flex;
    height: 29px;
    align-items: end;
    padding-left: var(--space-5);
  }

  .compose-chip {
    z-index: var(--z-panel);
    display: inline-flex;
    height: 23px;
    align-items: center;
    gap: var(--space-3);
    padding: 0 var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--font-size-sm);
    white-space: nowrap;
  }

  .compose-chip:hover,
  .compose-chip[aria-expanded="true"] {
    border-color: var(--accent);
    color: var(--text-primary);
  }

  .scope-button {
    gap: var(--space-3);
    height: 24px;
    padding: 0 var(--space-5);
    font: inherit;
    font-size: 12px;
  }

  .scope-button:hover,
  .clear-button:hover {
    border-color: var(--border);
    color: var(--text-primary);
  }

  /* A Win32 popup menu: flat white field, hairline border, single-line rows, a check gutter on
     the left and the typed prefix in the accelerator column on the right. */
  .scope-menu {
    display: grid;
    min-width: 216px;
    padding: var(--space-2);
    border: 1px solid var(--border);
    background: var(--surface-0);
    box-shadow: var(--shadow-overlay);
  }

  .scope-menu button {
    display: flex;
    height: 22px;
    align-items: center;
    gap: var(--space-6);
    width: 100%;
    padding: 0 var(--space-6) 0 var(--space-2);
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-primary);
    font: inherit;
    font-size: 12px;
    text-align: left;
    /* Menus keep the arrow cursor on Windows — the hand is a web convention. */
    cursor: default;
  }

  .scope-menu-mark {
    display: inline-flex;
    flex: none;
    width: 13px;
    justify-content: center;
    color: var(--accent-active);
  }

  .scope-menu :global(.scope-menu-icon) {
    flex: none;
    color: var(--text-secondary);
  }

  .scope-menu button:disabled :global(.scope-menu-icon) {
    color: var(--text-tertiary);
  }

  .scope-menu-label {
    flex: 1;
    white-space: nowrap;
  }

  .scope-menu-prefix {
    flex: none;
    color: var(--text-tertiary);
    font-size: var(--font-size-sm);
  }

  .scope-menu-separator {
    height: 1px;
    margin: var(--space-2) var(--space-2) var(--space-2) 32px;
    background: var(--border-subtle);
  }

  .scope-menu-heading {
    padding: var(--space-2) var(--space-6) var(--space-1) 32px;
    color: var(--text-tertiary);
    font-size: var(--font-size-sm);
  }

  .scope-menu button:hover:not(:disabled) {
    border-color: var(--btn-border-hover);
    background: var(--surface-hover);
  }

  .scope-menu button:disabled {
    color: var(--text-tertiary);
  }

  .input-wrap {
    flex: 1;
    min-width: 0;
    height: 30px;
    position: relative;
  }

  .search-hint-accessible {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .input-wrap > .input-backdrop,
  .input-wrap > input {
    box-sizing: border-box;
    width: 100%;
    height: 30px;
    padding: 0;
    border-width: 0;
    font: inherit;
    font-size: 13px;
    letter-spacing: normal;
    line-height: 30px;
  }

  .input-backdrop {
    position: absolute;
    inset: 0;
    overflow: hidden;
    color: var(--text-primary);
    white-space: pre;
    pointer-events: none;
  }

  .input-backdrop::after {
    content: attr(data-hint);
    color: var(--text-tertiary);
  }

  input {
    position: relative;
    border: none;
    outline: none;
    background: transparent;
    color: transparent;
    caret-color: var(--text-primary);
  }

  input::placeholder {
    color: var(--text-tertiary);
  }

  .token {
    border-radius: var(--radius-sm);
    background: var(--surface-hover);
    color: var(--accent-active);
  }

  .token-invalid {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--danger);
  }

  .clear-button {
    flex: none;
    width: 18px;
    height: 18px;
    padding: 0;
  }

  .scope-button:focus-visible,
  .compose-chip:focus-visible,
  .scope-menu button:focus-visible,
  .clear-button:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
</style>
