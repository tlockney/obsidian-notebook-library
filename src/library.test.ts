import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform, Plugin, TFile } from './test/obsidian-stub.ts';
import { INDEX_DEBOUNCE_MS, NotebookLibrary } from './library.ts';
import { MAX_INDEX_BYTES } from './search.ts';

const nb = (text: string) =>
  JSON.stringify({ nbformat: 4, cells: [{ cell_type: 'markdown', source: text }] });

type Handler = (...a: unknown[]) => void;

function setup(initial: Record<string, string> = {}) {
  const files = new Map<string, TFile>();
  const texts = new Map<string, string | Promise<string>>();
  const handlers: Record<string, Handler> = {};
  let layoutReady: (() => void) | undefined;
  const add = (path: string, text: string | Promise<string>, size = 10) => {
    const f = new TFile(path);
    f.stat.size = size;
    files.set(path, f);
    texts.set(path, text);
    return f;
  };
  for (const [p, t] of Object.entries(initial)) add(p, t);
  const cachedRead = vi.fn(async (f: TFile) => {
    const t = texts.get(f.path);
    if (t === undefined) throw new Error('gone');
    return t;
  });
  const app = {
    vault: {
      on: (name: string, cb: Handler) => ((handlers[name] = cb), { name, cb }),
      getFiles: () => [...files.values()],
      getAbstractFileByPath: (p: string) => files.get(p) ?? null,
      cachedRead,
    },
    workspace: { onLayoutReady: (cb: () => void) => (layoutReady = cb) },
  };
  const library = new NotebookLibrary(app as never);
  const plugin = new Plugin(app as never, {} as never);
  library.start(plugin as never);
  const search = (q: string) => library.index.search(q, { outputs: true }).map(h => h.path);
  const rename = (from: string, to: string) => {
    const f = files.get(from)!;
    files.delete(from);
    f.path = to;
    f.name = to.slice(to.lastIndexOf('/') + 1);
    f.extension = f.name.includes('.') ? f.name.slice(f.name.lastIndexOf('.') + 1) : '';
    files.set(to, f);
    texts.set(to, texts.get(from)!);
    texts.delete(from);
    return f;
  };
  return {
    library,
    plugin,
    app,
    files,
    texts,
    handlers,
    add,
    cachedRead,
    search,
    rename,
    layoutReady: () => layoutReady?.(),
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  Platform.isMobile = false;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('NotebookLibrary build', () => {
  it('indexes every notebook once the layout is ready, and nothing else', async () => {
    const s = setup({ 'a.ipynb': nb('alpha'), 'b/c.IPYNB': nb('beta'), 'n.md': 'alpha' });
    expect(s.cachedRead).not.toHaveBeenCalled();
    s.layoutReady();
    await s.library.ready();
    expect(s.search('alpha')).toEqual(['a.ipynb']);
    expect(s.search('beta')).toEqual(['b/c.IPYNB']);
    expect(s.cachedRead).toHaveBeenCalledTimes(2);
  });

  it('on mobile waits for the first search', async () => {
    Platform.isMobile = true;
    const s = setup({ 'a.ipynb': nb('alpha') });
    s.layoutReady();
    await flush();
    expect(s.cachedRead).not.toHaveBeenCalled();
    await s.library.ready();
    expect(s.search('alpha')).toEqual(['a.ipynb']);
  });

  it('builds once however many callers wait', async () => {
    const s = setup({ 'a.ipynb': nb('alpha') });
    await Promise.all([s.library.ready(), s.library.ready()]);
    expect(s.cachedRead).toHaveBeenCalledTimes(1);
  });

  it('skips a notebook over the size cap without reading it, and reports it', async () => {
    const s = setup({ 'a.ipynb': nb('alpha') });
    s.add('big.ipynb', nb('huge'), MAX_INDEX_BYTES + 1);
    await s.library.ready();
    expect(s.cachedRead).toHaveBeenCalledTimes(1);
    expect(s.search('huge')).toEqual([]);
    expect(s.library.index.skippedFiles().map(([p]) => p)).toEqual(['big.ipynb']);
  });

  it('keeps going when one file cannot be read, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = setup({ 'a.ipynb': nb('alpha'), 'b.ipynb': nb('beta') });
    s.texts.delete('a.ipynb');
    await s.library.ready();
    expect(s.search('beta')).toEqual(['b.ipynb']);
    expect(warn).toHaveBeenCalled();
  });

  it('yields to the UI while building many files', async () => {
    const init: Record<string, string> = {};
    for (let i = 0; i < 12; i++) init[`n${i}.ipynb`] = nb(`word${i}`);
    const s = setup(init);
    let done = false;
    void s.library.ready().then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    await vi.runAllTimersAsync();
    expect(done).toBe(true);
    expect(s.library.index.size).toBe(12);
  });
});

describe('NotebookLibrary events', () => {
  it('ignores events before the first build: the build reads current state', async () => {
    const s = setup({ 'a.ipynb': nb('alpha') });
    const f = s.add('new.ipynb', nb('fresh'));
    s.handlers.create(f);
    s.handlers.modify(f);
    await vi.advanceTimersByTimeAsync(INDEX_DEBOUNCE_MS * 2);
    expect(s.cachedRead).not.toHaveBeenCalled();
    await s.library.ready();
    expect(s.search('fresh')).toEqual(['new.ipynb']);
  });

  it('indexes a created notebook and ignores other file types', async () => {
    const s = setup();
    await s.library.ready();
    s.handlers.create(s.add('a.ipynb', nb('alpha')));
    s.handlers.create(s.add('a.md', 'alpha'));
    await flush();
    expect(s.search('alpha')).toEqual(['a.ipynb']);
  });

  it('debounces modify events into one read of the latest text', async () => {
    const s = setup({ 'a.ipynb': nb('old') });
    await s.library.ready();
    s.cachedRead.mockClear();
    s.texts.set('a.ipynb', nb('new'));
    const f = s.files.get('a.ipynb')!;
    s.handlers.modify(f);
    await vi.advanceTimersByTimeAsync(INDEX_DEBOUNCE_MS - 100);
    s.handlers.modify(f);
    await vi.advanceTimersByTimeAsync(INDEX_DEBOUNCE_MS - 100);
    expect(s.cachedRead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(s.cachedRead).toHaveBeenCalledTimes(1);
    expect(s.search('new')).toEqual(['a.ipynb']);
    expect(s.search('old')).toEqual([]);
  });

  it('drops the entry when a later read of the file fails, rather than serve stale text', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = setup({ 'a.ipynb': nb('alpha') });
    await s.library.ready();
    expect(s.search('alpha')).toEqual(['a.ipynb']);
    s.texts.delete('a.ipynb');
    s.handlers.modify(s.files.get('a.ipynb')!);
    await vi.advanceTimersByTimeAsync(INDEX_DEBOUNCE_MS);
    expect(s.search('alpha')).toEqual([]);
    expect(s.library.index.has('a.ipynb')).toBe(false);
  });

  it('removes a deleted notebook, and cancels its pending modify', async () => {
    const s = setup({ 'a.ipynb': nb('alpha') });
    await s.library.ready();
    const f = s.files.get('a.ipynb')!;
    s.handlers.modify(f);
    s.files.delete('a.ipynb');
    s.handlers.delete(f);
    s.cachedRead.mockClear();
    await vi.advanceTimersByTimeAsync(INDEX_DEBOUNCE_MS * 2);
    expect(s.cachedRead).not.toHaveBeenCalled();
    expect(s.search('alpha')).toEqual([]);
  });

  it('drops a read that finishes after the file was deleted', async () => {
    let finish!: (t: string) => void;
    const s = setup();
    await s.library.ready();
    const f = s.add('a.ipynb', new Promise<string>(r => (finish = r)));
    s.handlers.create(f);
    await flush();
    s.files.delete('a.ipynb');
    s.handlers.delete(f);
    finish(nb('late'));
    await flush();
    expect(s.search('late')).toEqual([]);
  });

  it('keeps the newest text when an older read finishes last', async () => {
    let finishOld!: (t: string) => void;
    const s = setup({ 'a.ipynb': nb('v0') });
    await s.library.ready();
    const f = s.files.get('a.ipynb')!;
    s.texts.set('a.ipynb', new Promise<string>(r => (finishOld = r)));
    s.handlers.modify(f);
    await vi.advanceTimersByTimeAsync(INDEX_DEBOUNCE_MS);
    s.texts.set('a.ipynb', nb('v2'));
    s.handlers.modify(f);
    await vi.advanceTimersByTimeAsync(INDEX_DEBOUNCE_MS);
    expect(s.search('v2')).toEqual(['a.ipynb']);
    finishOld(nb('v1'));
    await flush();
    expect(s.search('v1')).toEqual([]);
    expect(s.search('v2')).toEqual(['a.ipynb']);
  });

  it('moves an entry on rename, and forgets one renamed away from .ipynb', async () => {
    const s = setup({ 'a.ipynb': nb('alpha'), 'b.ipynb': nb('beta') });
    await s.library.ready();
    const f = s.rename('a.ipynb', 'dir/z.ipynb');
    s.handlers.rename(f, 'a.ipynb');
    await flush();
    expect(s.search('alpha')).toEqual(['dir/z.ipynb']);
    const g = s.rename('b.ipynb', 'b.txt');
    s.handlers.rename(g, 'b.ipynb');
    await flush();
    expect(s.search('beta')).toEqual([]);
  });

  it('follows a renamed folder, which Obsidian reports as one event for the folder', async () => {
    const s = setup({ 'old/a.ipynb': nb('alpha'), 'old/b.ipynb': nb('beta') });
    await s.library.ready();
    s.rename('old/a.ipynb', 'new/a.ipynb');
    s.rename('old/b.ipynb', 'new/b.ipynb');
    s.handlers.rename({ path: 'new' }, 'old');
    await flush();
    expect(s.search('alpha')).toEqual(['new/a.ipynb']);
    expect(s.search('beta')).toEqual(['new/b.ipynb']);
  });

  it('forgets everything under a deleted folder, even a read still in flight', async () => {
    let finish!: (t: string) => void;
    const s = setup({ 'dir/a.ipynb': nb('alpha') });
    await s.library.ready();
    const slow = s.add('dir/slow.ipynb', new Promise<string>(r => (finish = r)));
    s.handlers.create(slow);
    await flush();
    s.files.clear();
    s.handlers.delete({ path: 'dir' });
    finish(nb('late'));
    await flush();
    expect(s.search('alpha')).toEqual([]);
    expect(s.search('late')).toEqual([]);
  });

  it('stops: no timers fire and no read lands after unload', async () => {
    const s = setup({ 'a.ipynb': nb('old') });
    await s.library.ready();
    s.cachedRead.mockClear();
    s.handlers.modify(s.files.get('a.ipynb')!);
    s.library.stop();
    await vi.advanceTimersByTimeAsync(INDEX_DEBOUNCE_MS * 2);
    expect(s.cachedRead).not.toHaveBeenCalled();
  });

  it('drops a read that finishes after stop()', async () => {
    let finish!: (t: string) => void;
    const s = setup();
    await s.library.ready();
    s.handlers.create(s.add('a.ipynb', new Promise<string>(r => (finish = r))));
    await flush();
    s.library.stop();
    finish(nb('late'));
    await flush();
    expect(s.search('late')).toEqual([]);
    expect(s.library.index.size).toBe(0);
  });

  it('stops a build in progress: nothing lands and no further file is read', async () => {
    let finish!: (t: string) => void;
    const s = setup();
    s.add('a.ipynb', new Promise<string>(r => (finish = r)));
    s.add('b.ipynb', nb('beta'));
    const built = s.library.ready();
    await flush();
    s.library.stop();
    finish(nb('alpha'));
    await built;
    await vi.runAllTimersAsync();
    expect(s.cachedRead).toHaveBeenCalledTimes(1);
    expect(s.library.index.size).toBe(0);
  });

  it('registers its stop with the plugin', () => {
    const s = setup();
    expect(s.plugin.cleanups).toHaveLength(1);
    expect(s.plugin.events).toHaveLength(4);
  });
});
