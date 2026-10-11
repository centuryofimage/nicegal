<script lang="ts">
  import type { AssetMetadata } from "../../../shared/backend";
  import type { GalleryItem } from "../lib/gallery/types";
  import type { VectorMatch } from "../lib/ocr-search.svelte";

  import { m } from "../../../shared/paraglide/messages.js";
  import { getLocale } from "../../../shared/paraglide/runtime.js";
  import { errorMessage } from "../lib/errors";
  import { loadImageTags, type ImageTag, type ImageTags } from "../lib/image-tags";
  import { formatBytes } from "../lib/job-format";
  import { settings } from "../lib/settings.svelte";
  import TechnicalDetails from "./TechnicalDetails.svelte";

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

  // An await block discards an older result when selection or catalog snapshot changes.
  const request = $derived.by((): Promise<AssetMetadata> | null => {
    return ready && asset ? window.nicegal.backend.getAssetMetadata(asset.id) : null;
  });
  const tagsRequest = $derived.by((): Promise<ImageTags> | null => {
    return ready && asset ? loadImageTags(asset.id, $settings.hideOffensiveTags) : null;
  });
  type SourceState = AssetMetadata["file"]["sourceState"];
  type TagGroupId = "simple" | "subjects" | "vibes";

  const tagGroupLabels: Record<TagGroupId, () => string> = {
    simple: () => m.metadata_panel_tag_group_simple(),
    subjects: () => m.metadata_panel_tag_group_subjects(),
    vibes: () => m.metadata_panel_tag_group_vibes(),
  };

  function fixed(value: number, digits: number): string {
    return value.toLocaleString(getLocale(), {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }
  function byteCount(size: AssetMetadata["asset"]["sourceSize"]): string {
    return BigInt(size).toLocaleString(getLocale());
  }
  function tagTitle(tag: ImageTag): string {
    const score = fixed(tag.score, 3);
    const similarity = fixed(tag.similarity, 3);
    return tag.sensitivity === "ok"
      ? m.metadata_panel_tag_title({ score, similarity, source: tag.source })
      : m.metadata_panel_tag_title_rated({
          score,
          similarity,
          source: tag.source,
          sensitivity: tag.sensitivity,
        });
  }
  function date(value: string | null): string {
    if (value === null) return m.metadata_panel_unknown();
    const timestamp = new Date(Number(BigInt(value) / 1_000_000n));
    return Number.isNaN(timestamp.getTime())
      ? m.metadata_panel_unknown()
      : timestamp.toLocaleString(getLocale());
  }
  function seconds(ms: number): string {
    return m.metadata_panel_seconds({ seconds: fixed(ms / 1000, 1) });
  }
  function sourceNotice(state: SourceState): string {
    if (state === "changed") return m.metadata_panel_source_changed();
    if (state === "missing") return m.metadata_panel_source_missing();
    return m.metadata_panel_source_unreadable();
  }
  function tagGroups(tags: ImageTags): { id: TagGroupId; list: ImageTag[] }[] {
    return [
      { id: "simple", list: tags.simple },
      { id: "subjects", list: tags.subjects },
      { id: "vibes", list: tags.vibes },
    ];
  }
</script>

<aside id="metadata-panel" class="metadata-panel" aria-labelledby="metadata-heading">
  <header>
    <h2 id="metadata-heading">{m.metadata_panel_heading()}</h2>
    <button class="ui-button" aria-label={m.metadata_panel_close_label()} onclick={onclose}
      >{m.common_close()}</button
    >
  </header>
  <div class="metadata-body">
    {#if !ready}
      <p role="status">{m.metadata_panel_unavailable()}</p>
    {:else if !request}
      <p>
        {selectedCount > 1
          ? m.metadata_panel_multi_selected({ count: selectedCount })
          : m.metadata_panel_select_one()}
      </p>
    {:else}
      {#await request}
        <p role="status">{m.metadata_panel_loading()}</p>
      {:then info}
        <h3 class="filename">{info.asset.displayName}</h3>
        {#if info.file.sourceState !== "current"}
          <p role="status">{sourceNotice(info.file.sourceState)}</p>
        {/if}
        <dl>
          <dt>{m.metadata_panel_location()}</dt>
          <dd>{info.hostPath ?? info.asset.path}</dd>
          <dt>{m.metadata_panel_format()}</dt>
          <dd>{info.asset.mediaFormat.toUpperCase()}</dd>
          <dt>{m.metadata_panel_size()}</dt>
          <dd title={m.metadata_panel_size_title({ bytes: byteCount(info.asset.sourceSize) })}>
            {formatBytes(Number(info.asset.sourceSize))}
            {m.metadata_panel_size_bytes({ bytes: byteCount(info.asset.sourceSize) })}
          </dd>
          <dt>{m.metadata_panel_dimensions()}</dt>
          <dd>
            {info.asset.width && info.asset.height
              ? m.metadata_panel_dimensions_value({
                  width: info.asset.width,
                  height: info.asset.height,
                })
              : m.metadata_panel_unknown()}
          </dd>
          {#if info.asset.mediaKind === "video"}
            <dt>{m.metadata_panel_duration()}</dt>
            <dd>
              {info.asset.durationMs === null
                ? m.metadata_panel_unknown()
                : seconds(info.asset.durationMs)}
            </dd>
          {/if}
          <dt>{m.metadata_panel_created()}</dt>
          <dd>{date(info.asset.createdNs)}</dd>
          <dt>{m.metadata_panel_modified()}</dt>
          <dd>{date(info.asset.modifiedNs)}</dd>
          <dt>{m.metadata_panel_captured()}</dt>
          <dd>{date(info.asset.captureNs)}</dd>
          {#if info.asset.animated}<dt>{m.metadata_panel_animation()}</dt>
            <dd>
              {info.asset.frameCount === null
                ? m.metadata_panel_unknown()
                : m.metadata_panel_frames({
                    frames: info.asset.frameCount,
                  })}{#if info.asset.durationMs !== null}{m.common_separator()}{seconds(
                  info.asset.durationMs,
                )}{/if}
            </dd>{/if}
          <dt>{m.metadata_panel_attributes()}</dt>
          <dd>
            {["missing", "unavailable"].includes(info.file.sourceState)
              ? m.metadata_panel_unavailable_value()
              : info.file.attributes.join(", ") || m.metadata_panel_none()}
          </dd>
        </dl>
        {#if info.asset.mediaKind === "video"}
          <h3>{m.metadata_panel_video_heading()}</h3>
          {#if info.file.video.length}
            <dl>
              {#each info.file.video as field (field.label)}
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
              {/each}
            </dl>
          {:else}
            <p>{m.metadata_panel_video_unavailable()}</p>
          {/if}
        {/if}
        {#if vectorMatch}
          <h3>{m.metadata_panel_current_search_heading()}</h3>
          <dl>
            <dt>
              {vectorMatch.kind === "visual"
                ? m.metadata_panel_visual_match()
                : m.metadata_panel_text_match()}
            </dt>
            <dd class="match-value" title={String(vectorMatch.similarity)}>
              {vectorMatch.similarity}
            </dd>
          </dl>
        {/if}
        {#if info.asset.mediaKind === "image"}
          <h3>{m.metadata_panel_recognized_text_heading()}</h3>
          {#if info.ocrText?.trim()}
            <textarea
              class="ocr-text"
              aria-label={m.metadata_panel_recognized_text_heading()}
              readonly
              spellcheck={false}
              value={info.ocrText}></textarea>
          {:else if info.ocrState === "indexed"}
            <p>{m.metadata_panel_no_text_found()}</p>
          {:else}
            <p>{m.metadata_panel_enable_text_recognition()}</p>
          {/if}
        {/if}
        {#if info.decodeFailed}<p>{m.metadata_panel_decode_failed()}</p>{/if}
        {#if info.asset.mediaKind === "image" && info.file.exif.length}
          <h3>{m.metadata_panel_exif_heading()}</h3>
          <dl>
            {#each info.file.exif as field (field.label)}<dt>{field.label}</dt>
              <dd>{field.value}</dd>{/each}
          </dl>
        {/if}
        {#if info.file.error}
          <p>{m.metadata_panel_metadata_read_error()}</p>
          <TechnicalDetails text={info.file.error} />
        {/if}
        <h3>{m.metadata_panel_tags_heading()}</h3>
        <p>{m.metadata_panel_tags_disclaimer()}</p>
        {#if tagsRequest}
          {#await tagsRequest}
            <p role="status">{m.metadata_panel_tags_loading()}</p>
          {:then tags}
            {#if !tags.supported}
              <p>{m.metadata_panel_tags_unsupported()}</p>
            {:else}
              <dl>
                {#each tagGroups(tags) as { id, list } (id)}
                  <dt>{tagGroupLabels[id]()}</dt>
                  <dd class="tag-list">
                    {#each list as tag (tag.term)}
                      <span class="tag" title={tagTitle(tag)}>{tag.term}</span>
                    {:else}
                      {m.metadata_panel_none()}
                    {/each}
                  </dd>
                {/each}
              </dl>
            {/if}
          {:catch error}
            <p>{errorMessage(error)}</p>
          {/await}
        {/if}
        {#if import.meta.env.DEV}
          <h3>Search indexing (debug)</h3>
          <dl>
            {#if info.asset.mediaKind === "image"}
              <dt>OCR</dt>
              <dd>
                {{ indexed: "Ready", stale: "Needs update", notIndexed: "Not prepared" }[
                  info.ocrState
                ]}
              </dd>
              <dt>Related text</dt>
              <dd>
                {{
                  embedded: "Ready",
                  noText: "No text found",
                  pending: "Pending",
                  notIndexed: "Needs text recognition",
                }[info.textState]}
              </dd>
            {/if}
            <dt>Image search</dt>
            <dd>{info.imageIndexed ? "Ready" : "Not prepared"}</dd>
          </dl>
        {/if}
      {:catch error}
        <p role="alert">{m.metadata_panel_load_error()}</p>
        <TechnicalDetails text={errorMessage(error)} />
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
