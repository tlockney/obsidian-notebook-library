import { describe, expect, it } from 'vitest';
import {
  basenameOf,
  indexNotebook,
  makeSnippet,
  MAX_INDEX_BYTES,
  NotebookIndex,
  queryWords,
} from './search.ts';

function notebook(cells: object[]): string {
  return JSON.stringify({ nbformat: 4, metadata: {}, cells });
}
const md = (source: string, id?: string) => ({ cell_type: 'markdown', source, id });
const code = (source: string, outputs: object[] = [], id?: string) => ({
  cell_type: 'code',
  source,
  outputs,
  id,
});
const stream = (text: string) => ({ output_type: 'stream', name: 'stdout', text });

describe('indexNotebook', () => {
  it('indexes the source of every cell and the text outputs of code cells', () => {
    const e = indexNotebook(
      'a/My Note.ipynb',
      notebook([
        md('# Hi', 'm1'),
        code('x = 1', [
          stream('out\n'),
          { output_type: 'execute_result', data: { 'text/plain': 'plain', 'image/png': 'AAAA' } },
          {
            output_type: 'display_data',
            data: { 'text/html': '<b>html</b>', 'text/plain': 'fallback' },
          },
          { output_type: 'error', ename: 'E', evalue: 'v', traceback: ['tb'] },
        ]),
        { cell_type: 'raw', source: 'raw text' },
      ]),
    )!;
    expect(e.basename).toBe('My Note');
    expect(e.cells.map(c => [c.index, c.id, c.kind, c.source])).toEqual([
      [0, 'm1', 'markdown', '# Hi'],
      [1, null, 'code', 'x = 1'],
      [2, null, 'raw', 'raw text'],
    ]);
    // The image wins over its text/plain, as it does when drawing; HTML does too.
    expect(e.cells[1].output).toBe('out\n');
    expect(e.cells[0].headings).toEqual(['Hi']);
    expect(e.cells[2].output).toBe('');
  });

  it('keeps text/plain when it is the chosen representation', () => {
    const e = indexNotebook(
      'n.ipynb',
      notebook([code('1', [{ output_type: 'execute_result', data: { 'text/plain': '42' } }])]),
    )!;
    expect(e.cells[0].output).toBe('42');
  });

  it('returns null for a notebook that cannot be parsed', () => {
    expect(indexNotebook('n.ipynb', '{nope')).toBeNull();
    expect(indexNotebook('n.ipynb', '{"nbformat":3}')).toBeNull();
  });
});

describe('basenameOf', () => {
  it('drops the folder and the .ipynb extension', () => {
    expect(basenameOf('a/b/c d.ipynb')).toBe('c d');
    expect(basenameOf('x.IPYNB')).toBe('x');
    expect(basenameOf('x.v2.ipynb')).toBe('x.v2');
  });
});

describe('queryWords', () => {
  it('lowercases, splits on whitespace and drops empties and repeats', () => {
    expect(queryWords('  Foo  bar\tFOO\n')).toEqual(['foo', 'bar']);
    expect(queryWords('   ')).toEqual([]);
  });
});

describe('makeSnippet', () => {
  const text = (s: ReturnType<typeof makeSnippet>) => s!.map(x => x.text).join('');

  it('marks every word in a window around the first match', () => {
    const s = makeSnippet('The quick brown fox jumps over the lazy dog', ['fox', 'dog'])!;
    expect(s.filter(x => x.match).map(x => x.text)).toEqual(['fox', 'dog']);
    expect(text(s)).toBe('The quick brown fox jumps over the lazy dog');
  });

  it('keeps the original case in the shown text', () => {
    const s = makeSnippet('Hello WORLD', ['world'])!;
    expect(s).toEqual([
      { text: 'Hello ', match: false },
      { text: 'WORLD', match: true },
    ]);
  });

  it('cuts long text with ellipses and puts the first match in view', () => {
    const long = `${'a '.repeat(200)}needle${' b'.repeat(200)}`;
    const s = makeSnippet(long, ['needle'])!;
    expect(text(s).startsWith('…')).toBe(true);
    expect(text(s).endsWith('…')).toBe(true);
    expect(text(s).length).toBeLessThan(140);
    expect(s.some(x => x.match && x.text === 'needle')).toBe(true);
  });

  it('flattens newlines and returns null without a match', () => {
    expect(text(makeSnippet('a\n\n  b needle', ['needle']))).toBe('a b needle');
    expect(makeSnippet('abc', ['zzz'])).toBeNull();
  });

  it('copes with text whose lowercase form has a different length', () => {
    const s = makeSnippet('İstanbul city', ['city']);
    expect(s!.some(x => x.match && x.text === 'city')).toBe(true);
  });

  it('does not duplicate text when words overlap', () => {
    expect(text(makeSnippet('foobar', ['foo', 'foobar', 'bar']))).toBe('foobar');
  });
});

describe('NotebookIndex.search', () => {
  function build() {
    const idx = new NotebookIndex();
    idx.set(
      'stats.ipynb',
      notebook([
        md('# Regression analysis\nWe fit a model.', 'intro'),
        code('model = fit(data)', [stream('R squared: 0.93\n')], 'fit'),
        code('plot(model)', [], 'plot'),
      ]),
    );
    idx.set(
      'notes/model.ipynb',
      notebook([md('A model is a simplification.'), code('print("hello")', [stream('hello\n')])]),
    );
    return idx;
  }

  it('needs every word in one cell, in any order, ignoring case', () => {
    const idx = build();
    expect(idx.search('FIT model', { outputs: true }).map(h => h.cell.id)).toEqual([
      'intro',
      'fit',
    ]);
    expect(idx.search('fit simplification', { outputs: true })).toEqual([]);
    expect(idx.search('   ', { outputs: true })).toEqual([]);
  });

  it('searches outputs only when asked', () => {
    const idx = build();
    const withOut = idx.search('squared', { outputs: true });
    expect(withOut).toHaveLength(1);
    expect(withOut[0].field).toBe('output');
    expect(withOut[0].snippet.some(s => s.match && s.text === 'squared')).toBe(true);
    expect(idx.search('squared', { outputs: false })).toEqual([]);
  });

  it('matches a word in the source and another in the output of the same cell', () => {
    const hits = build().search('fit squared', { outputs: true });
    expect(hits.map(h => h.cell.id)).toEqual(['fit']);
    expect(hits[0].field).toBe('source');
  });

  it('ranks file-name hits and heading hits above plain mentions', () => {
    const idx = build();
    const hits = idx.search('model', { outputs: true });
    // notes/model.ipynb: name hit (10) + 1; stats fit cell: 2 mentions; plot: 1; intro: 1 + heading none.
    expect(hits[0].path).toBe('notes/model.ipynb');
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    const heading = idx.search('regression', { outputs: true });
    expect(heading[0].cell.id).toBe('intro');
    const [plain] = idx.search('fit', { outputs: true });
    expect(heading[0].score).toBeGreaterThan(plain.score - 1);
  });

  it('ranks more occurrences higher, capped, and breaks ties by path then cell order', () => {
    const idx = new NotebookIndex();
    idx.set('b.ipynb', notebook([md('x'), md('x')]));
    idx.set('a.ipynb', notebook([md('x x x x x x x x x x')]));
    const hits = idx.search('x', { outputs: false });
    // a: capped at 5; b cells: 1 each.
    expect(hits.map(h => [h.path, h.cell.index, h.score])).toEqual([
      ['a.ipynb', 0, 5],
      ['b.ipynb', 0, 1],
      ['b.ipynb', 1, 1],
    ]);
  });

  it('limits the number of hits', () => {
    const idx = new NotebookIndex();
    idx.set('a.ipynb', notebook(Array.from({ length: 10 }, () => md('word'))));
    expect(idx.search('word', { outputs: false, limit: 3 })).toHaveLength(3);
    expect(idx.search('word', { outputs: false })).toHaveLength(10);
  });
});

describe('NotebookIndex upkeep', () => {
  it('replaces, removes and forgets unreadable notebooks', () => {
    const idx = new NotebookIndex();
    idx.set('a.ipynb', notebook([md('alpha')]));
    expect(idx.search('alpha', { outputs: false })).toHaveLength(1);
    idx.set('a.ipynb', notebook([md('beta')]));
    expect(idx.search('alpha', { outputs: false })).toHaveLength(0);
    expect(idx.search('beta', { outputs: false })).toHaveLength(1);
    idx.set('a.ipynb', '{broken');
    expect(idx.has('a.ipynb')).toBe(false);
    idx.set('a.ipynb', notebook([md('beta')]));
    idx.remove('a.ipynb');
    expect(idx.size).toBe(0);
  });

  it('records files over the size cap and clears the note when they are indexed again', () => {
    const idx = new NotebookIndex();
    idx.markSkipped('big.ipynb', MAX_INDEX_BYTES + 1);
    expect(idx.skippedFiles()).toEqual([['big.ipynb', MAX_INDEX_BYTES + 1]]);
    expect(idx.has('big.ipynb')).toBe(false);
    idx.set('big.ipynb', notebook([md('now small')]));
    expect(idx.skippedFiles()).toEqual([]);
    idx.markSkipped('big.ipynb', MAX_INDEX_BYTES + 1);
    expect(idx.has('big.ipynb')).toBe(false);
  });

  it('lists paths under a folder, not a sibling with the same prefix', () => {
    const idx = new NotebookIndex();
    idx.set('dir/a.ipynb', notebook([]));
    idx.set('dir2/b.ipynb', notebook([]));
    idx.markSkipped('dir/big.ipynb', 1);
    expect(idx.pathsUnder('dir').sort()).toEqual(['dir/a.ipynb', 'dir/big.ipynb']);
  });
});
