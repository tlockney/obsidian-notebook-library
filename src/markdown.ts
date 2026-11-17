// Safe Markdown for untrusted notebook content. Obsidian's own renderer runs
// other plugins' processors (Dataview JS, inline queries) and passes raw
// HTML through, so notebook Markdown never goes through it. Instead: marked
// parses to HTML, DOMParser turns that into an inert document (no script runs,
// no image loads), and an allowlist copies clean nodes into the target.
// Pure DOM, no obsidian import.

import { marked } from 'marked';

const ALLOWED = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'code',
  'pre',
  'em',
  'strong',
  'b',
  'i',
  'del',
  's',
  'a',
  'img',
  'blockquote',
  'hr',
  'br',
  'span',
  'div',
  'sup',
  'sub',
  'details',
  'summary',
  'kbd',
  'input',
]);

// Dropped with their contents. Anything else not allowed is unwrapped: its
// element goes, its text and allowed children stay.
const DROP_WITH_CONTENTS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'template',
  'svg',
  'math',
  'noscript',
  'link',
  'meta',
  'base',
  'title',
  'head',
]);

const SAFE_IMG = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]*$/i;
const SAFE_HREF = /^(?:https?:|mailto:|#)/i;

function safeHref(raw: string): string | null {
  // As a browser reads a URL: tabs and newlines are removed anywhere, and
  // leading and trailing control characters and spaces are trimmed. Other
  // control characters stay, so `java\u0001script:` is not a scheme.
  const href = raw
    .replace(/[\t\n\r]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
  return SAFE_HREF.test(href) ? href : null;
}

function numeric(v: string | null): string | null {
  return v !== null && /^\d{1,4}$/.test(v.trim()) ? v.trim() : null;
}

function copyAttrs(src: Element, dest: Element, tag: string): void {
  const set = (name: string, value: string | null) => {
    if (value !== null) dest.setAttribute(name, value);
  };
  if (tag === 'a') {
    const href = src.getAttribute('href');
    set('href', href === null ? null : safeHref(href));
    if (dest.hasAttribute('href')) {
      dest.setAttribute('rel', 'noopener noreferrer');
      if (/^https?:/i.test(dest.getAttribute('href')!)) {
        dest.setAttribute('target', '_blank');
        dest.setAttribute('class', 'external-link');
      }
    }
    set('title', src.getAttribute('title'));
  } else if (tag === 'th' || tag === 'td') {
    const align = src.getAttribute('align')?.toLowerCase() ?? null;
    set('align', align !== null && ['left', 'right', 'center'].includes(align) ? align : null);
    set('colspan', numeric(src.getAttribute('colspan')));
    set('rowspan', numeric(src.getAttribute('rowspan')));
  } else if (tag === 'ol') {
    set('start', numeric(src.getAttribute('start')));
  }
}

type Attachments = Record<string, string>;

function copyChildren(src: Node, dest: Node, doc: Document, att: Attachments): void {
  for (const child of Array.from(src.childNodes)) {
    if (child.nodeType === 3) {
      dest.appendChild(doc.createTextNode(child.textContent ?? ''));
    } else if (child.nodeType === 1) {
      copyElement(child as Element, dest, doc, att);
    }
    // Comments, processing instructions and the rest are dropped.
  }
}

function copyElement(src: Element, dest: Node, doc: Document, att: Attachments): void {
  const tag = src.localName.toLowerCase();
  if (DROP_WITH_CONTENTS.has(tag)) return;
  if (!ALLOWED.has(tag)) {
    copyChildren(src, dest, doc, att);
    return;
  }
  if (tag === 'input') {
    if (src.getAttribute('type')?.toLowerCase() !== 'checkbox') return;
    const box = doc.createElement('input');
    box.setAttribute('type', 'checkbox');
    box.setAttribute('disabled', '');
    if (src.hasAttribute('checked')) box.setAttribute('checked', '');
    dest.appendChild(box);
    return;
  }
  if (tag === 'img') {
    let url = src.getAttribute('src')?.replace(/\s+/g, '') ?? '';
    // A notebook's own attachment, already limited to bitmap data: URLs.
    if (url.startsWith('attachment:')) {
      let name = url.slice('attachment:'.length);
      try {
        name = decodeURIComponent(name);
      } catch {
        // Use the name as written.
      }
      url = att[name] ?? '';
    }
    if (!SAFE_IMG.test(url)) {
      // Never load it: show the alt text instead.
      const alt = src.getAttribute('alt');
      if (alt) dest.appendChild(doc.createTextNode(alt));
      return;
    }
    const img = doc.createElement('img');
    img.setAttribute('src', url);
    for (const a of ['alt', 'title']) {
      const v = src.getAttribute(a);
      if (v !== null) img.setAttribute(a, v);
    }
    dest.appendChild(img);
    return;
  }
  const out = doc.createElement(tag);
  copyAttrs(src, out, tag);
  dest.appendChild(out);
  copyChildren(src, out, doc, att);
}

// Code that math must not be taken from, found before marked runs: fenced
// blocks, then inline spans. Indented code is not matched here, because
// whether an indented line is code depends on context (a loose list item's
// continuation paragraph is not). marked decides, and restoreMath puts math
// that landed inside code or pre back as plain text.
const CODE =
  /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[`~]*[ \t]*(?=\n|$)|$)|(`+)(?!`)[\s\S]*?[^`]\2(?!`)/gm;
const DISPLAY_MATH = /\$\$[\s\S]+?\$\$/g;
// `$…$` on one line: not `\$`, no space just inside either `$`, and not
// followed by a digit (so "$5 and $6" is prices, not math).
const INLINE_MATH = /(?<![\\$])\$(?![\s$])(?:[^$\n\\]|\\.)+?(?<![\s\\])\$(?![\d$])/g;

// A placeholder is `<D><index><D>` where D is a single private-use character
// (U+E000 to U+F8FF) that does not occur anywhere in the input. marked never
// invents such characters, so no text, whatever it contains (including the old
// `zzgnbmath` marker or private-use characters), can be mistaken for a
// placeholder. Characters written as numeric references (`&#xE000;`) count as
// present too, since the parser turns them into the character. Nothing is
// stripped or escaped, so literal text is untouched.
function pickDelimiter(markdown: string): string | null {
  const used = new Set<number>();
  for (const m of markdown.matchAll(/&#(?:[xX]([0-9a-fA-F]+)|(\d+));/g)) {
    used.add(m[1] !== undefined ? parseInt(m[1], 16) : parseInt(m[2], 10));
  }
  for (let c = 0xe000; c <= 0xf8ff; c++) {
    const ch = String.fromCharCode(c);
    if (!used.has(c) && !markdown.includes(ch)) return ch;
  }
  return null; // All 6400 are used: leave math unprotected rather than risk a clash.
}

/**
 * Replace math spans with placeholders so marked doesn't read `*`, `_` or
 * `\\` in them as Markdown. The spans come back as literal source (not
 * typeset).
 */
function protectMath(markdown: string): { text: string; spans: string[]; delim: string } {
  const spans: string[] = [];
  const delim = pickDelimiter(markdown);
  if (delim === null) return { text: markdown, spans, delim: '' };
  const hide = (m: string) => `${delim}${spans.push(m) - 1}${delim}`;
  let text = '';
  let last = 0;
  for (const m of markdown.matchAll(CODE)) {
    text += mathOutside(markdown.slice(last, m.index), hide) + m[0];
    last = m.index + m[0].length;
  }
  text += mathOutside(markdown.slice(last), hide);
  return { text, spans, delim };
}

function mathOutside(text: string, hide: (m: string) => string): string {
  return text.replace(DISPLAY_MATH, hide).replace(INLINE_MATH, hide);
}

/**
 * Turn placeholders in text nodes back into `span.nbl-math`. Inside code or
 * pre (indented code, which marked recognizes, or a span marked kept as code)
 * the original text is restored as plain text instead.
 */
function restoreMath(root: HTMLElement, spans: string[], delim: string): void {
  if (!spans.length) return;
  const marked = new RegExp(`${delim}(\\d+)${delim}`, 'g');
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (new RegExp(`${delim}\\d+${delim}`).test(n.nodeValue ?? '')) nodes.push(n as Text);
  }
  for (const node of nodes) {
    const parts = (node.nodeValue ?? '').split(marked);
    const frag = doc.createDocumentFragment();
    const inCode = node.parentElement?.closest('code, pre') != null;
    parts.forEach((part, i) => {
      if (i % 2 === 0) {
        if (part) frag.appendChild(doc.createTextNode(part));
      } else if (spans[Number(part)] !== undefined) {
        if (inCode) {
          frag.appendChild(doc.createTextNode(spans[Number(part)]));
          return;
        }
        const span = doc.createElement('span');
        span.className = 'nbl-math';
        span.textContent = spans[Number(part)];
        frag.appendChild(span);
      }
    });
    node.replaceWith(frag);
  }
}

/**
 * Parse `markdown` and append a clean rendering of it to `el`. `attachments`
 * maps a cell's attachment names to bitmap data: URLs, for `attachment:NAME`
 * images. Math (`$…$`, `$$…$$`) is kept as literal source, not typeset.
 */
export function renderSafeMarkdown(
  markdown: string,
  el: HTMLElement,
  attachments: Attachments = {},
): void {
  const { text, spans, delim } = protectMath(markdown);
  const html = marked.parse(text, { gfm: true, async: false }) as string;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const doc = el.ownerDocument;
  const wrap = doc.createElement('div');
  wrap.className = 'markdown-rendered nbl-markdown';
  copyChildren(parsed.body, wrap, doc, attachments);
  restoreMath(wrap, spans, delim);
  el.appendChild(wrap);
}
