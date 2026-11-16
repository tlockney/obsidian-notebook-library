// The search index over every notebook in the vault. Pure: no Obsidian, no
// DOM. A notebook is parsed once into per-cell text; queries run over that.

import { parseNotebook } from './notebook.ts';
import { markdownHeadings } from './outline.ts';

/** A notebook larger than this is not read, so a huge one can't freeze mobile. */
export const MAX_INDEX_BYTES = 20 * 1024 * 1024;

export interface IndexedCell {
  index: number;
  id: string | null;
  kind: 'markdown' | 'code' | 'raw';
  source: string;
  /** Text outputs (stream text, text/plain), joined; empty for other cells. */
  output: string;
  /** Markdown headings of the cell, for ranking. */
  headings: string[];
}

export interface IndexEntry {
  path: string;
  basename: string;
  cells: IndexedCell[];
}

/** Basename without the extension, as Obsidian shows it. */
export function basenameOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.replace(/\.ipynb$/i, '');
}

/** An entry for the notebook text, or null when it can't be parsed. */
export function indexNotebook(path: string, text: string): IndexEntry | null {
  let nb;
  try {
    nb = parseNotebook(text);
  } catch {
    return null;
  }
  const cells = nb.cells.map<IndexedCell>((cell, index) => ({
    index,
    id: cell.id,
    kind: cell.type,
    source: cell.source,
    output:
      cell.type === 'code'
        ? cell.outputs.flatMap(o => (o.kind === 'text' ? [o.text] : [])).join('\n')
        : '',
    headings: cell.type === 'markdown' ? markdownHeadings(cell.source).map(h => h.text) : [],
  }));
  return { path, basename: basenameOf(path), cells };
}

/** Query words: lowercase, split on whitespace, empty and repeated ones dropped. */
export function queryWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
}

export interface Segment {
  text: string;
  match: boolean;
}

export interface SearchHit {
  path: string;
  basename: string;
  cell: IndexedCell;
  /** Where the first match was found. */
  field: 'source' | 'output';
  score: number;
  snippet: Segment[];
}

export interface SearchOptions {
  outputs: boolean;
  limit?: number;
}

function count(haystack: string, needle: string): number {
  let n = 0;
  for (
    let i = haystack.indexOf(needle);
    i !== -1;
    i = haystack.indexOf(needle, i + needle.length)
  ) {
    n++;
  }
  return n;
}

const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 80;

/**
 * About 120 characters of `text` around the earliest match of any word, on
 * one line, split into matched and unmatched pieces for the caller to show
 * with textContent. Null when no word is in the text.
 */
export function makeSnippet(text: string, words: string[]): Segment[] | null {
  // Lowercasing can change the length (some non-ASCII letters); positions
  // then come from the lowered text so they stay consistent.
  const lower = text.toLowerCase();
  const base = lower.length === text.length ? text : lower;
  let first = -1;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i !== -1 && (first === -1 || i < first)) first = i;
  }
  if (first === -1) return null;
  const start = Math.max(0, first - SNIPPET_BEFORE);
  const end = Math.min(base.length, first + SNIPPET_AFTER);
  const raw = base.slice(start, end);
  const flat = raw.replace(/\s+/g, ' ');
  const flatLower = flat.toLowerCase();
  const marks: [number, number][] = [];
  for (const w of words) {
    for (let i = flatLower.indexOf(w); i !== -1; i = flatLower.indexOf(w, i + w.length)) {
      marks.push([i, i + w.length]);
    }
  }
  marks.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const segments: Segment[] = [];
  let at = 0;
  const push = (t: string, match: boolean) => {
    if (t) segments.push({ text: t, match });
  };
  for (const [s, e] of marks) {
    if (s < at) continue;
    push(flat.slice(at, s), false);
    push(flat.slice(s, e), true);
    at = e;
  }
  push(flat.slice(at), false);
  if (start > 0) segments[0] = { ...segments[0], text: `…${segments[0].text}` };
  if (end < base.length) {
    const last = segments.length - 1;
    segments[last] = { ...segments[last], text: `${segments[last].text}…` };
  }
  return segments;
}

/**
 * Matches in one cell, or null: every word must occur in the cell's source
 * (plus its output text when `outputs`). The score is the number of
 * occurrences (each word capped at 5), plus 10 per word in the file name and
 * 4 per word in a heading of the cell.
 */
function scoreCell(
  entry: IndexEntry,
  cell: IndexedCell,
  words: string[],
  outputs: boolean,
): { score: number; field: 'source' | 'output'; snippet: Segment[] } | null {
  const source = cell.source.toLowerCase();
  const out = outputs ? cell.output.toLowerCase() : '';
  const title = entry.basename.toLowerCase();
  const headings = cell.headings.join('\n').toLowerCase();
  let score = 0;
  for (const w of words) {
    const n = count(source, w) + count(out, w);
    if (n === 0) return null;
    score += Math.min(n, 5);
    if (title.includes(w)) score += 10;
    if (headings.includes(w)) score += 4;
  }
  const inSource = makeSnippet(cell.source, words);
  if (inSource) return { score, field: 'source', snippet: inSource };
  const inOutput = makeSnippet(cell.output, words);
  return inOutput ? { score, field: 'output', snippet: inOutput } : null;
}

export class NotebookIndex {
  private readonly entries = new Map<string, IndexEntry>();
  private readonly skipped = new Map<string, number>();

  get size(): number {
    return this.entries.size;
  }

  /** Paths skipped for being over MAX_INDEX_BYTES, with their sizes. */
  skippedFiles(): [string, number][] {
    return [...this.skipped];
  }

  /** Replace the entry for a path; an unreadable notebook gets none. */
  set(path: string, text: string): void {
    this.skipped.delete(path);
    const entry = indexNotebook(path, text);
    if (entry) this.entries.set(path, entry);
    else this.entries.delete(path);
  }

  markSkipped(path: string, bytes: number): void {
    this.entries.delete(path);
    this.skipped.set(path, bytes);
  }

  remove(path: string): void {
    this.entries.delete(path);
    this.skipped.delete(path);
  }

  /** Indexed or skipped paths inside a folder: `folder/…`. */
  pathsUnder(folder: string): string[] {
    const prefix = `${folder}/`;
    return [...this.entries.keys(), ...this.skipped.keys()].filter(p => p.startsWith(prefix));
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  clear(): void {
    this.entries.clear();
    this.skipped.clear();
  }

  /** All words in one cell, best first; ties by path, then cell order. */
  search(query: string, opts: SearchOptions): SearchHit[] {
    const words = queryWords(query);
    if (words.length === 0) return [];
    const hits: SearchHit[] = [];
    for (const entry of this.entries.values()) {
      for (const cell of entry.cells) {
        const m = scoreCell(entry, cell, words, opts.outputs);
        if (m) hits.push({ path: entry.path, basename: entry.basename, cell, ...m });
      }
    }
    hits.sort(
      (a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.cell.index - b.cell.index,
    );
    return hits.slice(0, opts.limit ?? 50);
  }
}
