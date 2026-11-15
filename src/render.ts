// Render a parsed notebook into DOM. Notebook content is untrusted: Obsidian
// desktop is Electron with Node access, so nothing from a notebook is ever
// set as innerHTML or inserted as live markup. This file imports nothing from
// the obsidian package at runtime so it runs under jsdom in tests.

import { renderSafeMarkdown } from './markdown.ts';
import type { NotebookHeader } from './header.ts';
import { codeLanguage, IMAGE_MIMES, standaloneSvg } from './notebook.ts';
import type { Cell, Notebook, Output } from './notebook.ts';

/** Syntax-highlights a code element in place (Prism, in the view); optional. */
export type Highlight = (code: HTMLElement, language: string) => void;

export interface RenderOptions {
  /** Code cells start folded (default) or open. */
  foldCode?: boolean;
  /** Show `[n]` after "Code" (default). */
  showCounts?: boolean;
  /** Text outputs longer than this many lines get "Show more"; 0 or unset shows all. */
  maxOutputLines?: number;
  /** Render only these cell indexes (an embed of a section); each keeps its notebook index. */
  cells?: number[];
  header?: NotebookHeader;
}

/** Applied to the iframe document: no scripts, no network, inline styles and data: images only. */
export const IFRAME_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

/** UTF-8 safe base64 (btoa alone throws on characters above U+00FF). */
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function div(parent: HTMLElement, cls: string): HTMLDivElement {
  const el = parent.ownerDocument.createElement('div');
  el.className = cls;
  parent.appendChild(el);
  return el;
}

function pre(parent: HTMLElement, cls: string, text: string): void {
  const el = parent.ownerDocument.createElement('pre');
  el.className = cls;
  el.textContent = text;
  parent.appendChild(el);
}

/**
 * A `<pre>` of text. Past `maxLines` lines only the first are in the page,
 * with a button that swaps in the whole text (still textContent).
 */
function textPre(parent: HTMLElement, cls: string, text: string, maxLines: number): void {
  const lines = text.split('\n');
  if (maxLines <= 0 || lines.length <= maxLines) {
    pre(parent, cls, text);
    return;
  }
  const doc = parent.ownerDocument;
  const el = doc.createElement('pre');
  el.className = cls;
  el.textContent = lines.slice(0, maxLines).join('\n');
  const button = doc.createElement('button');
  button.className = 'nbl-more';
  button.type = 'button';
  button.textContent = `Show ${lines.length - maxLines} more lines`;
  button.addEventListener('click', () => {
    el.textContent = text;
    button.remove();
  });
  parent.append(el, button);
}

function img(parent: HTMLElement, src: string): void {
  const el = parent.ownerDocument.createElement('img');
  el.className = 'nbl-image';
  el.setAttribute('src', src);
  el.setAttribute('alt', 'notebook output');
  parent.appendChild(el);
}

function renderOutput(out: Output, parent: HTMLElement, maxLines: number): void {
  const box = div(parent, 'nbl-output');
  switch (out.kind) {
    case 'text':
      textPre(box, out.stderr ? 'nbl-text nbl-stderr' : 'nbl-text', out.text, maxLines);
      break;
    case 'error': {
      // The traceback when there is one, else the name and value, as
      // ganymede's html.rs does.
      const text = out.traceback
        ? out.traceback
        : out.ename || out.evalue
          ? `${out.ename}: ${out.evalue}`
          : '';
      textPre(box, 'nbl-text nbl-error', text.trimEnd(), maxLines);
      break;
    }
    case 'html': {
      // An empty sandbox: no scripts, no same-origin access. The CSP meta is
      // a second layer. No script can report a height, so the CSS gives a
      // fixed one the reader can drag taller.
      const frame = parent.ownerDocument.createElement('iframe');
      frame.className = 'nbl-html';
      frame.setAttribute('sandbox', '');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${IFRAME_CSP}"></head><body>${out.html}</body></html>`;
      box.appendChild(frame);
      break;
    }
    case 'svg':
      // As an <img> an SVG cannot run script; never inline it.
      img(box, `data:image/svg+xml;base64,${utf8ToBase64(standaloneSvg(out.svg))}`);
      break;
    case 'image':
      if ((IMAGE_MIMES as readonly string[]).includes(out.mime)) {
        img(box, `data:${out.mime};base64,${out.base64}`);
      } else {
        pre(box, 'nbl-text nbl-unsupported', `[unsupported output: ${out.mime}]`);
      }
      break;
    case 'markdown':
      renderSafeMarkdown(out.markdown, box);
      break;
    case 'unsupported':
      pre(
        box,
        'nbl-text nbl-unsupported',
        `[unsupported output: ${out.mimes.join(', ') || 'empty'}]`,
      );
      break;
  }
}

function renderCell(
  cell: Cell,
  index: number,
  language: string,
  parent: HTMLElement,
  highlight: Highlight | undefined,
  opts: RenderOptions,
): void {
  const box = div(parent, `nbl-cell nbl-${cell.type}`);
  // Search results, links and the outline find a cell by these.
  box.setAttribute('data-cell-index', String(index));
  if (cell.id) box.setAttribute('data-cell-id', cell.id);
  if (cell.type === 'markdown') {
    renderSafeMarkdown(cell.source, box, cell.attachments);
    return;
  }
  if (cell.type === 'raw') {
    pre(box, 'nbl-text nbl-raw', cell.source);
    return;
  }
  // Code is folded by default; outputs stay visible after it.
  const details = box.ownerDocument.createElement('details');
  details.className = 'nbl-code';
  if (cell.id) details.setAttribute('data-cell-id', cell.id);
  const summary = box.ownerDocument.createElement('summary');
  summary.append('Code');
  if (cell.executionCount !== null && opts.showCounts !== false) {
    const count = box.ownerDocument.createElement('span');
    count.className = 'nbl-count';
    count.textContent = ` [${cell.executionCount}]`;
    summary.appendChild(count);
  }
  details.appendChild(summary);
  if (opts.foldCode === false) details.setAttribute('open', '');
  box.appendChild(details);
  // Built here, not by Obsidian's MarkdownRenderer: every plugin's
  // post-processors see what that renders. The source is textContent; the
  // highlighter only re-writes it as escaped tokens.
  const lang = codeLanguage(language);
  const doc = box.ownerDocument;
  const source = div(details, 'markdown-rendered nbl-source');
  const preEl = doc.createElement('pre');
  const code = doc.createElement('code');
  if (lang) {
    preEl.className = `language-${lang}`;
    code.className = `language-${lang}`;
  }
  code.textContent = cell.source;
  preEl.appendChild(code);
  source.appendChild(preEl);
  if (lang && highlight) highlight(code, lang);
  for (const out of cell.outputs) renderOutput(out, box, opts.maxOutputLines ?? 0);
}

/** The title, kernel, last run and tags above the cells; every value is textContent. */
function renderHeader(header: NotebookHeader, parent: HTMLElement): void {
  const doc = parent.ownerDocument;
  const box = div(parent, 'nbl-header');
  const title = doc.createElement('div');
  title.className = 'nbl-title';
  title.textContent = header.title;
  box.appendChild(title);
  const facts = div(box, 'nbl-facts');
  const fact = (label: string, value: string) => {
    const el = doc.createElement('span');
    el.className = 'nbl-fact';
    el.textContent = `${label}: ${value}`;
    facts.appendChild(el);
  };
  if (header.kernel) fact('Kernel', header.kernel);
  if (header.lastRun !== null) fact('Last run', new Date(header.lastRun).toLocaleString());
  for (const tag of header.tags) {
    const el = doc.createElement('span');
    el.className = 'nbl-tag';
    el.textContent = tag;
    facts.appendChild(el);
  }
  if (!facts.hasChildNodes()) facts.remove();
}

/** Replace the contents of `root` with the rendered notebook. */
export function renderNotebook(
  nb: Notebook,
  root: HTMLElement,
  highlight?: Highlight,
  opts: RenderOptions = {},
): void {
  const frag = root.ownerDocument.createElement('div');
  frag.className = 'nbl markdown-preview-view markdown-rendered';
  if (opts.header) renderHeader(opts.header, frag);
  const shown = opts.cells ?? nb.cells.map((_, i) => i);
  for (const i of shown) {
    if (nb.cells[i]) renderCell(nb.cells[i], i, nb.language, frag, highlight, opts);
  }
  if (shown.length === 0) pre(frag, 'nbl-text', 'This notebook has no cells.');
  root.replaceChildren(frag);
}

/** Show a parse failure in the view instead of leaving it blank. */
export function renderError(root: HTMLElement, message: string): void {
  const box = root.ownerDocument.createElement('div');
  box.className = 'nbl markdown-preview-view markdown-rendered nbl-failure';
  const title = root.ownerDocument.createElement('strong');
  title.textContent = 'Cannot open this notebook';
  const body = root.ownerDocument.createElement('p');
  body.textContent = message;
  box.append(title, body);
  root.replaceChildren(box);
}

export interface OpenState {
  id: string | null;
  open: boolean;
}

/** Which code cells are expanded, in notebook order, with their cell ids. */
export function captureOpen(root: ParentNode): OpenState[] {
  return Array.from(root.querySelectorAll('details.nbl-code')).map(d => ({
    id: d.getAttribute('data-cell-id'),
    open: d.hasAttribute('open'),
  }));
}

/**
 * Restore the open or closed state `captureOpen` saw. A cell with an id is
 * matched by id, so inserting a cell above doesn't move the state; a cell
 * without one is matched by position (against states that also had no id).
 */
export function applyOpen(root: ParentNode, state: OpenState[]): void {
  const byId = new Map<string, boolean>();
  for (const s of state) if (s.id) byId.set(s.id, s.open);
  Array.from(root.querySelectorAll('details.nbl-code')).forEach((d, i) => {
    const id = d.getAttribute('data-cell-id');
    const open = id ? byId.get(id) : state[i] && !state[i].id ? state[i].open : undefined;
    // A cell the state doesn't know keeps the default; one it knows is set
    // either way, so a cell the reader collapsed stays collapsed with fold off.
    if (open !== undefined) d.toggleAttribute('open', open);
  });
}
