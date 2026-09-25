<script lang="ts">
  import searchMenuGuide from "../assets/guide/search-menu.png";
  import visualSearchGuide from "../assets/guide/visual-search.png";

  let { onclose, onadd }: { onclose: () => void; onadd: () => void } = $props();
</script>

<div class="welcome-splash">
  <h1 id="welcome-splash-title">Welcome to Nicegal</h1>
  <p id="welcome-splash-description">
    Browse photo and video folders and find files by name, text, or appearance.
  </p>
  <ol class="themed-scrollbar">
    <li>
      <strong>Add a folder</strong>
      <span
        >Choose <b>Add a folder</b> below, or in <b>Libraries</b>. Your files stay where they are.</span
      >
      <span
        >Visual search is set up automatically. The first run downloads a search model; your files
        stay on your computer.</span
      >
      <span>For words inside pictures, enable <b>text recognition</b> in Libraries.</span>
    </li>
    <li>
      <strong>Choose what to search</strong>
      <div class="welcome-search-menu">
        <img
          src={searchMenuGuide}
          width="216"
          height="125"
          alt="Search menu with All, Visual search, and File name above Exact text and Related text"
        />
        <div>
          <p>Use the search menu, or type a prefix:</p>
          <ul class="search-types">
            <li>
              <b>Visual search</b> (<code>like:</code>) — Describe a photo or video or use an image
              example.
            </li>
            <li>
              <b>Exact text</b> (<code>ocr:</code>) — Find words inside pictures.
            </li>
            <li>
              <b>Related text</b> (<code>meaning:</code>) — Find similar wording or meaning.
            </li>
          </ul>
          <p>
            <b>All</b> combines available searches; <b>File name</b> searches names only. Exact and related
            text need text recognition.
          </p>
          <p>
            <b>Relevance</b> groups results; <b>Date</b> puts them on a timeline.
            <b>Visual similarity</b> narrows visual matches. Try <code>during:2020-12</code>
            to limit a search to a month.
          </p>
        </div>
      </div>
    </li>
    <li>
      <strong>Build a visual search</strong>
      <span
        >Right-click a file: <b>Find similar images</b> starts a search;
        <b>Add to visual search</b> adds another example.</span
      >
      <figure>
        <img
          src={visualSearchGuide}
          width="320"
          height="66"
          alt="Visual search composer with sunset weighted 2.00 and crowds weighted −1.00"
        />
        <figcaption>
          <b>Compose visual search</b> mixes descriptions and images. Adjust weights for more or less
          of each. Results update as you edit.
        </figcaption>
      </figure>
    </li>
  </ol>
  <div class="welcome-splash-actions">
    <span>Reopen this guide from <b>Settings → Getting started</b>.</span>
    <button class="ui-button ui-button-compact" type="button" onclick={onclose}>Close</button>
    <button class="ui-button ui-button-compact ui-button-primary" type="button" onclick={onadd}
      >Add a folder</button
    >
  </div>
</div>

<style>
  .welcome-splash {
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - var(--space-16) * 2);
    width: 100%;
    box-sizing: border-box;
    padding: var(--space-16);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--surface-0);
    box-shadow: var(--shadow-overlay);
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
