<script lang="ts">
  import type { Snippet } from "svelte";

  import { ParaglideMessage } from "@inlang/paraglide-js-svelte";

  import { m } from "../../../shared/paraglide/messages.js";
  import searchMenuGuide from "../assets/guide/search-menu.png";
  import visualSearchGuide from "../assets/guide/visual-search.png";

  let { onclose, onadd }: { onclose: () => void; onadd: () => void } = $props();
</script>

{#snippet b({ children }: { children?: Snippet })}<b>{@render children?.()}</b>{/snippet}
{#snippet code({ children }: { children?: Snippet })}<code>{@render children?.()}</code>{/snippet}

<div class="dialog-shell welcome-splash">
  <h1 id="welcome-splash-title">{m.getting_started_title()}</h1>
  <p id="welcome-splash-description">{m.getting_started_description()}</p>
  <ol class="themed-scrollbar">
    <li>
      <strong>{m.getting_started_add_folder()}</strong>
      <span>
        <ParaglideMessage message={m.getting_started_add_folder_instructions} inputs={{}} {b} />
      </span>
      <span>{m.getting_started_visual_search_setup()}</span>
      <span>
        <ParaglideMessage message={m.getting_started_larger_models} inputs={{}} {b} />
      </span>
      <span>
        <ParaglideMessage message={m.getting_started_text_recognition_tip} inputs={{}} {b} />
      </span>
    </li>
    <li>
      <strong>{m.getting_started_choose_what_to_search()}</strong>
      <div class="welcome-search-menu">
        <img
          src={searchMenuGuide}
          width="216"
          height="125"
          alt={m.getting_started_search_menu_image_alt()}
        />
        <div>
          <p>{m.getting_started_search_menu_intro()}</p>
          <ul class="search-types">
            <li>
              <ParaglideMessage
                message={m.getting_started_search_type_visual}
                inputs={{}}
                {b}
                {code}
              />
            </li>
            <li>
              <ParaglideMessage
                message={m.getting_started_search_type_exact}
                inputs={{}}
                {b}
                {code}
              />
            </li>
            <li>
              <ParaglideMessage
                message={m.getting_started_search_type_related}
                inputs={{}}
                {b}
                {code}
              />
            </li>
          </ul>
          <p>
            <ParaglideMessage message={m.getting_started_search_menu_options} inputs={{}} {b} />
          </p>
          <p>
            <ParaglideMessage
              message={m.getting_started_sort_and_filter_help}
              inputs={{}}
              {b}
              {code}
            />
          </p>
        </div>
      </div>
    </li>
    <li>
      <strong>{m.getting_started_build_visual_search()}</strong>
      <span>
        <ParaglideMessage message={m.getting_started_visual_search_steps} inputs={{}} {b} />
      </span>
      <figure>
        <img
          src={visualSearchGuide}
          width="320"
          height="66"
          alt={m.getting_started_visual_search_image_alt()}
        />
        <figcaption>
          <ParaglideMessage message={m.getting_started_compose_caption} inputs={{}} {b} />
        </figcaption>
      </figure>
    </li>
  </ol>
  <div class="welcome-splash-actions">
    <span>
      <ParaglideMessage message={m.getting_started_reopen_hint} inputs={{}} {b} />
    </span>
    <button class="ui-button ui-button-compact" type="button" onclick={onclose}>
      {m.common_close()}
    </button>
    <button class="ui-button ui-button-compact ui-button-primary" type="button" onclick={onadd}>
      {m.getting_started_add_folder()}
    </button>
  </div>
</div>

<style>
  .welcome-splash {
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - var(--space-16) * 2);
    padding: var(--space-16);
    border-radius: var(--radius-md);
  }
  .welcome-splash h1 {
    margin: 0;
    color: var(--text-primary);
    font-size: var(--dialog-title-size);
    font-weight: var(--font-weight-semibold);
  }
  .welcome-splash > p {
    margin: var(--space-8) 0 var(--space-14);
    color: var(--text-secondary);
    font-size: var(--font-size-md);
    line-height: var(--line-height-normal);
  }
  .welcome-splash ol {
    display: grid;
    gap: var(--space-14);
    min-height: 0;
    overflow: auto;
    padding-right: var(--space-4);
    margin: 0;
    padding: 0;
    list-style: none;
    counter-reset: welcome-step;
  }
  .welcome-splash ol > li {
    display: grid;
    grid-template-columns: 20px 1fr;
    column-gap: var(--space-7);
    color: var(--text-secondary);
    font-size: var(--font-size-md);
    counter-increment: welcome-step;
  }
  .welcome-splash ol > li::before {
    display: grid;
    width: 18px;
    height: 18px;
    place-items: center;
    border: 1px solid var(--border);
    border-radius: 50%;
    color: var(--accent-active);
    content: counter(welcome-step);
    font-size: var(--font-size-sm);
  }
  .welcome-splash ol > li > strong,
  .welcome-splash ol > li > span {
    grid-column: 2;
  }
  .welcome-splash ol > li > strong {
    color: var(--text-primary);
    font-weight: var(--font-weight-semibold);
  }
  .welcome-splash ol > li > span {
    margin-top: var(--space-4);
  }
  .welcome-splash li {
    line-height: var(--line-height-normal);
  }
  .welcome-splash h1,
  .welcome-splash > p,
  .welcome-splash-actions {
    flex: none;
  }
  .welcome-search-menu {
    grid-column: 2;
    margin-top: var(--space-6);
  }
  .welcome-search-menu p {
    margin: 0;
  }
  .search-types {
    margin: var(--space-6) 0;
    padding-left: var(--space-16);
    list-style: disc;
  }
  .search-types li + li {
    margin-top: var(--space-4);
  }
  .welcome-splash img {
    display: block;
    max-width: 100%;
    height: auto;
    object-fit: contain;
  }
  .welcome-search-menu img {
    width: 216px;
    float: right;
    margin: 0 0 var(--space-6) var(--space-12);
  }
  .welcome-splash figure {
    grid-column: 2;
    margin: var(--space-8) 0 var(--space-4);
  }
  .welcome-splash figcaption {
    margin-top: var(--space-6);
  }
  .welcome-splash code {
    color: var(--text-primary);
    font-size: inherit;
  }
  .welcome-splash b {
    font-weight: var(--font-weight-semibold);
  }
  .welcome-splash-actions > span {
    margin-right: auto;
    align-self: center;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  @media (max-width: 560px) {
    .welcome-search-menu img {
      width: min(216px, 50%);
    }
    .welcome-splash-actions {
      flex-wrap: wrap;
    }
    .welcome-splash-actions > span {
      width: 100%;
    }
  }
  .welcome-splash-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-6);
    margin-top: var(--space-16);
  }
</style>
