<!--
  @component
  The search options strip: one row under the toolbar, present only while a search that can be
  ranked is running.

      Sort: [Date | Relevance]   Match quality: ▓▓▓▓▓▓░░░░░░   84 matches

  Relevance groups All results by source. Date combines them into one timeline and exposes the
  CLIP-only slider. Related text in All has its own fixed cutoff, not controlled by this slider.
-->
<script lang="ts">
  import { m } from "../../../shared/paraglide/messages.js";
  import { MATCH_QUALITY_STEP, type SearchSortMode } from "../lib/ocr-search.svelte";
  import SegmentedControl from "./SegmentedControl.svelte";

  let {
    sortMode = $bindable(),
    minMatchPercentile = $bindable(),
    showSlider,
    sliderDisabled,
    shownCount,
    matchTotal,
    truncated,
    sliderKind = "meaning",
    sections = [],
    onsection = () => {},
    notice = "",
  }: {
    sortMode: SearchSortMode;
    minMatchPercentile: number;
    /** Percentile cutoffs need a continuous score, so semantic searches in date sort get one. */
    showSlider: boolean;
    /** A result set with no score spread has no percentiles; the control says so by greying out. */
    sliderDisabled: boolean;
    shownCount: number;
    matchTotal: number;
    /** Whether ranked mode's top-N cutoff dropped anything, which changes what the count means. */
    truncated: boolean;
    /** Which scores the slider cuts; picks the label and the tooltip. */
    sliderKind?: "meaning" | "visual";
    sections?: readonly { key: string; label: string; count: number; status?: string }[];
    onsection?: (key: string) => void;
    notice?: string;
  } = $props();

  const sortOptions = [
    {
      value: "relevance",
      label: m.search_options_relevance(),
      title: m.search_options_relevance_tooltip(),
    },
    { value: "date", label: m.search_options_date(), title: m.search_options_date_tooltip() },
  ] as const satisfies ReadonlyArray<{ value: SearchSortMode; label: string; title: string }>;

  /** One tick per stop, with the ends and the midpoint drawn tall — the ruler's job here is to
   * show where the middle is, not to be read off as a number. */
  const ticks = Array.from({ length: 100 / MATCH_QUALITY_STEP + 1 }, (_, index) => {
    const at = index * MATCH_QUALITY_STEP;
    return { at, fraction: at / 100, major: at === 0 || at === 50 || at === 100 };
  });

  const countText = $derived(
    truncated
      ? m.search_options_count_truncated({
          shown: shownCount.toLocaleString(),
          total: matchTotal.toLocaleString(),
        })
      : m.search_options_count({ count: matchTotal }),
  );
  const sliderLabel = $derived(
    sliderKind === "visual"
      ? m.search_options_visual_similarity_label()
      : m.search_options_match_quality_label(),
  );
</script>

<div class="search-options">
  <span class="label" aria-hidden="true">{m.search_options_sort_label()}</span>
  <SegmentedControl
    bind:value={sortMode}
    options={sortOptions}
    label={m.search_options_sort_group_aria()}
  />

  {#if showSlider}
    <div class="cutoff" class:disabled={sliderDisabled}>
      <label class="label" for="min-match">{sliderLabel}</label>
      <div class="trackbar-wrap">
        <div class="ruler" aria-hidden="true">
          {#each ticks as tick (tick.at)}
            <span
              class={{ tick: true, major: tick.major }}
              style:left={`calc(${tick.fraction} * (100% - var(--thumb-width)) + var(--thumb-width) / 2)`}
            ></span>
          {/each}
        </div>
        <input
          id="min-match"
          class="ui-trackbar trackbar"
          type="range"
          min="0"
          max="100"
          step={MATCH_QUALITY_STEP}
          disabled={sliderDisabled}
          title={sliderDisabled
            ? m.search_options_slider_disabled_tooltip()
            : sliderKind === "visual"
              ? m.search_options_visual_slider_tooltip()
              : m.search_options_slider_tooltip()}
          bind:value={minMatchPercentile}
        />
      </div>
    </div>
  {/if}

  {#if sections.length}
    <nav class="search-sections" aria-label={m.search_options_sections_aria()}>
      {#each sections as section (section.key)}
        <button
          class="section-link"
          title={section.status ||
            m.search_options_section_jump_tooltip({ section: section.label })}
          onclick={() => onsection(section.key)}
          >{section.label} <span>{section.count.toLocaleString()}</span></button
        >
      {/each}
    </nav>
  {/if}

  <span class="count" role="status">{countText}</span>
  {#if notice}<span class="search-notice" role="status" title={notice}>{notice}</span>{/if}
</div>

<style>
  .search-notice {
    flex-basis: 100%;
    color: var(--text-secondary);
    overflow-wrap: anywhere;
  }
  .search-sections {
    display: flex;
    gap: var(--space-8);
    flex-wrap: wrap;
  }
  .section-link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--text-primary);
    font: inherit;
    cursor: pointer;
  }
  .section-link:hover {
    text-decoration: underline;
  }
  .section-link span {
    color: var(--text-secondary);
  }
  .search-options {
    --segment-height: var(--control-height);

    display: flex;
    flex-wrap: wrap;
    flex: none;
    align-items: center;
    gap: var(--space-8);
    padding: var(--space-4) var(--space-8);
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-1);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }

  .label {
    flex: none;
    white-space: nowrap;
  }

  .cutoff {
    display: flex;
    /* The strip's own gap is for unrelated controls; label and track are one control. */
    align-items: center;
    gap: var(--space-6);
    margin-left: var(--space-8);
  }

  .cutoff.disabled {
    color: var(--text-tertiary);
  }

  .count {
    flex: none;
    /* The count sits at the far right of the strip, opposite the controls it describes. */
    margin-left: auto;
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* A Win32 trackbar: a tick ruler over a sunken groove with a
     tall rectangular thumb. The ruler is shortened to fit a toolbar strip rather than dropped —
     the ticks are what show the control snaps, and where its middle is. */
  /* Flex centring would centre the ruler-plus-track stack, which drops the groove below the
     strip's centre line and out of step with every control beside it. Lifting the stack by half
     the ruler puts the groove itself on that line. */
  .trackbar-wrap {
    position: relative;
    margin-top: calc(var(--space-4) / -2);
  }

  .ruler {
    position: relative;
    height: var(--space-4);
  }

  .tick {
    position: absolute;
    bottom: 0;
    width: var(--space-1);
    height: var(--space-2);
    background: var(--tick-mark);
    transform: translateX(-0.5px);
  }

  .tick.major {
    height: var(--space-4);
    background: var(--tick-mark-major);
  }

  .cutoff.disabled .tick,
  .cutoff.disabled .tick.major {
    background: var(--border);
  }

  .trackbar {
    width: 140px;
  }

  .trackbar::-webkit-slider-runnable-track {
    margin-top: calc((var(--thumb-height) - var(--track-height)) / 2);
  }
</style>
