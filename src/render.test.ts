import { describe, expect, it, vi } from 'vitest';
import { parseNotebook } from './notebook.ts';
import type { Notebook, NotebookMeta } from './notebook.ts';

const NO_META: NotebookMeta = { title: null, kernel: null, tags: [], lastRun: null };
import {
  applyOpen,
  captureOpen,
  IFRAME_CSP,
  renderError,
  renderNotebook,
  utf8ToBase64,
} from './render.ts';
import type { Highlight } from './render.ts';

function codeNb(output: unknown, source = 'x'): Notebook {
  return {
    language: 'python',
    meta: NO_META,
    cells: [{ type: 'code', id: null, source, executionCount: 3, outputs: [output as never] }],
  };
}

async function draw(nb: Notebook) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const hl = vi.fn<Highlight>();
  renderNotebook(nb, root, hl);
  return { root, hl };
}

describe('renderNotebook', () => {
  it('renders html in an iframe with an empty sandbox and a CSP', async () => {
    const html = '<p>hi</p><script>window.pwned = 1</script>';
    const { root } = await draw(codeNb({ kind: 'html', html }));
    const frame = root.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame!.hasAttribute('sandbox')).toBe(true);
    expect(frame!.getAttribute('sandbox')).toBe('');
    expect(frame!.getAttribute('referrerpolicy')).toBe('no-referrer');
    const srcdoc = frame!.getAttribute('srcdoc')!;
    expect(srcdoc).toContain('http-equiv="Content-Security-Policy"');
    expect(srcdoc).toContain(IFRAME_CSP);
    expect(srcdoc.indexOf('Content-Security-Policy')).toBeLessThan(srcdoc.indexOf('<p>hi</p>'));
    expect(root.querySelector('script')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });

  it('renders svg as an img data URL, never inline', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const { root } = await draw(codeNb({ kind: 'svg', svg }));
    const img = root.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(`data:image/svg+xml;base64,${btoa(svg)}`);
    expect(root.querySelector('svg')).toBeNull();
    expect(root.querySelector('script')).toBeNull();
  });

  it('adds the svg namespace so an img can draw it', async () => {
    const svg = '<svg viewBox="0 0 1 1" fill="currentColor"><use xlink:href="#a"/></svg>';
    const { root } = await draw(codeNb({ kind: 'svg', svg }));
    const src = root.querySelector('img')!.getAttribute('src')!;
    const decoded = atob(src.replace('data:image/svg+xml;base64,', ''));
    expect(decoded).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1 1" fill="currentColor"><use xlink:href="#a"/></svg>',
    );
  });

  it('encodes unicode svg without throwing', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>héllo ✓ 日本 😀</text></svg>';
    expect(() => btoa(svg)).toThrow();
    const { root } = await draw(codeNb({ kind: 'svg', svg }));
    const src = root.querySelector('img')!.getAttribute('src')!;
    const b64 = src.replace('data:image/svg+xml;base64,', '');
    expect(new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)))).toBe(svg);
    expect(utf8ToBase64('✓')).toBe('4pyT');
  });

  it('renders text, stream and error outputs as literal text', async () => {
    const nb = parseNotebook(
      JSON.stringify({
        nbformat: 4,
        cells: [
          {
            cell_type: 'code',
            id: null,
            source: '',
            outputs: [
              { output_type: 'stream', name: 'stdout', text: '<b>x</b>' },
              {
                output_type: 'error',
                ename: '<i>E</i>',
                evalue: '<u>v</u>',
                traceback: ['<s>t</s>'],
              },
              { output_type: 'display_data', data: { 'text/plain': '<img src=x onerror=1>' } },
            ],
          },
        ],
      }),
    );
    const { root } = await draw(nb);
    const pres = [...root.querySelectorAll('.nbl-output pre')];
    expect(pres).toHaveLength(3);
    expect(pres[0].textContent).toBe('<b>x</b>');
    expect(pres[1].textContent).toBe('<s>t</s>');
    expect(pres[2].textContent).toBe('<img src=x onerror=1>');
    expect(root.querySelector('b, i, u, s')).toBeNull();
    expect(root.querySelector('.nbl-output img')).toBeNull();
  });

  it('uses images only for whitelisted bitmap mimes', async () => {
    const ok = await draw(codeNb({ kind: 'image', mime: 'image/png', base64: 'AAAA' }));
    expect(ok.root.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    const bad = await draw(codeNb({ kind: 'image', mime: 'image/x-foo', base64: 'AAAA' }));
    expect(bad.root.querySelector('img')).toBeNull();
    expect(bad.root.textContent).toContain('unsupported output: image/x-foo');
  });

  it('parsed non-whitelisted image mimes never become an img', async () => {
    const nb = parseNotebook(
      JSON.stringify({
        nbformat: 4,
        cells: [
          {
            cell_type: 'code',
            id: null,
            source: '',
            outputs: [{ output_type: 'display_data', data: { 'image/x-foo': 'AAAA' } }],
          },
        ],
      }),
    );
    const { root } = await draw(nb);
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('unsupported output: image/x-foo');
  });

  it('renders markdown cells and outputs itself; code never reaches a markdown renderer', async () => {
    const nb: Notebook = {
      language: 'python',
      meta: NO_META,
      cells: [
        { type: 'markdown', id: null, source: '# Title', attachments: {} },
        {
          type: 'code',
          id: null,
          source: 'a',
          executionCount: 1,
          outputs: [{ kind: 'markdown', markdown: '**out**' }],
        },
      ],
    };
    const { root } = await draw(nb);
    expect(root.querySelector('h1')!.textContent).toBe('Title');
    expect(root.querySelector('strong')!.textContent).toBe('out');
  });

  it('resolves attachment: images in markdown cells, bitmaps only', async () => {
    const nb: Notebook = {
      language: '',
      meta: NO_META,
      cells: [
        {
          type: 'markdown',
          id: null,
          source: '![p](attachment:a.png) ![s](attachment:b.svg)',
          attachments: { 'a.png': 'data:image/png;base64,AAAA' },
        },
      ],
    };
    const { root } = await draw(nb);
    const imgs = root.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(root.textContent).toContain('s');
  });

  it('renders a folded code cell with its source as literal text', async () => {
    const src = '<b>x</b> = 1 // </code></pre><script>1</script>';
    const { root } = await draw(codeNb({ kind: 'text', text: 'o', stderr: false }, src));
    expect(root.querySelector('.nbl-prompt')).toBeNull();
    const details = root.querySelector('details.nbl-code')!;
    expect(details.hasAttribute('open')).toBe(false);
    expect(details.querySelector('summary')!.textContent).toBe('Code [3]');
    expect(details.querySelector('summary .nbl-count')!.textContent).toBe(' [3]');
    const code = details.querySelector('.nbl-source.markdown-rendered > pre > code')!;
    expect(code.textContent).toBe(src);
    expect(code.className).toBe('language-python');
    expect(details.querySelector('b, script')).toBeNull();
    // Outputs stay visible: after the details, not inside it.
    expect(details.querySelector('.nbl-output')).toBeNull();
    expect(details.nextElementSibling!.classList.contains('nbl-output')).toBe(true);
    expect(root.querySelector('.nbl')!.classList.contains('markdown-preview-view')).toBe(true);
  });

  it('hands the code element and language to the highlighter', async () => {
    const { root, hl } = await draw(codeNb({ kind: 'text', text: '', stderr: false }, 'a = 1'));
    expect(hl).toHaveBeenCalledTimes(1);
    expect(hl.mock.calls[0][0]).toBe(root.querySelector('code'));
    expect(hl.mock.calls[0][1]).toBe('python');
  });

  it('names only plain-token languages and skips the highlighter otherwise', async () => {
    const lang = async (l: string) => {
      const { root, hl } = await draw({
        ...codeNb({ kind: 'text', text: '', stderr: false }),
        language: l,
        meta: NO_META,
      });
      return { cls: root.querySelector('code')!.className, called: hl.mock.calls.length };
    };
    expect(await lang('Python')).toEqual({ cls: 'language-python', called: 1 });
    expect(await lang('deno')).toEqual({ cls: 'language-typescript', called: 1 });
    expect(await lang('dataviewjs')).toEqual({ cls: 'language-dataviewjs', called: 1 });
    expect(await lang('py`thon')).toEqual({ cls: '', called: 0 });
    expect(await lang('')).toEqual({ cls: '', called: 0 });
  });

  it('renders code without a highlighter', () => {
    const root = document.createElement('div');
    renderNotebook(codeNb({ kind: 'text', text: '', stderr: false }, 'q'), root);
    expect(root.querySelector('code')!.textContent).toBe('q');
  });

  it('shows the traceback when there is one, else name: value, else nothing', async () => {
    const err = async (e: object) =>
      (
        await draw(codeNb({ kind: 'error', ename: '', evalue: '', traceback: '', ...e }))
      ).root.querySelector('.nbl-error')!.textContent;
    expect(await err({ ename: 'E', evalue: 'v', traceback: 'tb line\n' })).toBe('tb line');
    expect(await err({ ename: 'E', evalue: 'v' })).toBe('E: v');
    expect(await err({ evalue: 'only' })).toBe(': only');
    expect(await err({})).toBe('');
  });

  it('keeps expanded code cells open across a re-render', async () => {
    const nb: Notebook = {
      language: 'python',
      meta: NO_META,
      cells: [1, 2, 3].map(n => ({
        type: 'code' as const,
        id: null,
        source: String(n),
        executionCount: n,
        outputs: [],
      })),
    };
    const { root } = await draw(nb);
    root.querySelectorAll('details')[1].setAttribute('open', '');
    expect(captureOpen(root).map(o => o.open)).toEqual([false, true, false]);
    const next = document.createElement('div');
    renderNotebook(nb, next);
    applyOpen(next, captureOpen(root));
    expect([...next.querySelectorAll('details')].map(d => d.hasAttribute('open'))).toEqual([
      false,
      true,
      false,
    ]);
    // A notebook with fewer cells doesn't throw.
    const small = document.createElement('div');
    renderNotebook({ ...nb, cells: nb.cells.slice(0, 1) }, small);
    expect(() =>
      applyOpen(small, [
        { id: null, open: false },
        { id: null, open: true },
      ]),
    ).not.toThrow();
  });

  it('keys expanded state by cell id, so inserting a cell above keeps it', async () => {
    const cell = (id: string) => ({
      type: 'code' as const,
      id,
      source: id,
      executionCount: null,
      outputs: [],
    });
    const before = document.createElement('div');
    renderNotebook({ language: '', meta: NO_META, cells: [cell('a'), cell('b')] }, before);
    before.querySelectorAll('details')[1].setAttribute('open', '');
    const state = captureOpen(before);
    expect(state).toEqual([
      { id: 'a', open: false },
      { id: 'b', open: true },
    ]);
    expect(before.querySelectorAll('details')[1].getAttribute('data-cell-id')).toBe('b');
    const after = document.createElement('div');
    renderNotebook(
      { language: '', meta: NO_META, cells: [cell('new'), cell('a'), cell('b')] },
      after,
    );
    applyOpen(after, state);
    expect([...after.querySelectorAll('details')].map(d => d.hasAttribute('open'))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('omits the count for a cell that never ran', async () => {
    const nb = codeNb({ kind: 'text', text: '', stderr: false });
    if (nb.cells[0].type === 'code') nb.cells[0].executionCount = null;
    const { root } = await draw(nb);
    expect(root.querySelector('summary')!.textContent).toBe('Code');
  });

  it('shows a message for an empty notebook', async () => {
    const { root } = await draw({ language: '', meta: NO_META, cells: [] });
    expect(root.textContent).toContain('no cells');
  });
});

describe('untrusted Markdown through renderNotebook', () => {
  const evil = [
    '<script>window.x=1</script>',
    '<img src=x onerror=alert(1)>',
    '[a](javascript:alert(1))',
    '![h](https://x/y.png)',
    '<a href="javascript:alert(2)" onclick="alert(3)">b</a>',
  ].join('\n\n');

  function expectClean(root: HTMLElement) {
    expect(root.querySelector('script')).toBeNull();
    for (const el of root.querySelectorAll('*')) {
      expect(el.getAttributeNames().filter(n => n.startsWith('on'))).toEqual([]);
    }
    expect(root.innerHTML).not.toMatch(/onerror|onclick/i);
    for (const img of root.querySelectorAll('img')) {
      expect(img.getAttribute('src')).toMatch(/^data:/);
    }
    for (const a of root.querySelectorAll('a')) {
      expect(a.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
    }
    // The http image is text, the link text stays.
    expect(root.textContent).toContain('h');
    expect(root.textContent).toContain('a');
  }

  it('a markdown cell', async () => {
    const { root } = await draw({
      language: '',
      meta: NO_META,
      cells: [{ type: 'markdown', id: null, source: evil, attachments: {} }],
    });
    expectClean(root);
  });

  it('a text/markdown output', async () => {
    const { root } = await draw(codeNb({ kind: 'markdown', markdown: evil }));
    expectClean(root.querySelector('.nbl-output') as HTMLElement);
  });
});

describe('renderError', () => {
  it('shows the message as text', () => {
    const root = document.createElement('div');
    renderError(root, 'Bad <b>thing</b>');
    expect(root.textContent).toContain('Bad <b>thing</b>');
    expect(root.querySelector('b')).toBeNull();
  });
});

describe('renderNotebook options', () => {
  const text = (t: string) => ({ kind: 'text' as const, text: t, stderr: false });
  const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

  it('marks every cell with its index and id', async () => {
    const nb: Notebook = {
      language: '',
      meta: NO_META,
      cells: [
        { type: 'markdown', id: 'm', source: 'x', attachments: {} },
        { type: 'code', id: null, source: 'y', executionCount: null, outputs: [] },
        { type: 'raw', id: 'r', source: 'z' },
      ],
    };
    const { root } = await draw(nb);
    const cells = Array.from(root.querySelectorAll('.nbl-cell'));
    expect(cells.map(c => c.getAttribute('data-cell-index'))).toEqual(['0', '1', '2']);
    expect(cells.map(c => c.getAttribute('data-cell-id'))).toEqual(['m', null, 'r']);
  });

  it('renders only the chosen cells, keeping their notebook indexes', () => {
    const nb = parseNotebook(
      JSON.stringify({
        nbformat: 4,
        cells: ['a', 'b', 'c'].map(s => ({ cell_type: 'markdown', source: s })),
      }),
    );
    const root = document.createElement('div');
    renderNotebook(nb, root, undefined, { cells: [1, 2] });
    const cells = Array.from(root.querySelectorAll('.nbl-cell'));
    expect(cells.map(c => [c.getAttribute('data-cell-index'), c.textContent!.trim()])).toEqual([
      ['1', 'b'],
      ['2', 'c'],
    ]);
  });

  it('opens code cells when folding is off, and hides counts when asked', () => {
    const root = document.createElement('div');
    renderNotebook(codeNb(text('o')), root, undefined, { foldCode: false, showCounts: false });
    const d = root.querySelector('details')!;
    expect(d.hasAttribute('open')).toBe(true);
    expect(d.querySelector('.nbl-count')).toBeNull();
    const dflt = document.createElement('div');
    renderNotebook(codeNb(text('o')), dflt);
    expect(dflt.querySelector('details')!.hasAttribute('open')).toBe(false);
    expect(dflt.querySelector('.nbl-count')!.textContent).toBe(' [3]');
  });

  it('caps a long text output and reveals the rest from a button', () => {
    const root = document.createElement('div');
    renderNotebook(codeNb(text(numbered(100))), root, undefined, { maxOutputLines: 40 });
    const pre = root.querySelector('.nbl-output pre')!;
    expect(pre.textContent!.split('\n')).toHaveLength(40);
    const button = root.querySelector<HTMLButtonElement>('button.nbl-more')!;
    expect(button.textContent).toBe('Show 60 more lines');
    button.click();
    expect(pre.textContent).toBe(numbered(100));
    expect(root.querySelector('button.nbl-more')).toBeNull();
  });

  it('does not cap at exactly the limit, with 0, or by default', () => {
    for (const [lines, max] of [
      [40, 40],
      [100, 0],
      [100, undefined],
    ] as const) {
      const root = document.createElement('div');
      renderNotebook(codeNb(text(numbered(lines))), root, undefined, { maxOutputLines: max });
      expect(root.querySelector('button.nbl-more')).toBeNull();
      expect(root.querySelector('.nbl-output pre')!.textContent!.split('\n')).toHaveLength(lines);
    }
  });

  it('caps error output too, and keeps the button text free of notebook content', () => {
    const root = document.createElement('div');
    renderNotebook(
      codeNb({ kind: 'error', ename: 'E', evalue: 'v', traceback: numbered(50) }),
      root,
      undefined,
      { maxOutputLines: 5 },
    );
    expect(root.querySelector('pre.nbl-error')!.textContent!.split('\n')).toHaveLength(5);
    expect(root.querySelector('button.nbl-more')!.textContent).toBe('Show 45 more lines');
  });

  it('puts notebook-supplied header text in textContent only', () => {
    const root = document.createElement('div');
    renderNotebook(codeNb(text('o')), root, undefined, {
      header: {
        title: '<img src=x onerror=alert(1)>',
        kernel: '<script>1</script>',
        lastRun: Date.parse('2025-01-01T00:00:00Z'),
        tags: ['<i>t</i>'],
      },
    });
    const header = root.querySelector('.nbl-header')!;
    expect(header.querySelector('img, script, i')).toBeNull();
    expect(header.querySelector('.nbl-title')!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(header.querySelector('.nbl-tag')!.textContent).toBe('<i>t</i>');
    expect(header.textContent).toContain('Kernel: <script>1</script>');
  });

  it('omits the facts row when the header has nothing but a title', () => {
    const root = document.createElement('div');
    renderNotebook(codeNb(text('o')), root, undefined, {
      header: { title: 'T', kernel: null, lastRun: null, tags: [] },
    });
    expect(root.querySelector('.nbl-facts')).toBeNull();
    expect(root.querySelector('.nbl-title')!.textContent).toBe('T');
  });
});
