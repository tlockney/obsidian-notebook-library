// What the header above a notebook shows. Pure: no DOM, no Obsidian.

import type { Notebook } from './notebook.ts';
import { markdownHeadings } from './outline.ts';

export interface NotebookHeader {
  title: string;
  kernel: string | null;
  /** ms since the epoch; null when no cell recorded an execution time. */
  lastRun: number | null;
  tags: string[];
}

/**
 * The notebook's `metadata.title`, else the first H1 of its first Markdown
 * cell, else the file name without its extension.
 */
export function notebookHeader(nb: Notebook, basename: string): NotebookHeader {
  let title = nb.meta.title;
  if (!title) {
    const first = nb.cells.find(c => c.type === 'markdown');
    title = (first && markdownHeadings(first.source).find(h => h.level === 1)?.text) || null;
  }
  return {
    title: title || basename,
    kernel: nb.meta.kernel,
    lastRun: nb.meta.lastRun,
    tags: nb.meta.tags,
  };
}
