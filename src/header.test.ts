import { describe, expect, it } from 'vitest';
import { notebookHeader } from './header.ts';
import { parseNotebook } from './notebook.ts';

const nbText = (metadata: object, cells: object[] = []) =>
  JSON.stringify({ nbformat: 4, metadata, cells });

describe('notebookHeader', () => {
  it('prefers metadata.title, then the first H1 of the first Markdown cell, then the file name', () => {
    const md = (source: string) => ({ cell_type: 'markdown', source });
    expect(
      notebookHeader(parseNotebook(nbText({ title: ' Meta ' }, [md('# H1')])), 'f').title,
    ).toBe('Meta');
    expect(notebookHeader(parseNotebook(nbText({}, [md('text\n# H1\n## H2')])), 'f').title).toBe(
      'H1',
    );
    expect(notebookHeader(parseNotebook(nbText({}, [md('## only H2')])), 'file').title).toBe(
      'file',
    );
    expect(notebookHeader(parseNotebook(nbText({}, [])), 'file').title).toBe('file');
  });

  it('looks only at the first Markdown cell, and skips a code cell before it', () => {
    const cells = [
      { cell_type: 'code', source: '# comment' },
      { cell_type: 'markdown', source: 'no heading' },
      { cell_type: 'markdown', source: '# Later' },
    ];
    expect(notebookHeader(parseNotebook(nbText({}, cells)), 'file').title).toBe('file');
  });

  it('ignores an H1 inside a fenced block', () => {
    const cells = [{ cell_type: 'markdown', source: '```\n# no\n```' }];
    expect(notebookHeader(parseNotebook(nbText({}, cells)), 'file').title).toBe('file');
  });

  it('reads the kernel display name, else the language', () => {
    const k = (m: object) => notebookHeader(parseNotebook(nbText(m)), 'f').kernel;
    expect(k({ kernelspec: { display_name: 'Python 3', name: 'python3' } })).toBe('Python 3');
    expect(k({ language_info: { name: 'julia' } })).toBe('julia');
    expect(k({ kernelspec: { display_name: '' }, language_info: { name: 'r' } })).toBe('r');
    expect(k({})).toBeNull();
    expect(k({ kernelspec: { display_name: 5 } })).toBeNull();
  });

  it('takes the latest execution time of any cell, from either timestamp', () => {
    const code = (execution: object | undefined) => ({
      cell_type: 'code',
      source: '',
      metadata: execution === undefined ? {} : { execution },
    });
    const h = (cells: object[]) => notebookHeader(parseNotebook(nbText({}, cells)), 'f').lastRun;
    expect(
      h([
        code({ 'iopub.execute_input': '2025-01-01T00:00:00Z' }),
        code({
          'shell.execute_reply': '2025-03-01T00:00:00Z',
          'iopub.execute_input': '2025-02-01T00:00:00Z',
        }),
        code(undefined),
      ]),
    ).toBe(Date.parse('2025-03-01T00:00:00Z'));
    expect(h([code({ 'iopub.execute_input': 'not a date' }), code(undefined)])).toBeNull();
    expect(h([])).toBeNull();
    expect(
      h([
        {
          cell_type: 'markdown',
          source: '',
          metadata: { execution: { 'iopub.execute_input': '2025-01-01T00:00:00Z' } },
        },
      ]),
    ).toBeNull();
  });

  it('collects string tags from metadata.tags and metadata.ganymede.tags, dropping other values', () => {
    const t = (m: object) => notebookHeader(parseNotebook(nbText(m)), 'f').tags;
    expect(t({ tags: ['a', 'b'], ganymede: { tags: ['b', 'c'] } })).toEqual(['a', 'b', 'c']);
    expect(t({ tags: ['a', 1, null, '', { x: 1 }] })).toEqual(['a']);
    expect(t({ tags: 'a', ganymede: 'x' })).toEqual([]);
    expect(t({ ganymede: { tags: 'x' } })).toEqual([]);
    expect(t({})).toEqual([]);
  });
});
