import type { FolderEntry } from "../../../shared/backend";
import type { FolderSort } from "./settings.svelte";

import { folderName } from "./library-root";

export interface FolderNode {
  path: string;
  name: string;
  children: FolderNode[];
  /** Newest directory modification time in this folder or any descendant, in milliseconds. */
  newestMs: number | null;
}

export interface FolderRow {
  node: FolderNode;
  depth: number;
  expanded: boolean;
  /** Where the filter text matched this folder's name; null for an ancestor kept for context. */
  match: { start: number; end: number } | null;
}

function trimSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function parentOf(path: string): string | null {
  const trimmed = trimSeparators(path);
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index === 2 && /^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed.slice(0, 3);
  return index < 0 ? null : trimmed.slice(0, index);
}

/** True when `path` is strictly inside `folder`, respecting separators so `D:\A` excludes `D:\AB`. */
export function isInside(path: string, folder: string): boolean {
  const base = trimSeparators(folder);
  return path.startsWith(`${base}\\`) || path.startsWith(`${base}/`);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareSiblings(order: FolderSort): (a: FolderNode, b: FolderNode) => number {
  const byName = (a: FolderNode, b: FolderNode): number => collator.compare(a.name, b.name);
  if (order === "name") return byName;
  return (a, b) => (b.newestMs ?? -Infinity) - (a.newestMs ?? -Infinity) || byName(a, b);
}

/**
 * Builds the tree under the library's included roots. Roots stay in their configured order; each
 * directory hangs under its nearest listed ancestor, and siblings follow `order`. Only folders
 * containing an image, or leading to one, are included.
 */
export function buildFolderTree(
  roots: readonly string[],
  folders: readonly FolderEntry[],
  order: FolderSort,
  imagePaths: readonly string[],
): FolderNode[] {
  const imageFolders = new Set<string>();
  for (const path of imagePaths) {
    let folder = parentOf(path);
    while (folder !== null && !imageFolders.has(folder)) {
      imageFolders.add(folder);
      folder = parentOf(folder);
    }
  }
  const nodes = new Map<string, FolderNode>();
  const add = (path: string, modifiedNs: string | null): void => {
    const newestMs = modifiedNs === null ? null : Number(BigInt(modifiedNs) / 1_000_000n);
    const existing = nodes.get(path);
    if (existing) {
      if (newestMs !== null && (existing.newestMs === null || newestMs > existing.newestMs))
        existing.newestMs = newestMs;
      return;
    }
    nodes.set(path, { path, name: folderName(path), children: [], newestMs });
  };
  for (const root of roots) add(root, null);
  for (const folder of folders) add(folder.path, folder.modifiedNs);

  const top: FolderNode[] = [];
  for (const node of nodes.values()) {
    let parent = parentOf(node.path);
    while (parent !== null && !nodes.has(parent)) parent = parentOf(parent);
    const owner = parent === null ? undefined : nodes.get(parent);
    if (owner) owner.children.push(node);
    else top.push(node);
  }

  const compare = compareSiblings(order);
  const finish = (node: FolderNode): boolean => {
    node.children = node.children.filter(finish);
    for (const child of node.children) {
      const newest = child.newestMs;
      if (newest !== null && (node.newestMs === null || newest > node.newestMs))
        node.newestMs = newest;
    }
    node.children.sort(compare);
    return imageFolders.has(node.path) || node.children.length > 0;
  };
  const visible = top.filter(finish);
  const rootOrder = new Map(roots.map((root, index) => [root, index]));
  return visible.sort(
    (a, b) => (rootOrder.get(a.path) ?? Infinity) - (rootOrder.get(b.path) ?? Infinity),
  );
}

/**
 * Flattens the tree into the rows on screen. Without a filter, `expanded` holds the user's explicit
 * choices; otherwise roots and the branch holding `focused` start open. With a filter, only
 * matching folders and their ancestors are listed, fully opened.
 */
export function visibleFolderRows(
  tree: readonly FolderNode[],
  expanded: Readonly<Record<string, boolean>>,
  focused: string | null,
  filter: string,
): FolderRow[] {
  const rows: FolderRow[] = [];
  const needle = filter.trim().toLocaleLowerCase();

  if (!needle) {
    const visit = (nodes: readonly FolderNode[], depth: number): void => {
      for (const node of nodes) {
        const open =
          node.children.length > 0 &&
          (expanded[node.path] ??
            (depth === 0 || (focused !== null && isInside(focused, node.path))));
        rows.push({ node, depth, expanded: open, match: null });
        if (open) visit(node.children, depth + 1);
      }
    };
    visit(tree, 0);
    return rows;
  }

  const visit = (node: FolderNode, depth: number): FolderRow[] => {
    const start = node.name.toLocaleLowerCase().indexOf(needle);
    const descendants = node.children.flatMap((child) => visit(child, depth + 1));
    if (start < 0 && descendants.length === 0) return [];
    const match = start < 0 ? null : { start, end: start + needle.length };
    return [{ node, depth, expanded: descendants.length > 0, match }, ...descendants];
  };
  for (const node of tree) rows.push(...visit(node, 0));
  return rows;
}

/** Short Explorer-style date: time for today, day and month this year, else the full date. */
export function formatFolderDate(ms: number, now: Date = new Date()): string {
  const date = new Date(ms);
  if (date.toDateString() === now.toDateString())
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (date.getFullYear() === now.getFullYear())
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return date.toLocaleDateString(undefined, { year: "numeric", month: "numeric", day: "numeric" });
}
