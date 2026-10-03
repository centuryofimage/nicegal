import { SvelteSet } from "svelte/reactivity";

export interface SelectionModifiers {
  toggle: boolean;
  extend: boolean;
}

type MarqueeSelection = {
  baseline: SvelteSet<string>;
  modifiers: SelectionModifiers;
};

/**
 * Owns gallery selection independently of rendered tiles, by asset ID, so selection survives
 * virtualization, relayouts, and filtering. The anchor is an id rather than an index because
 * result order changes.
 */
export class GallerySelection {
  readonly ids = new SvelteSet<string>();
  private anchorId = $state<string | null>(null);
  private marquee: MarqueeSelection | undefined;

  get count(): number {
    return this.ids.size;
  }

  select(id: string, visibleIds: readonly string[], modifiers: SelectionModifiers): void {
    const index = visibleIds.indexOf(id);
    if (index < 0) return;
    this.endMarquee();

    if (modifiers.extend && this.anchorId) {
      const anchorIndex = visibleIds.indexOf(this.anchorId);
      if (anchorIndex >= 0) {
        this.ids.clear();
        const start = Math.min(anchorIndex, index);
        const end = Math.max(anchorIndex, index);
        for (let current = start; current <= end; current += 1) this.ids.add(visibleIds[current]);
        return;
      }
    }

    if (modifiers.toggle) {
      if (this.ids.has(id)) this.ids.delete(id);
      else this.ids.add(id);
      this.anchorId = id;
      return;
    }

    this.ids.clear();
    this.ids.add(id);
    this.anchorId = id;
  }

  clear(): void {
    this.endMarquee();
    this.ids.clear();
    this.anchorId = null;
  }

  /**
   * Snapshots logical selection before a marquee begins.
   */
  beginMarquee(modifiers: SelectionModifiers): void {
    this.marquee = { baseline: new SvelteSet(this.ids), modifiers };
  }

  /**
   * Applies the current marquee hit set against the selection that existed when the drag began,
   * so shrinking the box during a drag restores what it had covered.
   */
  updateMarquee(ids: readonly string[], visibleIds: readonly string[]): void {
    const marquee = this.marquee;
    if (!marquee) return;

    const hitIds = new SvelteSet(ids);
    const nextIds = new SvelteSet(marquee.baseline);
    if (marquee.modifiers.toggle) {
      for (const id of hitIds) {
        if (nextIds.has(id)) nextIds.delete(id);
        else nextIds.add(id);
      }
    } else if (marquee.modifiers.extend) {
      for (const id of hitIds) nextIds.add(id);
    } else {
      nextIds.clear();
      for (const id of hitIds) nextIds.add(id);
    }

    this.ids.clear();
    for (const id of nextIds) this.ids.add(id);
    if (!marquee.modifiers.extend && !marquee.modifiers.toggle) {
      this.anchorId = [...visibleIds].reverse().find((id) => hitIds.has(id)) ?? null;
    }
  }

  endMarquee(): void {
    this.marquee = undefined;
  }

  /** Remove assets that disappeared from the catalog, without losing selections hidden by a filter. */
  retainCatalogAssets(items: readonly { id: string }[]): void {
    if (this.ids.size === 0 && !this.anchorId && !this.marquee) return;
    const currentIds = new SvelteSet(items.map((item) => item.id));
    if (this.marquee) {
      for (const id of this.marquee.baseline) {
        if (!currentIds.has(id)) this.marquee.baseline.delete(id);
      }
    }
    for (const id of this.ids) {
      if (!currentIds.has(id)) this.ids.delete(id);
    }
    if (this.anchorId && !currentIds.has(this.anchorId)) this.anchorId = null;
  }
}
