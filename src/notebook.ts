// Parse an nbformat 4 notebook into a small model for the viewer. Pure: no
// DOM, no Obsidian.

export type Output =
  | { kind: 'text'; text: string; stderr: boolean }
  | { kind: 'error'; ename: string; evalue: string; traceback: string }
  | { kind: 'html'; html: string }
  | { kind: 'svg'; svg: string }
  | { kind: 'image'; mime: ImageMime; base64: string }
  | { kind: 'markdown'; markdown: string }
  | { kind: 'unsupported'; mimes: string[] };

export type Cell =
  | { type: 'markdown'; id: string | null; source: string; attachments: Record<string, string> }
  | {
      type: 'code';
      id: string | null;
      source: string;
      executionCount: number | null;
      outputs: Output[];
    }
  | { type: 'raw'; id: string | null; source: string };

/** Notebook-level facts for the header; strings only, nothing is interpreted. */
export interface NotebookMeta {
  title: string | null;
  kernel: string | null;
  tags: string[];
  /** Latest execution timestamp of any cell, in ms since the epoch. */
  lastRun: number | null;
}

export interface Notebook {
  language: string;
  cells: Cell[];
  meta: NotebookMeta;
}

export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

export const GANYMEDE_RESULT_MIME = 'application/vnd.ganymede.result+json';

/**
 * Preference order for a display_data / execute_result bundle: images before
 * HTML, as ganymede's html.rs does (an image looks the same everywhere and
 * needs no frame).
 */
const MIME_PREFERENCE = [
  GANYMEDE_RESULT_MIME,
  'image/svg+xml',
  ...IMAGE_MIMES,
  'text/html',
  'text/markdown',
  'application/json',
  'text/plain',
];

export class NotebookError extends Error {}

// CSI: ESC [ params intermediates final. OSC: ESC ] ... terminated by BEL or
// ESC \. Then any other two-byte ESC sequence.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * Apply carriage returns within each line: the text after the last `\r`
 * replaces what came before (progress bars). `\r\n` is a newline. Mirrors
 * ganymede's `overwrite_returns`.
 */
export function overwriteReturns(text: string): string {
  return text
    .split('\n')
    .map(line => {
      const l = line.endsWith('\r') ? line.slice(0, -1) : line;
      return l.slice(l.lastIndexOf('\r') + 1);
    })
    .join('\n');
}

/**
 * The language for a code cell's `language-x` class: lowercase, `deno` as
 * `typescript`, and only a plain token (letters, digits, `+`, `#`, `-`);
 * anything else gets none. The source is built with textContent and never
 * passes through a Markdown renderer, so the name is only a class and a
 * Prism lookup.
 */
export function codeLanguage(language: string): string {
  const lang = language.trim().toLowerCase();
  if (lang === 'deno') return 'typescript';
  return /^[a-z0-9+#-]+$/.test(lang) ? lang : '';
}

/**
 * SVG as an <img> needs it: kernels such as Observable Plot serialize from
 * an HTML DOM and leave out the namespace. Mirrors ganymede's
 * `standalone_svg` (crates/nblformat/src/html.rs), and also skips
 * comments before the root tag.
 */
export function standaloneSvg(svg: string): string {
  let start = -1;
  for (let i = 0; ; ) {
    const comment = svg.indexOf('<!--', i);
    const root = svg.indexOf('<svg', i);
    if (root === -1) break;
    if (comment !== -1 && comment < root) {
      const close = svg.indexOf('-->', comment + 4);
      if (close === -1) break;
      i = close + 3;
      continue;
    }
    start = root;
    break;
  }
  if (start === -1) return svg;
  const end = svg.indexOf('>', start);
  if (end === -1) return svg;
  const tag = svg.slice(start, end);
  let add = '';
  if (!tag.includes('xmlns=')) add += ' xmlns="http://www.w3.org/2000/svg"';
  if (!tag.includes('xmlns:xlink=') && svg.includes('xlink:')) {
    add += ' xmlns:xlink="http://www.w3.org/1999/xlink"';
  }
  if (!add) return svg;
  const at = start + '<svg'.length;
  return svg.slice(0, at) + add + svg.slice(at);
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** nbformat multiline strings: a string or an array of strings. */
function multiline(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.filter(s => typeof s === 'string').join('');
  return '';
}

function parseOutput(raw: unknown): Output | null {
  if (!isObj(raw)) return null;
  switch (raw.output_type) {
    case 'stream':
      return {
        kind: 'text',
        text: overwriteReturns(stripAnsi(multiline(raw.text))),
        stderr: raw.name === 'stderr',
      };
    case 'error': {
      const tb = Array.isArray(raw.traceback) ? raw.traceback : [];
      return {
        kind: 'error',
        ename: stripAnsi(String(raw.ename ?? '')),
        evalue: stripAnsi(String(raw.evalue ?? '')),
        traceback: stripAnsi(tb.map(l => String(l)).join('\n')),
      };
    }
    case 'execute_result':
    case 'display_data':
      return parseBundle(isObj(raw.data) ? raw.data : {});
    default:
      return { kind: 'unsupported', mimes: [String(raw.output_type ?? 'unknown')] };
  }
}

function parseBundle(data: Obj): Output {
  for (const mime of MIME_PREFERENCE) {
    if (!(mime in data)) continue;
    const value = data[mime];
    switch (mime) {
      case GANYMEDE_RESULT_MIME: {
        // A missing or empty name isn't a named result: fall through to the
        // next MIME type, as ganymede's named_result returns None.
        const name = isObj(value) && typeof value.name === 'string' ? value.name : '';
        if (!name || !isObj(value)) continue;
        const json = JSON.stringify(value.value ?? null, null, 2);
        return { kind: 'text', text: `${name} = ${json}`, stderr: false };
      }
      case 'text/html': {
        const html = multiline(value);
        if (!html.trim()) continue;
        return { kind: 'html', html };
      }
      case 'image/svg+xml': {
        const svg = multiline(value);
        if (!svg.trim()) continue;
        return { kind: 'svg', svg };
      }
      case 'text/markdown': {
        const markdown = multiline(value);
        if (!markdown.trim()) continue;
        return { kind: 'markdown', markdown };
      }
      case 'application/json':
        return {
          kind: 'text',
          text: typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? ''),
          stderr: false,
        };
      case 'text/plain':
        return { kind: 'text', text: stripAnsi(multiline(value)), stderr: false };
      default: {
        // A bitmap only if its data is base64; else try the next type.
        const base64 = multiline(value).replace(/\s+/g, '');
        if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) continue;
        return { kind: 'image', mime: mime as ImageMime, base64 };
      }
    }
  }
  return { kind: 'unsupported', mimes: Object.keys(data) };
}

/** Consecutive stream outputs with the same name are one stream. */
function mergeStreams(outputs: unknown[]): unknown[] {
  const merged: unknown[] = [];
  for (const o of outputs) {
    const prev = merged[merged.length - 1];
    if (
      isObj(o) &&
      o.output_type === 'stream' &&
      isObj(prev) &&
      prev.output_type === 'stream' &&
      prev.name === o.name
    ) {
      merged[merged.length - 1] = { ...prev, text: multiline(prev.text) + multiline(o.text) };
    } else merged.push(o);
  }
  return merged;
}

/** A markdown cell's attachments as data: URLs, for bitmap mimes only. */
function parseAttachments(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(raw)) return out;
  for (const [name, bundle] of Object.entries(raw)) {
    if (!isObj(bundle)) continue;
    const mime = IMAGE_MIMES.find(m => typeof bundle[m] === 'string' || Array.isArray(bundle[m]));
    if (mime) out[name] = `data:${mime};base64,${multiline(bundle[mime]).replace(/\s+/g, '')}`;
  }
  return out;
}

function cellId(raw: Obj): string | null {
  return typeof raw.id === 'string' && raw.id ? raw.id : null;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string' && t !== '') : [];
}

/** The execution time recorded by Jupyter in a cell's `metadata.execution`, or null. */
function executedAt(raw: Obj): number | null {
  const exec = isObj(raw.metadata) && isObj(raw.metadata.execution) ? raw.metadata.execution : {};
  let latest: number | null = null;
  for (const key of ['iopub.execute_input', 'shell.execute_reply']) {
    const v = exec[key];
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
  }
  return latest;
}

function parseMeta(metadata: Obj, kernelspec: Obj, languageInfo: Obj, lastRun: number | null) {
  const ganymede = isObj(metadata.ganymede) ? metadata.ganymede : {};
  const kernel =
    (typeof kernelspec.display_name === 'string' && kernelspec.display_name) ||
    (typeof languageInfo.name === 'string' && languageInfo.name) ||
    null;
  const tags = [...stringList(metadata.tags), ...stringList(ganymede.tags)];
  return {
    title:
      typeof metadata.title === 'string' && metadata.title.trim() ? metadata.title.trim() : null,
    kernel,
    tags: [...new Set(tags)],
    lastRun,
  };
}

/** Parse the text of an .ipynb file. Throws NotebookError with a message fit to show. */
export function parseNotebook(text: string): Notebook {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new NotebookError(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObj(json)) throw new NotebookError('Not a notebook: the top level is not an object.');
  if (json.nbformat !== 4) {
    throw new NotebookError(
      `Only nbformat 4 notebooks are supported (this file says nbformat ${String(json.nbformat ?? 'missing')}).`,
    );
  }
  const metadata = isObj(json.metadata) ? json.metadata : {};
  const languageInfo = isObj(metadata.language_info) ? metadata.language_info : {};
  const kernelspec = isObj(metadata.kernelspec) ? metadata.kernelspec : {};
  const language =
    (typeof languageInfo.name === 'string' && languageInfo.name) ||
    (typeof kernelspec.language === 'string' && kernelspec.language) ||
    '';

  const cells: Cell[] = [];
  let lastRun: number | null = null;
  for (const raw of Array.isArray(json.cells) ? json.cells : []) {
    if (!isObj(raw)) continue;
    const source = multiline(raw.source);
    if (raw.cell_type === 'markdown') {
      cells.push({
        type: 'markdown',
        id: cellId(raw),
        source,
        attachments: parseAttachments(raw.attachments),
      });
    } else if (raw.cell_type === 'code') {
      const outputs: Output[] = [];
      for (const o of mergeStreams(Array.isArray(raw.outputs) ? raw.outputs : [])) {
        const parsed = parseOutput(o);
        if (parsed) outputs.push(parsed);
      }
      const ran = executedAt(raw);
      if (ran !== null && (lastRun === null || ran > lastRun)) lastRun = ran;
      cells.push({
        type: 'code',
        id: cellId(raw),
        source,
        executionCount: typeof raw.execution_count === 'number' ? raw.execution_count : null,
        outputs,
      });
    } else cells.push({ type: 'raw', id: cellId(raw), source });
  }
  return { language, cells, meta: parseMeta(metadata, kernelspec, languageInfo, lastRun) };
}
