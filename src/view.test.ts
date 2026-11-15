import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  platform: { isMacOS: true, isDesktopApp: true, isMobile: false },
  actions: [] as { icon: string; title: string; el: HTMLElement; cb: () => void }[],
  loadPrism: undefined as unknown as () => Promise<unknown>,
}));

vi.mock('obsidian', async () => {
  const stub = await vi.importActual<typeof import('./test/obsidian-stub.ts')>('obsidian');
  class FileView extends stub.FileView {
    constructor(leaf: { app: unknown }) {
      super(leaf);
      this.contentEl = stub.withEmpty(this.contentEl);
    }
    addAction(icon: string, title: string, cb: () => void): HTMLElement {
      const el = document.createElement('div');
      document.body.appendChild(el);
      h.actions.push({ icon, title, el, cb });
      return el;
    }
    registerEvent(): void {}
  }
  return { ...stub, FileView, Platform: h.platform, loadPrism: () => h.loadPrism() };
});

import { FileSystemAdapter, TFile } from 'obsidian';
import { DEFAULT_SETTINGS } from './settings.ts';
import type { Settings } from './settings.ts';
import { FLASH_MS, MODIFY_DEBOUNCE_MS, NotebookView } from './view.ts';

const tfile = (path: string) => new (TFile as unknown as new (p: string) => TFile)(path);

function notebook(source: string, cellType = 'markdown'): string {
  return JSON.stringify({
    nbformat: 4,
    metadata: { language_info: { name: 'python' } },
    cells: [{ cell_type: cellType, source, outputs: [], execution_count: 1 }],
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => (resolve = r));
  return { promise, resolve };
}

type Handler = (f: unknown) => void;

function setup(overrides: Partial<Settings> = {}, adapter: object = new FileSystemAdapter()) {
  const handlers: Record<string, Handler> = {};
  const cachedRead = vi.fn<(f: TFile) => Promise<string>>();
  const app = {
    vault: {
      cachedRead,
      on: (name: string, cb: Handler) => {
        handlers[name] = cb;
        return {};
      },
      adapter,
      getName: () => 'My Vault',
    },
  };
  const host = { settings: { ...DEFAULT_SETTINGS, ...overrides }, onRendered: vi.fn() };
  const view = new NotebookView({ app } as never, host);
  view.onload();
  const file = tfile('a.ipynb');
  view.file = file as never;
  return { view, file, cachedRead, handlers, host, app };
}

beforeEach(() => {
  h.actions.length = 0;
  document.body.replaceChildren();
  h.platform.isMacOS = true;
  h.platform.isDesktopApp = true;
  h.loadPrism = async () => ({ languages: { python: {} }, highlightElement: vi.fn() });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('NotebookView', () => {
  it('renders the file and accepts only ipynb', async () => {
    const { view, file, cachedRead } = setup();
    cachedRead.mockResolvedValue(notebook('# Hello'));
    await view.onLoadFile(file as never);
    expect(view.contentEl.querySelector('h1')!.textContent).toBe('Hello');
    expect(view.canAcceptExtension('ipynb')).toBe(true);
    expect(view.canAcceptExtension('md')).toBe(false);
  });

  it('drops a stale render that resolves after a newer one', async () => {
    const { view, file, cachedRead } = setup();
    const first = deferred<string>();
    const second = deferred<string>();
    cachedRead.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = view.onLoadFile(file as never);
    const b = view.onLoadFile(file as never);
    second.resolve(notebook('# Second'));
    await b;
    first.resolve(notebook('# First'));
    await a;
    expect(view.contentEl.textContent).toContain('Second');
    expect(view.contentEl.textContent).not.toContain('First');
  });

  it('drops a render that resolves after the file was unloaded', async () => {
    const { view, file, cachedRead } = setup();
    const d = deferred<string>();
    cachedRead.mockReturnValueOnce(d.promise);
    const load = view.onLoadFile(file as never);
    await view.onUnloadFile(file as never);
    d.resolve(notebook('# Late'));
    await load;
    expect(view.contentEl.textContent).toBe('');
  });

  it('shows a message for a notebook that cannot be parsed', async () => {
    const { view, file, cachedRead } = setup();
    cachedRead.mockResolvedValue('{"nbformat":3}');
    await view.onLoadFile(file as never);
    expect(view.contentEl.textContent).toContain('Cannot open this notebook');
    expect(view.contentEl.textContent).toContain('nbformat 4');
  });

  it('ignores a modify of another file and debounces modifies of this one', async () => {
    vi.useFakeTimers();
    const { view, file, cachedRead, handlers } = setup();
    cachedRead.mockResolvedValue(notebook('# One'));
    await view.onLoadFile(file as never);
    expect(cachedRead).toHaveBeenCalledTimes(1);

    handlers.modify(tfile('other.ipynb'));
    await vi.advanceTimersByTimeAsync(MODIFY_DEBOUNCE_MS * 2);
    expect(cachedRead).toHaveBeenCalledTimes(1);

    cachedRead.mockResolvedValue(notebook('# Two'));
    handlers.modify(file);
    await vi.advanceTimersByTimeAsync(MODIFY_DEBOUNCE_MS - 50);
    handlers.modify(file);
    await vi.advanceTimersByTimeAsync(MODIFY_DEBOUNCE_MS - 50);
    expect(cachedRead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(cachedRead).toHaveBeenCalledTimes(2);
    expect(view.contentEl.querySelector('h1')!.textContent).toBe('Two');
  });

  it('cancels a pending modify when the file is unloaded', async () => {
    vi.useFakeTimers();
    const { view, file, cachedRead, handlers } = setup();
    cachedRead.mockResolvedValue(notebook('# One'));
    await view.onLoadFile(file as never);
    handlers.modify(file);
    await view.onUnloadFile(file as never);
    await vi.advanceTimersByTimeAsync(MODIFY_DEBOUNCE_MS * 2);
    expect(cachedRead).toHaveBeenCalledTimes(1);
    expect(view.contentEl.textContent).toBe('');
  });

  it('keeps an expanded code cell open across a modify', async () => {
    vi.useFakeTimers();
    const { view, file, cachedRead, handlers } = setup();
    cachedRead.mockResolvedValue(notebook('x = 1', 'code'));
    await view.onLoadFile(file as never);
    view.contentEl.querySelector('details')!.setAttribute('open', '');
    cachedRead.mockResolvedValue(notebook('x = 2', 'code'));
    handlers.modify(file);
    await vi.advanceTimersByTimeAsync(MODIFY_DEBOUNCE_MS + 10);
    const details = view.contentEl.querySelector('details')!;
    expect(details.textContent).toContain('x = 2');
    expect(details.hasAttribute('open')).toBe(true);
  });

  it('loads Prism once per view and highlights known languages only', async () => {
    const highlightElement = vi.fn();
    const loadPrism = vi.fn(async () => ({ languages: { python: {} }, highlightElement }));
    h.loadPrism = loadPrism;
    const { view, file, cachedRead } = setup();
    cachedRead.mockResolvedValue(notebook('x = 1', 'code'));
    await view.onLoadFile(file as never);
    await view.onLoadFile(file as never);
    expect(loadPrism).toHaveBeenCalledTimes(1);
    expect(highlightElement).toHaveBeenCalledTimes(2);
  });

  it('shows plain code when Prism fails to load', async () => {
    h.loadPrism = async () => {
      throw new Error('no prism');
    };
    const { view, file, cachedRead } = setup();
    cachedRead.mockResolvedValue(notebook('x = 1', 'code'));
    await view.onLoadFile(file as never);
    expect(view.contentEl.querySelector('code')!.textContent).toBe('x = 1');
  });

  it('offers Open in Ganymede only on macOS desktop with a file-system vault', () => {
    setup();
    expect(h.actions.map(a => a.title)).toEqual(['Show/hide all code', 'Open in Ganymede']);
    h.actions.length = 0;
    h.platform.isDesktopApp = false;
    setup();
    expect(h.actions.map(a => a.title)).toEqual(['Show/hide all code']);
    h.actions.length = 0;
    h.platform.isDesktopApp = true;
    setup({}, {});
    expect(h.actions.map(a => a.title)).toEqual(['Show/hide all code']);
  });
});

function richNotebook(): string {
  const md = (id: string, source: string) => ({ cell_type: 'markdown', id, source });
  return JSON.stringify({
    nbformat: 4,
    metadata: {
      title: 'My <b>Title</b>',
      kernelspec: { display_name: 'Python 3', language: 'python' },
      tags: ['a'],
    },
    cells: [
      md('intro', '# Intro\ntext'),
      {
        cell_type: 'code',
        id: 'c1',
        source: 'print(1)',
        execution_count: 7,
        outputs: [{ output_type: 'stream', name: 'stdout', text: 'x\n'.repeat(100) }],
        metadata: { execution: { 'iopub.execute_input': '2025-01-02T03:04:05Z' } },
      },
      md('methods', '## Methods\nmore'),
      md('results', '# Results\nend'),
    ],
  });
}

describe('NotebookView content and settings', () => {
  it('shows the header with textContent, never as markup', async () => {
    const { view, file, cachedRead } = setup();
    cachedRead.mockResolvedValue(richNotebook());
    await view.onLoadFile(file as never);
    const header = view.contentEl.querySelector('.nbl-header')!;
    expect(header.querySelector('.nbl-title')!.textContent).toBe('My <b>Title</b>');
    expect(header.querySelector('b')).toBeNull();
    expect(header.textContent).toContain('Kernel: Python 3');
    expect(header.textContent).toContain('Last run:');
    expect(header.querySelector('.nbl-tag')!.textContent).toBe('a');
  });

  it('applies fold, counts and the output cap from the settings', async () => {
    const { view, file, cachedRead } = setup({
      foldCode: false,
      showCounts: false,
      maxOutputLines: 10,
    });
    cachedRead.mockResolvedValue(richNotebook());
    await view.onLoadFile(file as never);
    const details = view.contentEl.querySelector('details')!;
    expect(details.hasAttribute('open')).toBe(true);
    expect(details.querySelector('.nbl-count')).toBeNull();
    expect(view.contentEl.querySelector('.nbl-text')!.textContent!.split('\n')).toHaveLength(10);
    expect(view.contentEl.querySelector('.nbl-more')).not.toBeNull();
  });

  it('re-renders when refresh() is called after a settings change', async () => {
    const { view, file, cachedRead, host } = setup();
    cachedRead.mockResolvedValue(richNotebook());
    await view.onLoadFile(file as never);
    expect(view.contentEl.querySelector('details')!.hasAttribute('open')).toBe(false);
    host.settings.foldCode = false;
    view.refresh();
    await vi.waitFor(() =>
      expect(view.contentEl.querySelector('details')!.hasAttribute('open')).toBe(true),
    );
  });

  it('lists the headings of the rendered notebook and tells the host', async () => {
    const { view, file, cachedRead, host } = setup();
    cachedRead.mockResolvedValue(richNotebook());
    await view.onLoadFile(file as never);
    expect(view.headings.map(x => [x.level, x.text])).toEqual([
      [1, 'Intro'],
      [2, 'Methods'],
      [1, 'Results'],
    ]);
    expect(host.onRendered).toHaveBeenCalledWith(view);
    await view.onUnloadFile(file as never);
    expect(view.headings).toEqual([]);
  });
});

describe('NotebookView navigation', () => {
  const cellEl = (view: NotebookView, i: number) =>
    view.contentEl.querySelector(`[data-cell-index="${i}"]`) as HTMLElement;

  it('scrolls to and highlights a heading from a link subpath', async () => {
    vi.useFakeTimers();
    const { view, file, cachedRead } = setup();
    cachedRead.mockResolvedValue(richNotebook());
    await view.onLoadFile(file as never);
    const scroll = vi.fn();
    cellEl(view, 2).scrollIntoView = scroll;
    view.setEphemeralState({ subpath: '#Methods' });
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(cellEl(view, 2).classList.contains('nbl-flash')).toBe(true);
    await vi.advanceTimersByTimeAsync(FLASH_MS + 10);
    expect(cellEl(view, 2).classList.contains('nbl-flash')).toBe(false);
  });

  it('scrolls to a block id, and to a search hit by cell id before its index', async () => {
    const { view, file, cachedRead } = setup();
    cachedRead.mockResolvedValue(richNotebook());
    await view.onLoadFile(file as never);
    view.setEphemeralState({ subpath: '#^results' });
    expect(cellEl(view, 3).classList.contains('nbl-flash')).toBe(true);
    view.setEphemeralState({ notebookCell: { id: 'c1', index: 0 } });
    expect(cellEl(view, 1).classList.contains('nbl-flash')).toBe(true);
    // One highlight at a time.
    expect(cellEl(view, 3).classList.contains('nbl-flash')).toBe(false);
  });

  it('keeps a target that arrives before the render and applies it after', async () => {
    const { view, file, cachedRead } = setup();
    const d = deferred<string>();
    cachedRead.mockReturnValueOnce(d.promise);
    const load = view.onLoadFile(file as never);
    view.setEphemeralState({ subpath: '#Results' });
    d.resolve(richNotebook());
    await load;
    expect(cellEl(view, 3).classList.contains('nbl-flash')).toBe(true);
  });

  it('ignores a subpath that matches nothing, and does not scroll again on a re-render', async () => {
    vi.useFakeTimers();
    const { view, file, cachedRead, handlers } = setup();
    cachedRead.mockResolvedValue(richNotebook());
    await view.onLoadFile(file as never);
    view.setEphemeralState({ subpath: '#Nope' });
    expect(view.contentEl.querySelector('.nbl-flash')).toBeNull();
    view.setEphemeralState({ subpath: '#Results' });
    handlers.modify(file);
    await vi.advanceTimersByTimeAsync(MODIFY_DEBOUNCE_MS + FLASH_MS);
    expect(view.contentEl.querySelector('.nbl-flash')).toBeNull();
  });
});

describe('NotebookView open externally', () => {
  const open = () => h.actions.find(a => a.title !== 'Show/hide all code');

  it('opens Ganymede with the encoded absolute path', () => {
    const spy = vi.spyOn(window, 'open').mockImplementation(() => null);
    setup();
    open()!.cb();
    expect(spy).toHaveBeenCalledWith('ganymede://open?path=%2Fvault%2Fa.ipynb');
  });

  it('opens a custom URL with every placeholder encoded', () => {
    const spy = vi.spyOn(window, 'open').mockImplementation(() => null);
    setup({ openWith: 'custom', customUrl: 'myapp://{vault}/{vaultPath}?n={name}&p={path}' });
    expect(open()!.title).toBe('Open externally');
    open()!.cb();
    expect(spy).toHaveBeenCalledWith('myapp://My%20Vault/a.ipynb?n=a.ipynb&p=%2Fvault%2Fa.ipynb');
  });

  it('opens the system default app through app.openWithDefaultApp when it exists', () => {
    const { view, app } = setup({ openWith: 'system' });
    // Without the undocumented method there is no action.
    expect(open()).toBeUndefined();
    const fn = vi.fn();
    (app as unknown as { openWithDefaultApp: unknown }).openWithDefaultApp = fn;
    view.refresh();
    expect(open()!.title).toBe('Open in default app');
    open()!.cb();
    expect(fn).toHaveBeenCalledWith('a.ipynb');
  });

  it('offers no action when Off or when the template is invalid, and swaps it on refresh', () => {
    setup({ openWith: 'off' });
    expect(open()).toBeUndefined();
    h.actions.length = 0;
    setup({ openWith: 'custom', customUrl: 'javascript:alert(1)' });
    expect(open()).toBeUndefined();
    h.actions.length = 0;
    const { view, host } = setup();
    const first = open()!;
    host.settings.openWith = 'custom';
    host.settings.customUrl = 'myapp://{name}';
    view.refresh();
    expect(h.actions.map(a => a.title)).toContain('Open externally');
    expect(first.el.isConnected).toBe(false);
    expect(h.actions.at(-1)!.el.isConnected).toBe(true);
    host.settings.openWith = 'off';
    view.refresh();
    expect(h.actions.at(-1)!.el.isConnected).toBe(false);
  });
});
