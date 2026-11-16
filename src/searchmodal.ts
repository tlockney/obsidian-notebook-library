import { SuggestModal } from 'obsidian';
import type { App } from 'obsidian';
import type { NotebookLibrary } from './library.ts';
import { CELL_STATE_KEY } from './outline.ts';
import { openNotebook } from './navigate.ts';
import { MAX_INDEX_BYTES } from './search.ts';
import type { SearchHit } from './search.ts';

export interface SearchHost {
  app: App;
  library: NotebookLibrary;
  settings: { searchOutputs: boolean };
}

const KIND_LABEL = { markdown: 'Markdown', code: 'Code', raw: 'Raw' } as const;

export class SearchModal extends SuggestModal<SearchHit> {
  constructor(private readonly host: SearchHost) {
    super(host.app);
    this.setPlaceholder('Search notebooks: every word must be in one cell');
    this.emptyStateText = 'No matching cells.';
  }

  async getSuggestions(query: string): Promise<SearchHit[]> {
    await this.host.library.ready();
    const skipped = this.host.library.index.skippedFiles().length;
    this.emptyStateText =
      skipped > 0
        ? `No matching cells. ${skipped} notebook${skipped === 1 ? '' : 's'} over ${MAX_INDEX_BYTES / 1024 / 1024} MB ${skipped === 1 ? 'was' : 'were'} not searched.`
        : 'No matching cells.';
    return this.host.library.index.search(query, { outputs: this.host.settings.searchOutputs });
  }

  /** Everything from the notebook is set with textContent. */
  renderSuggestion(hit: SearchHit, el: HTMLElement): void {
    const doc = el.ownerDocument;
    const title = doc.createElement('div');
    title.className = 'nbl-hit-title';
    title.textContent = `${hit.basename} · ${KIND_LABEL[hit.cell.kind]} cell ${hit.cell.index + 1}${hit.field === 'output' ? ' (output)' : ''}`;
    const snippet = doc.createElement('div');
    snippet.className = 'nbl-hit-snippet';
    for (const seg of hit.snippet) {
      if (seg.match) {
        const mark = doc.createElement('mark');
        mark.textContent = seg.text;
        snippet.appendChild(mark);
      } else {
        snippet.append(doc.createTextNode(seg.text));
      }
    }
    el.append(title, snippet);
  }

  onChooseSuggestion(hit: SearchHit): void {
    void openNotebook(this.host.app, hit.path, {
      [CELL_STATE_KEY]: { id: hit.cell.id, index: hit.cell.index },
    });
  }
}
