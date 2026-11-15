import { describe, expect, it } from 'vitest';
import type { Notebook } from './notebook.ts';
import {
  cellIndexById,
  markdownHeadings,
  normalizeHeading,
  notebookHeadings,
  parseSubpath,
  resolveTarget,
  selectCells,
  splitLinkText,
  targetFromState,
} from './outline.ts';

const META = { title: null, kernel: null, tags: [], lastRun: null };

function nb(...cells: ([string, string | null, string] | [string, string | null])[]): Notebook {
  return {
    language: 'python',
    meta: META,
    cells: cells.map(([type, id, source = '']) =>
      type === 'code'
        ? { type: 'code', id, source, executionCount: null, outputs: [] }
        : type === 'raw'
          ? { type: 'raw', id, source }
          : { type: 'markdown', id, source, attachments: {} },
    ) as Notebook['cells'],
  };
}

describe('markdownHeadings', () => {
  it('reads ATX headings with their level and plain text', () => {
    expect(markdownHeadings('# One\ntext\n## Two ##\n###### Six\n####### seven')).toEqual([
      { level: 1, text: 'One' },
      { level: 2, text: 'Two' },
      { level: 6, text: 'Six' },
    ]);
  });

  it('strips emphasis, code and link syntax from the text', () => {
    expect(markdownHeadings('# **Bold** `code` [link](http://x) ![i](y.png)')).toEqual([
      { level: 1, text: 'Bold code link i' },
    ]);
  });

  it('ignores headings inside fenced code, and recovers after the fence closes', () => {
    const src =
      '# a\n```python\n# comment\n```\n# b\n~~~\n# in tilde\n~~~\n````\n```\n# still code\n````\n# c';
    expect(markdownHeadings(src).map(h => h.text)).toEqual(['a', 'b', 'c']);
  });

  it('does not close a fence with a different character or a shorter run', () => {
    expect(markdownHeadings('```\n~~~\n# x\n``\n```\n# y').map(h => h.text)).toEqual(['y']);
  });

  it('ignores what is not a heading: no space, indented code, empty, tab-less hash', () => {
    expect(markdownHeadings('#nospace\n    # indented\n#\n##   \n  # ok\n#\tTab')).toEqual([
      { level: 1, text: 'ok' },
      { level: 1, text: 'Tab' },
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(markdownHeadings('# a\r\ntext\r\n## b\r\n').map(h => h.text)).toEqual(['a', 'b']);
  });
});

describe('notebookHeadings', () => {
  it('lists headings of Markdown cells only, with their cell index', () => {
    const n = nb(
      ['markdown', null, '# A'],
      ['code', null, '# not a heading'],
      ['raw', null, '# raw'],
      ['markdown', null, 'x\n## B'],
    );
    expect(notebookHeadings(n)).toEqual([
      { cellIndex: 0, level: 1, text: 'A' },
      { cellIndex: 3, level: 2, text: 'B' },
    ]);
  });
});

describe('parseSubpath', () => {
  it.each([
    ['#Heading', { kind: 'heading', path: ['Heading'] }],
    ['Heading', { kind: 'heading', path: ['Heading'] }],
    ['#A#B', { kind: 'heading', path: ['A', 'B'] }],
    ['#Two words', { kind: 'heading', path: ['Two words'] }],
    ['#^abc-1', { kind: 'block', id: 'abc-1' }],
  ])('%s', (raw, expected) => {
    expect(parseSubpath(raw)).toEqual(expected);
  });

  it.each([[''], ['#'], ['#^'], ['##'], [undefined], [3], [null]])('rejects %j', raw => {
    expect(parseSubpath(raw)).toBeNull();
  });
});

describe('normalizeHeading', () => {
  it('ignores case, repeated spaces and the marks Obsidian strips from links', () => {
    expect(normalizeHeading('  Hello   World ')).toBe('hello world');
    expect(normalizeHeading('A: B | C #1 [x] ^y %')).toBe('a b c 1 x y');
  });
});

describe('selectCells', () => {
  const n = nb(
    ['markdown', 'title', '# Title'], // 0
    ['code', 'c1', 'x'], // 1
    ['markdown', 'sec', '## Section'], // 2
    ['code', 'c2', 'y'], // 3
    ['markdown', 'sub', '### Sub'], // 4
    ['code', 'c3', 'z'], // 5
    ['markdown', 'sec2', '## Section 2'], // 6
    ['code', 'c4', 'w'], // 7
    ['markdown', 'top', '# Top 2'], // 8
  );
  const heading = (...path: string[]) => selectCells(n, { kind: 'heading', path });
  const block = (id: string) => selectCells(n, { kind: 'block', id });

  it('runs a section to the next heading of the same or a higher level', () => {
    expect(heading('Section')).toEqual([2, 3, 4, 5]);
    expect(heading('Sub')).toEqual([4, 5]);
    expect(heading('Section 2')).toEqual([6, 7]);
    expect(heading('Title')).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('runs the last section to the end of the notebook', () => {
    expect(heading('Top 2')).toEqual([8]);
  });

  it('matches case-insensitively and finds a nested heading after its parent', () => {
    expect(heading('section')).toEqual([2, 3, 4, 5]);
    expect(heading('Section', 'Sub')).toEqual([4, 5]);
    expect(heading('Section 2', 'Sub')).toBeNull();
  });

  it('selects one cell by id, exact first, then ignoring case', () => {
    expect(block('c2')).toEqual([3]);
    expect(block('C2')).toEqual([3]);
    expect(block('sec')).toEqual([2]);
  });

  it('returns null for a heading or id that is not there', () => {
    expect(heading('Missing')).toBeNull();
    expect(block('nope')).toBeNull();
    expect(
      selectCells(nb(['code', 'c', '# Not a heading']), {
        kind: 'heading',
        path: ['Not a heading'],
      }),
    ).toBeNull();
  });

  it('ends a section at a later same-level heading in the same cell as the next heading', () => {
    const m = nb(['markdown', null, '## A'], ['markdown', null, 'text\n## B'], ['code', null, 'x']);
    expect(selectCells(m, { kind: 'heading', path: ['A'] })).toEqual([0]);
    expect(selectCells(m, { kind: 'heading', path: ['B'] })).toEqual([1, 2]);
  });
});

describe('cellIndexById', () => {
  it('finds markdown, code and raw cells', () => {
    const n = nb(['markdown', 'm'], ['code', 'c'], ['raw', 'r'], ['code', null]);
    expect([cellIndexById(n, 'm'), cellIndexById(n, 'c'), cellIndexById(n, 'r')]).toEqual([
      0, 1, 2,
    ]);
    expect(cellIndexById(n, 'x')).toBeNull();
  });
});

describe('targetFromState and resolveTarget', () => {
  const n = nb(['markdown', 'a', '# A'], ['code', 'b', 'x'], ['markdown', null, '## C']);

  it('reads a link subpath and a search hit', () => {
    expect(targetFromState({ subpath: '#C' })).toEqual({
      kind: 'subpath',
      subpath: { kind: 'heading', path: ['C'] },
    });
    expect(targetFromState({ notebookCell: { id: 'b', index: 1 } })).toEqual({
      kind: 'cell',
      id: 'b',
      index: 1,
    });
    expect(targetFromState({ notebookCell: { index: 2 } })).toEqual({
      kind: 'cell',
      id: null,
      index: 2,
    });
  });

  it.each([
    [null],
    ['x'],
    [{}],
    [{ subpath: '' }],
    [{ notebookCell: {} }],
    [{ notebookCell: { index: -1 } }],
  ])('finds no target in %j', s => {
    expect(targetFromState(s)).toBeNull();
  });

  it('prefers the cell id over a stale index, falls back to the index, and checks the range', () => {
    expect(resolveTarget(n, { kind: 'cell', id: 'b', index: 0 })).toBe(1);
    expect(resolveTarget(n, { kind: 'cell', id: 'gone', index: 2 })).toBe(2);
    expect(resolveTarget(n, { kind: 'cell', id: null, index: 9 })).toBeNull();
    expect(resolveTarget(n, { kind: 'subpath', subpath: { kind: 'heading', path: ['C'] } })).toBe(
      2,
    );
    expect(resolveTarget(n, { kind: 'subpath', subpath: { kind: 'block', id: 'a' } })).toBe(0);
  });
});

describe('splitLinkText', () => {
  it.each([
    ['nb.ipynb', 'nb.ipynb', ''],
    ['dir/nb.ipynb#Head', 'dir/nb.ipynb', '#Head'],
    ['nb.ipynb#^id', 'nb.ipynb', '#^id'],
    ['nb.ipynb#A#B', 'nb.ipynb', '#A#B'],
    ['nb.ipynb#Head|400', 'nb.ipynb', '#Head'],
    ['nb.ipynb|alias', 'nb.ipynb', ''],
  ])('%s', (src, path, subpath) => {
    expect(splitLinkText(src)).toEqual({ path, subpath });
  });
});
