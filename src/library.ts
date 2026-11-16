// Keeps the search index current with the vault. The index itself is in
// search.ts; this reads files and follows vault events.

import { Platform, TFile } from 'obsidian';
import type { App, Plugin } from 'obsidian';
import { MAX_INDEX_BYTES, NotebookIndex } from './search.ts';

/** A modify event re-reads the notebook after this quiet time. */
export const INDEX_DEBOUNCE_MS = 1000;

/** Files read between yields to the UI during the first build. */
const YIELD_EVERY = 5;

function isNotebook(f: unknown): f is TFile {
  return f instanceof TFile && f.extension.toLowerCase() === 'ipynb';
}

export class NotebookLibrary {
  readonly index = new NotebookIndex();
  private build: Promise<void> | null = null;
  // Bumped on every change to a path, so a read that finishes after a newer
  // change (or a delete or rename) is dropped, not stored.
  private readonly generation = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(private readonly app: App) {}

  /**
   * Follow the vault. Desktop builds the index once the workspace is ready;
   * mobile waits for the first search, so opening the app never reads every
   * notebook.
   */
  start(plugin: Plugin): void {
    const vault = this.app.vault;
    // Events before the first build are ignored: the build reads current state.
    plugin.registerEvent(
      vault.on('create', f => {
        if (this.build && isNotebook(f)) void this.reindex(f);
      }),
    );
    plugin.registerEvent(
      vault.on('modify', f => {
        if (this.build && isNotebook(f)) this.scheduleReindex(f);
      }),
    );
    plugin.registerEvent(
      vault.on('delete', f => {
        if (this.build) this.drop(f.path);
      }),
    );
    plugin.registerEvent(
      vault.on('rename', (f, oldPath) => {
        if (this.build) this.moved(f, oldPath);
      }),
    );
    plugin.register(() => this.stop());
    if (!Platform.isMobile) this.app.workspace.onLayoutReady(() => void this.ready());
  }

  /** Resolves when every notebook that existed at the first call has been read. */
  ready(): Promise<void> {
    return (this.build ??= this.buildAll());
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private async buildAll(): Promise<void> {
    const files = this.app.vault.getFiles().filter(isNotebook);
    for (let i = 0; i < files.length && !this.stopped; i++) {
      await this.reindex(files[i]);
      if (i % YIELD_EVERY === YIELD_EVERY - 1) await new Promise(r => setTimeout(r, 0));
    }
  }

  private bump(path: string): number {
    const n = (this.generation.get(path) ?? 0) + 1;
    this.generation.set(path, n);
    return n;
  }

  private scheduleReindex(file: TFile): void {
    clearTimeout(this.timers.get(file.path));
    this.timers.set(
      file.path,
      setTimeout(() => {
        this.timers.delete(file.path);
        void this.reindex(file);
      }, INDEX_DEBOUNCE_MS),
    );
  }

  private async reindex(file: TFile): Promise<void> {
    const path = file.path;
    const gen = this.bump(path);
    // Still the current read for this path, and the file still lives there
    // (a folder delete or rename doesn't bump the paths inside it).
    const current = () =>
      !this.stopped &&
      this.generation.get(path) === gen &&
      this.app.vault.getAbstractFileByPath(path) === file;
    if (file.stat.size > MAX_INDEX_BYTES) {
      this.index.markSkipped(path, file.stat.size);
      return;
    }
    let text: string;
    try {
      text = await this.app.vault.cachedRead(file);
    } catch (e) {
      console.warn(`Notebook Library: could not read ${path} for search`, e);
      if (current()) this.index.remove(path);
      return;
    }
    if (current()) this.index.set(path, text);
  }

  /** Forget a path, and anything under it when it was a folder. */
  private drop(path: string): void {
    for (const p of [path, ...this.index.pathsUnder(path)]) {
      this.bump(p);
      clearTimeout(this.timers.get(p));
      this.timers.delete(p);
      this.index.remove(p);
    }
  }

  private moved(file: unknown, oldPath: string): void {
    this.drop(oldPath);
    // The text didn't change with the name, but the old entry was just dropped
    // (it may have been mid-read), so read again at the new path. A renamed
    // folder is read for the notebooks under its new name.
    const files = isNotebook(file)
      ? [file]
      : this.app.vault
          .getFiles()
          .filter(f => isNotebook(f) && f.path.startsWith(`${(file as { path: string }).path}/`));
    for (const f of files) void this.reindex(f);
  }
}
