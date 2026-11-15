import { describe, expect, it, vi } from 'vitest';
import { TFile } from './test/obsidian-stub.ts';
import { NotebookLibrary } from './library.ts';
import { SearchModal } from './searchmodal.ts';
import { MAX_INDEX_BYTES } from './search.ts';

const nb = (cells: object[]) => JSON.stringify({ nbformat: 4, cells });

function setup(searchOutputs = true) {
  const file = new TFile('dir/Study.ipynb');
  const openFile = vi.fn(async () => {});
  const app = {
    vault: {
      getFiles: () => [file],
      cachedRead: async () =>
        nb([
          { cell_type: 'markdown', id: 'm1', source: '# Study\nfindings <b>here</b>' },
          {
            cell_type: 'code',
            id: 'c1',
            source: 'run()',
            outputs: [{ output_type: 'stream', name: 'stdout', text: 'secret result\n' }],
          },
        ]),
      getAbstractFileByPath: (p: string) => (p === file.path ? file : null),
      on: () => ({}),
    },
    workspace: { getLeaf: () => ({ openFile }) },
  };
  const library = new NotebookLibrary(app as never);
  const host = { app: app as never, library, settings: { searchOutputs } };
  return { modal: new SearchModal(host), library, openFile, file };
}

describe('SearchModal', () => {
  it('waits for the index, then returns ranked hits', async () => {
    const { modal } = setup();
    const hits = await modal.getSuggestions('findings');
    expect(hits.map(h => h.cell.id)).toEqual(['m1']);
  });

  it('follows the "search text outputs" setting', async () => {
    expect((await setup(true).modal.getSuggestions('secret')).map(h => h.cell.id)).toEqual(['c1']);
    expect(await setup(false).modal.getSuggestions('secret')).toEqual([]);
  });

  it('renders file name, cell kind and snippet with textContent only', async () => {
    const { modal } = setup();
    const [hit] = await modal.getSuggestions('here');
    const el = document.createElement('div');
    modal.renderSuggestion(hit, el);
    expect(el.querySelector('.nbl-hit-title')!.textContent).toBe('Study · Markdown cell 1');
    const snippet = el.querySelector('.nbl-hit-snippet')!;
    expect(snippet.querySelector('b')).toBeNull();
    expect(snippet.textContent).toContain('findings <b>here</b>');
    expect(Array.from(snippet.querySelectorAll('mark')).map(m => m.textContent)).toEqual(['here']);
  });

  it('labels an output match', async () => {
    const { modal } = setup();
    const [hit] = await modal.getSuggestions('secret');
    const el = document.createElement('div');
    modal.renderSuggestion(hit, el);
    expect(el.querySelector('.nbl-hit-title')!.textContent).toBe('Study · Code cell 2 (output)');
  });

  it('opens the notebook with the cell id and index in its state', async () => {
    const { modal, openFile, file } = setup();
    const [hit] = await modal.getSuggestions('secret');
    modal.onChooseSuggestion(hit);
    await vi.waitFor(() => expect(openFile).toHaveBeenCalled());
    expect(openFile).toHaveBeenCalledWith(file, {
      eState: { notebookCell: { id: 'c1', index: 1 } },
    });
  });

  it('tells the person when notebooks were too large to search', async () => {
    const { modal, library } = setup();
    await library.ready();
    library.index.markSkipped('huge.ipynb', MAX_INDEX_BYTES + 1);
    await modal.getSuggestions('nothing-here');
    expect(modal.emptyStateText).toBe('No matching cells. 1 notebook over 20 MB was not searched.');
    library.index.markSkipped('huge2.ipynb', MAX_INDEX_BYTES + 1);
    await modal.getSuggestions('nothing-here');
    expect(modal.emptyStateText).toContain('2 notebooks over 20 MB were not searched');
  });
});
