import { FileSystemAdapter, FileView, Notice, Platform, TFile } from 'obsidian';
import type { TAbstractFile, WorkspaceLeaf } from 'obsidian';
import { notebookHeader } from './header.ts';
import { NotebookError, parseNotebook } from './notebook.ts';
import type { Notebook } from './notebook.ts';
import { buildCustomUrl, ganymedeOpenUrl, resolveOpenAction } from './openwith.ts';
import type { OpenEnv } from './openwith.ts';
import { notebookHeadings, resolveTarget, targetFromState } from './outline.ts';
import type { Heading, Target } from './outline.ts';
import { prismHighlighter } from './prism.ts';
import { applyOpen, captureOpen, renderError, renderNotebook } from './render.ts';
import type { Settings } from './settings.ts';
import { appliesTo, RenderSequencer } from './viewlogic.ts';

export const VIEW_TYPE = 'notebook-library-view';

/** What a view needs from the plugin. */
export interface ViewHost {
  settings: Settings;
  /** A notebook view finished rendering: the outline can update. */
  onRendered(view: NotebookView): void;
}

/** A modify event re-renders after this quiet time (Sync can write in bursts). */
export const MODIFY_DEBOUNCE_MS = 300;

/** How long a cell stays highlighted after a search result or link scrolls to it. */
export const FLASH_MS = 2000;

export class NotebookView extends FileView {
  // A slow render never lands after a newer one or after the file closed.
  private readonly renders = new RenderSequencer();
  // Resolved once per view.
  private readonly highlighter = prismHighlighter();
  private modifyTimer: ReturnType<typeof setTimeout> | undefined;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private openAction: HTMLElement | undefined;
  private nb: Notebook | null = null;
  // A cell to scroll to once the notebook is rendered (state can arrive first).
  private pending: Target | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: ViewHost,
  ) {
    super(leaf);
    this.navigation = true;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file?.basename ?? 'Notebook';
  }

  getIcon(): string {
    return 'file-code';
  }

  canAcceptExtension(extension: string): boolean {
    return extension === 'ipynb';
  }

  /** The Markdown headings of the notebook as last rendered. */
  get headings(): Heading[] {
    return this.nb ? notebookHeadings(this.nb) : [];
  }

  onload(): void {
    super.onload();
    // Changes from Obsidian Sync arrive as vault modify events.
    this.registerEvent(
      this.app.vault.on('modify', (f: TAbstractFile) => {
        if (!appliesTo(f.path, this.file?.path) || !(f instanceof TFile)) return;
        clearTimeout(this.modifyTimer);
        this.modifyTimer = setTimeout(() => void this.render(f), MODIFY_DEBOUNCE_MS);
      }),
    );
    this.addAction('code', 'Show/hide all code', () => this.toggleCode());
    this.refreshOpenAction();
  }

  onunload(): void {
    clearTimeout(this.modifyTimer);
    clearTimeout(this.flashTimer);
    this.renders.invalidate();
  }

  async onLoadFile(file: TFile): Promise<void> {
    await this.render(file);
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    clearTimeout(this.modifyTimer);
    clearTimeout(this.flashTimer);
    this.renders.invalidate();
    this.nb = null;
    this.pending = null;
    this.contentEl.empty();
    this.host.onRendered(this);
  }

  /** Obsidian passes a link's `#subpath` here; a search result passes `notebookCell`. */
  setEphemeralState(state: unknown): void {
    super.setEphemeralState(state);
    const target = targetFromState(state);
    if (!target) return;
    this.pending = target;
    this.applyPending();
  }

  /** Settings changed: draw again and re-decide the external action. */
  refresh(): void {
    this.refreshOpenAction();
    if (this.file) void this.render(this.file);
  }

  /** Scroll to a cell and highlight it for a moment. False when it isn't in the page. */
  scrollToCell(index: number): boolean {
    const el = this.contentEl.querySelector<HTMLElement>(`[data-cell-index="${index}"]`);
    if (!el) return false;
    for (const old of Array.from(this.contentEl.querySelectorAll('.nbl-flash'))) {
      old.classList.remove('nbl-flash');
    }
    // jsdom has no scrollIntoView.
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' });
    el.classList.add('nbl-flash');
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => el.classList.remove('nbl-flash'), FLASH_MS);
    return true;
  }

  private applyPending(): void {
    if (!this.pending || !this.nb) return;
    const index = resolveTarget(this.nb, this.pending);
    this.pending = null;
    if (index !== null) this.scrollToCell(index);
  }

  private toggleCode(): void {
    const all = Array.from(this.contentEl.querySelectorAll('details.nbl-code'));
    const open = all.some(d => !d.hasAttribute('open'));
    for (const d of all) d.toggleAttribute('open', open);
  }

  private openEnv(): OpenEnv {
    const hasOpenWithDefaultApp =
      typeof (this.app as unknown as { openWithDefaultApp?: unknown }).openWithDefaultApp ===
      'function';
    return {
      isMacOS: Platform.isMacOS,
      isDesktopApp: Platform.isDesktopApp,
      hasFilePath: this.app.vault.adapter instanceof FileSystemAdapter,
      hasOpenWithDefaultApp,
    };
  }

  /** The header action follows the "Open with" setting, so it is replaced when that changes. */
  private refreshOpenAction(): void {
    this.openAction?.remove();
    this.openAction = undefined;
    const action = resolveOpenAction(this.host.settings, this.openEnv());
    if (action)
      this.openAction = this.addAction('external-link', action.label, () => this.openExternally());
  }

  private openExternally(): void {
    const file = this.file;
    const action = resolveOpenAction(this.host.settings, this.openEnv());
    if (!file || !action) return;
    const adapter = this.app.vault.adapter;
    const fullPath =
      adapter instanceof FileSystemAdapter ? adapter.getFullPath(file.path) : undefined;
    try {
      if (action.kind === 'ganymede') {
        if (fullPath !== undefined) window.open(ganymedeOpenUrl(fullPath));
      } else if (action.kind === 'system') {
        // Undocumented; takes the vault-relative path.
        (this.app as unknown as { openWithDefaultApp(p: string): unknown }).openWithDefaultApp(
          file.path,
        );
      } else {
        const url = buildCustomUrl(this.host.settings.customUrl, {
          path: fullPath,
          vaultPath: file.path,
          vault: this.app.vault.getName(),
          name: file.name,
        });
        if (url) window.open(url);
      }
    } catch (e) {
      console.error('Notebook Library: could not open externally', e);
      new Notice('Notebook Library: could not open the notebook externally');
    }
  }

  private async render(file: TFile): Promise<void> {
    const token = this.renders.begin();
    const root = this.contentEl;
    root.addClass('nbl-view');
    const settings = this.host.settings;
    try {
      const [text, highlight] = await Promise.all([
        this.app.vault.cachedRead(file),
        this.highlighter,
      ]);
      if (!this.renders.isCurrent(token)) return;
      const nb = parseNotebook(text);
      // Render into a detached element so a newer render never interleaves.
      const staging = root.ownerDocument.createElement('div');
      renderNotebook(nb, staging, highlight, {
        foldCode: settings.foldCode,
        showCounts: settings.showCounts,
        maxOutputLines: settings.maxOutputLines,
        header: notebookHeader(nb, file.basename),
      });
      // Keep the code cells the reader expanded.
      applyOpen(staging, captureOpen(root));
      // "Readable line length" is a vault setting that isn't in the public typings.
      const getConfig = (this.app.vault as unknown as { getConfig?: (k: string) => unknown })
        .getConfig;
      const readable = getConfig?.call(this.app.vault, 'readableLineLength') === true;
      staging.firstElementChild?.classList.toggle('is-readable-line-width', readable);
      root.replaceChildren(...Array.from(staging.childNodes));
      this.nb = nb;
      this.applyPending();
      this.host.onRendered(this);
    } catch (e) {
      if (!this.renders.isCurrent(token)) return;
      const message =
        e instanceof NotebookError ? e.message : `Could not read the file: ${String(e)}`;
      this.nb = null;
      renderError(root, message);
      this.host.onRendered(this);
    }
  }
}
