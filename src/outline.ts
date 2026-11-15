// Headings, subpaths and cell targets. Pure: no DOM, no Obsidian. Used by the
// outline view, `[[nb.ipynb#Heading]]` links, embeds and search results.

import type { Notebook } from './notebook.ts';

export interface Heading {
  /** Index of the Markdown cell the heading is in. */
  cellIndex: number;
  level: number;
  text: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

/** Heading text as a reader sees it: no closing `#`s, link or emphasis markers. */
function plainHeading(raw: string): string {
  return raw
    .replace(/[ \t]+#+$/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]|~~/g, '')
    .trim();
}

/**
 * ATX headings (`# Title`) of one Markdown source, skipping fenced code. A
 * fence closes only on the same character, at least as long, as it opened.
 * Setext headings (underlined with `===` or `---`) are not recognised.
 */
export function markdownHeadings(source: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  let fence: { char: string; len: number } | null = null;
  for (const line of source.split(/\r?\n/)) {
    const f = FENCE.exec(line);
    if (fence) {
      const closes =
        f && f[1][0] === fence.char && f[1].length >= fence.len && !line.slice(f[0].length).trim();
      if (closes) fence = null;
      continue;
    }
    if (f) {
      fence = { char: f[1][0], len: f[1].length };
      continue;
    }
    const m = ATX.exec(line);
    if (!m) continue;
    const text = plainHeading(m[2] ?? '');
    if (text) out.push({ level: m[1].length, text });
  }
  return out;
}

/** Every Markdown heading of the notebook, in order. */
export function notebookHeadings(nb: Notebook): Heading[] {
  const out: Heading[] = [];
  nb.cells.forEach((cell, cellIndex) => {
    if (cell.type !== 'markdown') return;
    for (const h of markdownHeadings(cell.source)) out.push({ cellIndex, ...h });
  });
  return out;
}

/** Heading text as Obsidian compares it in a link: case, spaces and link-hostile marks ignored. */
export function normalizeHeading(text: string): string {
  return text
    .replace(/[#|^:%[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export type Subpath = { kind: 'heading'; path: string[] } | { kind: 'block'; id: string };

/**
 * `#Heading`, `#A#B` (B under A) or `#^id`. Obsidian passes the leading `#`;
 * a bare name is accepted too. Anything else (empty) is null.
 */
export function parseSubpath(raw: unknown): Subpath | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/^#/, '');
  if (!s) return null;
  if (s.startsWith('^')) {
    const id = s.slice(1).trim();
    return id ? { kind: 'block', id } : null;
  }
  const path = s
    .split('#')
    .map(p => p.trim())
    .filter(Boolean);
  return path.length ? { kind: 'heading', path } : null;
}

/** Index of the cell with this id: exact, else ignoring case. */
export function cellIndexById(nb: Notebook, id: string): number | null {
  let i = nb.cells.findIndex(c => c.id === id);
  if (i === -1) {
    const lower = id.toLowerCase();
    i = nb.cells.findIndex(c => c.id?.toLowerCase() === lower);
  }
  return i === -1 ? null : i;
}

/**
 * The cells a subpath selects: for a heading, from its cell up to (not
 * including) the next Markdown cell with a heading of the same or a higher
 * level; for `^id`, that one cell. For `#A#B` the section of the first B
 * after A. Null when nothing matches.
 */
export function selectCells(nb: Notebook, sub: Subpath): number[] | null {
  if (sub.kind === 'block') {
    const i = cellIndexById(nb, sub.id);
    return i === null ? null : [i];
  }
  const headings = notebookHeadings(nb);
  let from = 0;
  let found: Heading | null = null;
  for (const name of sub.path) {
    const want = normalizeHeading(name);
    const next = headings.findIndex((h, i) => i >= from && normalizeHeading(h.text) === want);
    if (next === -1) return null;
    found = headings[next];
    from = next + 1;
  }
  if (!found) return null;
  const start = found.cellIndex;
  const level = found.level;
  let end = nb.cells.length;
  for (const h of headings) {
    if (h.cellIndex > start && h.level <= level) {
      end = h.cellIndex;
      break;
    }
  }
  return Array.from({ length: end - start }, (_, i) => start + i);
}

/** Where to scroll: the first cell of the selection. */
export function locateSubpath(nb: Notebook, sub: Subpath): number | null {
  return selectCells(nb, sub)?.[0] ?? null;
}

/** A cell to scroll to, from a search hit or a subpath. */
export type Target =
  | { kind: 'subpath'; subpath: Subpath }
  | { kind: 'cell'; id: string | null; index: number };

export const CELL_STATE_KEY = 'notebookCell';

/** Reads Obsidian's ephemeral view state (`subpath`) or this plugin's `notebookCell`. */
export function targetFromState(state: unknown): Target | null {
  if (typeof state !== 'object' || state === null) return null;
  const s = state as Record<string, unknown>;
  const cell = s[CELL_STATE_KEY];
  if (typeof cell === 'object' && cell !== null) {
    const c = cell as Record<string, unknown>;
    const index = typeof c.index === 'number' && Number.isInteger(c.index) ? c.index : -1;
    const id = typeof c.id === 'string' && c.id ? c.id : null;
    if (id || index >= 0) return { kind: 'cell', id, index };
  }
  const subpath = parseSubpath(s.subpath);
  return subpath ? { kind: 'subpath', subpath } : null;
}

/** The cell index a target points at in this notebook, or null. A cell id wins over its old index. */
export function resolveTarget(nb: Notebook, target: Target): number | null {
  if (target.kind === 'subpath') return locateSubpath(nb, target.subpath);
  if (target.id) {
    const byId = cellIndexById(nb, target.id);
    if (byId !== null) return byId;
  }
  return target.index >= 0 && target.index < nb.cells.length ? target.index : null;
}

/**
 * `nb.ipynb#Heading|400` into its file part and subpath (with `#`), as an
 * embed's `src` gives it; an `|alias` or size is dropped.
 */
export function splitLinkText(src: string): { path: string; subpath: string } {
  const bar = src.indexOf('|');
  const link = bar === -1 ? src : src.slice(0, bar);
  const i = link.indexOf('#');
  return i === -1
    ? { path: link, subpath: '' }
    : { path: link.slice(0, i), subpath: link.slice(i) };
}
