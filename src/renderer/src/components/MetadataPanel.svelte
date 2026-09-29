<script lang="ts">
  import type { AssetMetadata } from "../../../shared/backend";
  import type { GalleryItem } from "../lib/gallery/types";
  import type { VectorMatch } from "../lib/ocr-search.svelte";

  import { cleanDiagnostic, errorMessage } from "../lib/errors";
  import { loadImageTags, type ImageTag, type ImageTags } from "../lib/image-tags";
  import { formatBytes } from "../lib/job-format";
  import { settings } from "../lib/settings.svelte";

  let {
    asset,
    vectorMatch = null,
    selectedCount,
    ready,
    onclose,
  }: {
    asset: GalleryItem | null;
    /** The asset's cosine similarity to the current search, when a vector lane matched it. */
    vectorMatch?: VectorMatch | null;
    selectedCount: number;
    ready: boolean;
    onclose: () => void;
  } = $props();

  let retry = $state(0);
  let copiedText = $state<string | null>(null);
  // An await block discards an older result when selection, catalog snapshot or retry changes.
  const request = $derived.by((): Promise<AssetMetadata> | null => {
    void retry; // Explicit refresh also reloads an unchanged selection.
    return ready && asset ? window.nicegal.backend.getAssetMetadata(asset.id) : null;
  });
  const tagsRequest = $derived.by((): Promise<ImageTags> | null => {
    void retry;
    return ready && asset ? loadImageTags(asset.id, $settings.hideOffensiveTags) : null;
  });
  function tagTitle(tag: ImageTag): string {
    const rating = tag.sensitivity === "ok" ? "" : ` · ${tag.sensitivity}`;
    return `Score ${tag.score.toFixed(3)} · cosine ${tag.similarity.toFixed(3)} · ${tag.source}${rating}`;
  }
  function date(value: string | null): string {
    if (value === null) return "Unknown";
    const timestamp = new Date(Number(BigInt(value) / 1_000_000n));
    return Number.isNaN(timestamp.getTime()) ? "Unknown" : timestamp.toLocaleString();
  }
  async function copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      copiedText = value;
    } catch {
      copiedText = null;
    }
  }
</script>

<aside id="metadata-panel" class="metadata-panel" aria-labelledby="metadata-heading">
  <header>
    <h2 id="metadata-heading">Info</h2>
    <button
      class="ui-button"
      onclick={() => {
        copiedText = null;
        retry += 1;
      }}
      disabled={!ready || !asset}>Refresh</button
    >
    <button class="ui-button" aria-label="Close info" onclick={onclose}>Close</button>
  </header>
  <div class="metadata-body">
    {#if !ready}
      <p role="status">The gallery service is unavailable.</p>
    {:else if !request}
      <p>
        {selectedCount > 1
          ? `${selectedCount} files selected. Select one to see its details.`
          : "Select a file to see its details."}
      </p>
    {:else}
      {#await request}
        <p role="status">Loading details…</p>
      {:then info}
        <h3 class="filename">{info.asset.displayName}</h3>
        {#if info.file.sourceState !== "current"}
          <p role="status">
            {info.file.sourceState === "changed"
              ? "This file has changed. Update the library to refresh its catalog details."
              : info.file.sourceState === "missing"
                ? "This file is missing. Showing saved catalog details."
                : "Couldn't read this file. Showing saved catalog details."}
          </p>
        {/if}
        <dl>
          <dt>Location</dt>
          <dd>{info.asset.path}</dd>
          <dt>Format</dt>
          <dd>{info.asset.mediaFormat.toUpperCase()}</dd>
          <dt>Size</dt>
          <dd title={`${info.asset.sourceSize} bytes`}>
            {formatBytes(Number(info.asset.sourceSize))} ({BigInt(
              info.asset.sourceSize,
            ).toLocaleString()} bytes)
          </dd>
          <dt>Dimensions</dt>
          <dd>
            {info.asset.width && info.asset.height
              ? `${info.asset.width} × ${info.asset.height}`
              : "Unknown"}
          </dd>
          {#if info.asset.mediaKind === "video"}
            <dt>Duration</dt>
            <dd>
              {info.asset.durationMs === null
                ? "Unknown"
                : `${(info.asset.durationMs / 1000).toFixed(1)} s`}
            </dd>
          {/if}
          <dt>Created</dt>
          <dd>{date(info.asset.createdNs)}</dd>
          <dt>Modified</dt>
          <dd>{date(info.asset.modifiedNs)}</dd>
          <dt>Captured</dt>
          <dd>{date(info.asset.captureNs)}</dd>
          {#if info.asset.animated}<dt>Animation</dt>
            <dd>
              {info.asset.frameCount ?? "Unknown"} frames{info.asset.durationMs !== null
                ? ` · ${info.asset.durationMs / 1000} s`
                : ""}
            </dd>{/if}
          <dt>Attributes</dt>
          <dd>
            {["missing", "unavailable"].includes(info.file.sourceState)
              ? "Unavailable"
              : info.file.attributes.join(", ") || "None"}
          </dd>
        </dl>
        {#if info.asset.mediaKind === "video"}
          <h3>Video</h3>
          {#if info.file.video.length}
            <dl>
              {#each info.file.video as field (field.label)}
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
              {/each}
            </dl>
          {:else}
            <p>Video metadata unavailable.</p>
          {/if}
        {/if}
        {#if vectorMatch}
          <h3>Current search</h3>
          <dl>
            <dt>{vectorMatch.kind === "visual" ? "Visual match" : "Text match"}</dt>
            <dd class="match-value" title={String(vectorMatch.similarity)}>
              {vectorMatch.similarity}
            </dd>
          </dl>
        {/if}
        <h3>Search availability</h3>
        <dl>
          {#if info.asset.mediaKind === "image"}
            <dt>Text recognition</dt>
            <dd>
              {{ indexed: "Ready", stale: "Needs update", notIndexed: "Not prepared" }[
                info.ocrState
              ]}
            </dd>
            <dt>Text meaning</dt>
            <dd>
              {{
                embedded: "Ready",
                noText: "No text found",
                pending: "Pending",
                notIndexed: "Needs text recognition",
              }[info.textState]}
            </dd>
          {/if}
          <dt>Visual search</dt>
          <dd>{info.imageIndexed ? "Ready" : "Not prepared"}</dd>
        </dl>
        {#if info.asset.mediaKind === "image"}
          <h3>Recognized text</h3>
          {#if info.ocrText?.trim()}
            <textarea
              class="ocr-text"
              aria-label="Recognized text"
              readonly
              spellcheck={false}
              value={info.ocrText}></textarea>
          {:else if info.ocrState === "indexed"}
            <p>No text found in this file.</p>
          {:else}
            <p>Enable text recognition in Library manager to read words in this file.</p>
          {/if}
        {/if}
        {#if info.decodeFailed}<p>
            The file could not be decoded during indexing. Use Library manager → Retry failed files
            after checking the file.
          </p>{/if}
        {#if info.asset.mediaKind === "image" && info.file.exif.length}
          <h3>Camera / EXIF</h3>
          <dl>
            {#each info.file.exif as field (field.label)}<dt>{field.label}</dt>
              <dd>{field.value}</dd>{/each}
          </dl>
        {/if}
        {#if info.file.error}
          <p>Some file metadata could not be read.</p>
          <details>
            <summary>Technical details</summary>
            <pre>{cleanDiagnostic(info.file.error)}</pre>
            <button
              class="ui-button"
              onclick={() => void copy(cleanDiagnostic(info.file.error ?? ""))}
              >{copiedText === cleanDiagnostic(info.file.error) ? "Copied" : "Copy details"}</button
            >
          </details>
        {/if}
        <h3>Tags</h3>
        <p>
          Tags come from a research model trained on unfiltered internet data. They are usually
          wrong and can reflect harmful biases.
        </p>
        {#if tagsRequest}
          {#await tagsRequest}
            <p role="status">Loading tags…</p>
          {:then tags}
            {#if !tags.supported}
              <p>Tags aren't available for this search model.</p>
            {:else}
              <dl>
                {#each [["Simple", tags.simple], ["Subjects", tags.subjects], ["Vibes", tags.vibes]] as const as [label, list] (label)}
                  <dt>{label}</dt>
                  <dd class="tag-list">
                    {#each list as tag (tag.term)}
                      <span class="tag" title={tagTitle(tag)}>{tag.term}</span>
                    {:else}
                      None
                    {/each}
                  </dd>
                {/each}
              </dl>
            {/if}
          {:catch error}
            <p>{errorMessage(error)}</p>
          {/await}
        {/if}
      {:catch error}
        <p role="alert">Couldn't load file details. Refresh to try again.</p>
        <details>
          <summary>Technical details</summary>
          <pre>{errorMessage(error)}</pre>
          <button class="ui-button" onclick={() => void copy(errorMessage(error))}
            >{copiedText === errorMessage(error) ? "Copied" : "Copy details"}</button
          >
        </details>
      {/await}
    {/if}
  </div>
</aside>

<style>
  .metadata-panel {
    display: flex;
    flex-direction: column;
    flex: 0 0 var(--metadata-panel-width);
    min-width: 0;
    min-height: 0;
    border-left: 1px solid var(--border);
    background: var(--surface-1);
    color: var(--text-primary);
    font-size: var(--font-size-md);
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-8);
    border-bottom: 1px solid var(--border-subtle);
  }
  h2 {
    flex: 1;
    margin: 0;
    font-size: var(--font-size-md);
  }
  .metadata-body {
    min-height: 0;
    overflow: auto;
    padding: var(--space-8);
    overflow-wrap: anywhere;
    user-select: text;
  }
  h3 {
    margin: var(--space-12) 0 var(--space-6);
    font-size: var(--font-size-md);
    font-weight: var(--font-weight-semibold);
  }
  h3.filename {
    margin-top: 0;
  }
  p {
    margin: var(--space-6) 0;
    color: var(--text-secondary);
  }
  dl {
    display: grid;
    grid-template-columns: minmax(0, 85px) minmax(0, 1fr);
    gap: var(--space-6) var(--space-8);
    margin: 0;
  }
  dt {
    color: var(--text-secondary);
  }
  dd {
    margin: 0;
    min-width: 0;
  }
  /* Full precision, clipped to the pane rather than rounded. */
  .match-value {
    overflow: hidden;
    font-variant-numeric: tabular-nums;
    text-overflow: clip;
    white-space: nowrap;
  }
  .tag-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
  }
  .tag {
    padding: 0 var(--space-4);
    border: 1px solid var(--border-subtle);
    background: var(--surface-0);
  }
  pre {
    max-height: 180px;
    overflow: auto;
    white-space: pre-wrap;
    font-size: var(--font-size-sm);
  }
  textarea.ocr-text {
    box-sizing: border-box;
    width: 100%;
    min-height: 56px;
    max-height: 300px;
    margin: 0;
    padding: var(--space-6);
    resize: vertical;
    overflow-x: hidden;
    overflow-y: auto;
    border: 1px solid var(--border);
    background: var(--surface-0);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--font-size-sm);
    line-height: 1.4;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  @media (max-width: 600px) {
    .metadata-panel {
      position: absolute;
      top: 0;
      bottom: 0;
      right: 0;
      width: min(var(--metadata-panel-width), 100%);
      z-index: var(--z-popover);
      box-shadow: var(--shadow-overlay);
    }
  }
</style>
