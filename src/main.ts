import { Notice, Plugin } from 'obsidian';
import { registerNotebookEmbeds } from './embeds.ts';
import type { NotebookEmbed } from './embeds.ts';
import { NotebookLibrary } from './library.ts';
import { OUTLINE_VIEW_TYPE, OutlineView } from './outlineview.ts';
import { prismHighlighter } from './prism.ts';
import { SearchModal } from './searchmodal.ts';
import { mergeSettings } from './settings.ts';
import type { Settings } from './settings.ts';
import { NotebookSettingTab } from './settingstab.ts';
import { NotebookView, VIEW_TYPE } from './view.ts';

export default class NotebookLibraryPlugin extends Plugin {
  settings: Settings = mergeSettings(null);
  library!: NotebookLibrary;
  readonly embeds = new Set<NotebookEmbed>();
  private lastView: NotebookView | null = null;
  private highlight: ReturnType<typeof prismHighlighter> | undefined;

  async onload(): Promise<void> {
    this.settings = mergeSettings(await this.loadData());
    this.library = new NotebookLibrary(this.app);

    this.registerView(VIEW_TYPE, leaf => new NotebookView(leaf, this));
    this.registerView(OUTLINE_VIEW_TYPE, leaf => new OutlineView(leaf, this));
    try {
      this.registerExtensions(['ipynb'], VIEW_TYPE);
    } catch (e) {
      console.error('Notebook Library: could not register .ipynb', e);
      new Notice('Notebook Library: another plugin already opens .ipynb files');
    }

    this.addSettingTab(new NotebookSettingTab(this.app, this));
    this.library.start(this);
    registerNotebookEmbeds(this, this);

    this.addCommand({
      id: 'search-notebooks',
      name: 'Search notebooks',
      callback: () => new SearchModal(this).open(),
    });
    this.addCommand({
      id: 'show-outline',
      name: 'Show notebook outline',
      callback: () => void this.showOutline(),
    });
  }

  /** Prism is loaded once for all embeds. */
  highlighter() {
    return (this.highlight ??= prismHighlighter());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof NotebookView) leaf.view.refresh();
    }
    for (const embed of this.embeds) void embed.render();
  }

  /** The notebook view the outline follows: the active one, else the last one still open. */
  currentNotebookView(): NotebookView | null {
    const open = this.app.workspace
      .getLeavesOfType(VIEW_TYPE)
      .map(l => l.view)
      .filter((v): v is NotebookView => v instanceof NotebookView);
    const active = this.app.workspace.getActiveViewOfType(NotebookView);
    if (active) this.lastView = active;
    if (this.lastView && open.includes(this.lastView)) return this.lastView;
    return open[0] ?? null;
  }

  /** A notebook view finished rendering: tell the outline. */
  onRendered(view: NotebookView): void {
    if (this.app.workspace.getActiveViewOfType(NotebookView) === view) this.lastView = view;
    for (const leaf of this.app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE)) {
      if (leaf.view instanceof OutlineView) leaf.view.refresh();
    }
  }

  private async showOutline(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(OUTLINE_VIEW_TYPE)[0];
    if (!leaf) {
      const right = workspace.getRightLeaf(false);
      if (!right) return;
      await right.setViewState({ type: OUTLINE_VIEW_TYPE, active: true });
      leaf = right;
    }
    await workspace.revealLeaf(leaf);
  }
}
