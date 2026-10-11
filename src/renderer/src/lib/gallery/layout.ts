import { buildGridLayout } from "./grid-layout";
import { buildJustifiedLayout } from "./justified-layout";
import { buildMasonryLayout } from "./masonry-layout";
import { resolveLayoutOptions, type LayoutOptions } from "./options";
import {
  emptyLayout,
  type GalleryItem,
  type GalleryLayout,
  type LayoutMode,
  type GallerySection,
} from "./types";

export const layoutModes: readonly LayoutMode[] = ["justified", "masonry", "grid"];

/**
 * Single entry point for every layout mode. Packing is mode-specific; everything downstream
 * (virtualization, pooling, prefetch, timeline) consumes the shared `GalleryLayout` shape.
 */
export function buildLayout(
  items: GalleryItem[],
  viewportWidth: number,
  options: LayoutOptions = {},
  sections: readonly GallerySection[] = [],
  sectionHeaderHeight = 26,
  sectionGap = 6,
): GalleryLayout {
  const resolved = resolveLayoutOptions(options);
  if (viewportWidth && sections.length) {
    const result = emptyLayout(resolved.mode);
    result.height = sectionGap;
    for (const section of sections) {
      const headerY = result.height;
      // Packers include their own outer padding. Replace vertical padding with the compact
      // section gap, retaining horizontal padding so headings line up with thumbnail edges.
      const offset = headerY + sectionHeaderHeight + sectionGap - resolved.padding;
      result.dividers.push({
        key: section.key,
        itemIndex: section.start,
        y: headerY,
        height: sectionHeaderHeight,
        timestamp: 0,
        label: section.label,
        count: section.count,
        status: section.status,
        collapsed: section.collapsed,
      });
      const part = buildLayout(
        section.collapsed ? [] : items.slice(section.start, section.start + section.count),
        viewportWidth,
        { ...options, granularity: "none" },
      );
      // Retain the original item indices for selection and pooling. Append iteratively: spreading
      // a large library into push() exceeds JavaScript's function-argument limit.
      for (const position of part.positions)
        result.positions.push({
          ...position,
          index: position.index + section.start,
          y: position.y + offset,
        });
      for (const row of part.rows)
        result.rows.push({
          ...row,
          start: row.start + section.start,
          end: row.end + section.start,
          y: row.y + offset,
        });
      part.columns.forEach((column, index) => {
        const target = (result.columns[index] ??= { indices: [], tops: [], bottoms: [] });
        for (const itemIndex of column.indices) target.indices.push(itemIndex + section.start);
        for (const top of column.tops) target.tops.push(top + offset);
        for (const bottom of column.bottoms) target.bottoms.push(bottom + offset);
      });
      result.unitHeight = part.unitHeight || result.unitHeight;
      result.height =
        !section.collapsed && section.count
          ? offset + part.height - resolved.padding + sectionGap
          : headerY + sectionHeaderHeight + sectionGap;
    }
    return result;
  }
  if (!viewportWidth || !items.length) return emptyLayout(resolved.mode);

  switch (resolved.mode) {
    case "masonry":
      return buildMasonryLayout(items, viewportWidth, resolved);
    case "grid":
      return buildGridLayout(items, viewportWidth, resolved);
    default:
      return buildJustifiedLayout(items, viewportWidth, resolved);
  }
}
