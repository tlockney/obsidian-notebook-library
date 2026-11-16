import { ItemView } from 'obsidian';
import type { WorkspaceLeaf } from 'obsidian';
import type { NotebookView } from './view.ts';

export const OUTLINE_VIEW_TYPE = 'notebook-library-outline';

export interface OutlineHost {
  /** The notebook view the outline follows, or null when none is open. */
  currentNotebookView(): NotebookView | null;
}

export class OutlineView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: OutlineHost,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return OUTLINE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Notebook outline';
  }

  getIcon(): string {
    return 'list';
  }

  onOpen(): Promise<void> {
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refresh()));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.refresh()));
    this.refresh();
    return Promise.resolve();
  }

  /** Draw the headings of the active notebook; every text is set with textContent. */
  refresh(): void {
    const root = this.contentEl;
    root.replaceChildren();
    root.classList.add('nbl-outline');
    const doc = root.ownerDocument;
    const view = this.host.currentNotebookView();
    const headings = view?.headings ?? [];
    if (!view || headings.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'nbl-outline-empty';
      empty.textContent = view
        ? 'No headings in this notebook.'
        : 'Open a notebook to see its outline.';
      root.appendChild(empty);
      return;
    }
    const minLevel = Math.min(...headings.map(h => h.level));
    for (const h of headings) {
      const item = doc.createElement('div');
      item.className = 'nbl-outline-item';
      item.style.paddingLeft = `${(h.level - minLevel) * 16 + 8}px`;
      item.textContent = h.text;
      item.addEventListener('click', () => view.scrollToCell(h.cellIndex));
      root.appendChild(item);
    }
  }
}
