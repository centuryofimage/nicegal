<script lang="ts">
  import { onMount, untrack } from "svelte";

  import type { SearchResult } from "../../../shared/backend";

  import { useApplication } from "../lib/application.svelte";
  import { errorMessage } from "../lib/errors";
  import { physicalThumbnailSize, thumbnailUrlOf, type GalleryItem } from "../lib/gallery/types";
  import { parseQuery } from "../lib/search-query";

  let { onclose }: { onclose: () => void } = $props();
  const {
    services: { runtime, catalog, ocrSearch, jobs },
  } = useApplication();
  const models = $derived(
    runtime.imageModel?.models.filter((m) => m.available && m.supportsTextQueries) ?? [],
  );
  let query = $state(untrack(() => parseQuery(ocrSearch.query).body));
  let left = $state("");
  let right = $state("");
  const selectionValid = $derived(
    left !== right && models.some((m) => m.id === left) && models.some((m) => m.id === right),
  );

  /** Fills selections that are empty or ineligible for text queries (the active model may be image-only). */
  function pickDefaults(): void {
    const active = runtime.imageModel?.activeModel;
    if (!models.some((m) => m.id === left))
      left = models.find((m) => m.id === active)?.id ?? models[0]?.id ?? "";
    if (!models.some((m) => m.id === right) || right === left)
      right = models.find((m) => m.id !== left)?.id ?? "";
  }
  onMount(() => {
    pickDefaults();
    void runtime.refresh().then(pickDefaults);
  });
  type Column = {
    model: string;
    name: string;
    hits: (SearchResult & { item: GalleryItem })[];
    total: number;
    elapsed: number;
  };
  let columns = $state<Column[]>([]);
  let run = $state<"idle" | "running" | "stopping">("idle");
  const busy = $derived(run !== "idle");
  const stopping = $derived(run === "stopping");
  let status = $state("");
  let error = $state<string | null>(null);
  const overlap = $derived(
    columns.length === 2
      ? columns[0].hits.filter((a) => columns[1].hits.some((b) => b.assetId === a.assetId)).length
      : null,
  );

  export function requestClose(): void {
    if (busy) run = "stopping";
    else onclose();
  }

  async function switchModel(model: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await jobs.sync();
      await runtime.setImageModel(model);
      if (!runtime.imageModelError && runtime.imageModel?.activeModel === model) return;
      // A queued scan may start between the runtime's cancellation check and the switch.
      // Refresh it so the next attempt can stop it through the normal settings flow.
      await jobs.sync();
      if (!jobs.running) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      runtime.imageModelError ??
        "Could not activate the model. Check for a launch-time model override.",
    );
  }

  async function compare(): Promise<void> {
    const libraryId = catalog.selectedId;
    const original = runtime.imageModel?.activeModel;
    if (busy || libraryId === null || !original || !query.trim()) return;
    const text = query.trim();
    const folder = parseQuery(ocrSearch.query).folder;
    const items = new Map(catalog.items.map((item) => [item.id, item]));
    const choices = [left, right].map((id) => ({
      id,
      name: models.find((m) => m.id === id)?.name ?? id,
    }));
    run = "running";
    error = null;
    columns = [];
    try {
      for (const choice of choices) {
        if (stopping) break;
        status = `Loading ${choice.name}…`;
        if (runtime.imageModel?.activeModel !== choice.id) await switchModel(choice.id);
        if (stopping) break;
        status = `Searching ${choice.name}…`;
        const start = performance.now();
        const result = await window.nicegal.backend.searchOcr({
          query: text,
          type: "image",
          libraryId,
          folder: folder ?? undefined,
          limit: 10,
        });
        const hits = result.results.flatMap((hit) => {
          const item = items.get(hit.assetId);
          return item ? [{ ...hit, item }] : [];
        });
        const elapsed = performance.now() - start;
        if (hits.length) {
          await window.nicegal.backend.ensureThumbnails({
            assetIds: [...new Set(hits.map((hit) => hit.assetId))],
            requiredSize: physicalThumbnailSize(180, 140, window.devicePixelRatio),
          });
        }
        columns = [
          ...columns,
          {
            model: choice.id,
            name: choice.name,
            total: result.total,
            elapsed,
            hits,
          },
        ];
      }
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      status = "Restoring original model…";
      if (runtime.imageModel?.activeModel !== original) {
        try {
          await switchModel(original);
        } catch (cause) {
          error = `${error ? error + "\n" : ""}Restoring model: ${errorMessage(cause)}`;
        }
      }
      status = stopping ? "Comparison stopped." : "";
      run = "idle";
    }
  }
</script>

<section class="comparison">
  <header>
    <h2 id="model-comparison-title">Compare image search models · dev</h2>
    <button class="ui-button" disabled={busy} onclick={onclose}>Close</button>
  </header>
  <p>
    Searches the current library and folder, using each model's existing index. Models run one at a
    time; the original model is restored afterward.
  </p>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void compare();
    }}
  >
    <label class="query"
      >Description<input
        aria-label="Comparison description"
        bind:value={query}
        disabled={busy}
      /></label
    >
    <div class="choices">
      <label
        >Left model<select bind:value={left} disabled={busy}
          >{#each models as model (model.id)}<option value={model.id}>{model.name}</option
            >{/each}</select
        ></label
      >
      <label
        >Right model<select bind:value={right} disabled={busy}
          >{#each models as model (model.id)}<option value={model.id}>{model.name}</option
            >{/each}</select
        ></label
      >
    </div>
    <div class="actions">
      <button
        class="ui-button"
        type="submit"
        disabled={busy ||
          !query.trim() ||
          !selectionValid ||
          catalog.selectedId === null ||
          runtime.saving ||
          runtime.imageModelSaving}>Compare top 10</button
      >
      {#if busy}<button
          class="ui-button"
          type="button"
          disabled={stopping}
          onclick={() => (run = "stopping")}>Stop after current step</button
        >{/if}
      <span role="status">{status}</span>
      {#if overlap !== null}<span>{overlap} shared results in the top 10</span>{/if}
    </div>
  </form>
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  <div class="results">
    {#each [0, 1] as side (side)}
      <section aria-label={side === 0 ? "Left model results" : "Right model results"}>
        {#if columns[side]}
          {@const column = columns[side]}
          <h3>{column.name}</h3>
          <p>
            {column.total} indexed matches · {Math.round(column.elapsed)} ms including query model load
          </p>
          {#if !column.hits.length}<p>
              No indexed results. Index this library with this model first.
            </p>{/if}
          <ol>
            {#each column.hits as hit (hit.assetId)}<li
                class:shared={columns.length === 2 &&
                  columns[1 - side].hits.some((other) => other.assetId === hit.assetId)}
              >
                <img
                  src={thumbnailUrlOf(hit.item, 180, 140, window.devicePixelRatio, hit.timestampMs)}
                  alt={hit.item.displayName}
                />
                <div>
                  <strong>{hit.rank ?? column.hits.indexOf(hit) + 1}. {hit.item.displayName}</strong
                  ><small
                    >{hit.distance === undefined
                      ? ""
                      : `Cosine ${(1 - hit.distance).toFixed(3)}`}</small
                  >
                </div>
              </li>{/each}
          </ol>
        {:else}<h3>{side === 0 ? "Left" : "Right"}</h3>
          <p>Results will appear here.</p>{/if}
      </section>
    {/each}
  </div>
  <p>
    Outlined images appear in both lists. Compare ranks and images; cosine scores can differ in
    scale between models.
  </p>
</section>

<style>
  .comparison {
    box-sizing: border-box;
    padding: var(--space-9);
    border: 1px solid var(--border-strong);
    background: var(--surface-0);
    box-shadow: var(--shadow-overlay);
    color: var(--text-primary);
  }
  header,
  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-8);
  }
  header {
    justify-content: space-between;
  }
  h2,
  h3 {
    margin: 0;
    font-size: var(--font-size-md);
  }
  p,
  small {
    color: var(--text-secondary);
  }
  p {
    line-height: var(--line-height-normal);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }
  input,
  select {
    width: 100%;
    min-width: 0;
  }
  .choices,
  .results {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--space-9);
  }
  .choices,
  .actions,
  .results {
    margin-top: var(--space-8);
  }
  .actions {
    flex-wrap: wrap;
  }
  .results > section {
    min-width: 0;
  }
  ol {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-7);
  }
  li {
    border: 1px solid var(--border-subtle);
    padding: var(--space-4);
    min-width: 0;
  }
  li.shared {
    border-color: var(--accent);
  }
  img {
    display: block;
    width: 100%;
    height: 140px;
    object-fit: contain;
    background: var(--surface-1);
  }
  strong,
  small {
    display: block;
    overflow-wrap: anywhere;
  }
  strong {
    margin-top: var(--space-4);
    font-size: var(--font-size-sm);
  }
  .error {
    color: var(--danger);
    white-space: pre-wrap;
  }
</style>
