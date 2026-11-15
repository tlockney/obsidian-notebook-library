import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Plugin, TFile } from './test/obsidian-stub.ts';
import {
  embedRegistryOf,
  EMBED_MAX_HEIGHT,
  NotebookEmbed,
  registerNotebookEmbeds,
} from './embeds.ts';
import type { EmbedHost } from './embeds.ts';
import { DEFAULT_SETTINGS } from './settings.ts';

const md = (id: string, source: string) => ({ cell_type: 'markdown', id, source });
const NB = JSON.stringify({
  nbformat: 4,
  metadata: {},
  cells: [
    md('title', '# Title'),
    {
      cell_type: 'code',
      id: 'c1',
      source: 'print(1)',
      execution_count: 4,
      outputs: [{ output_type: 'stream', name: 'stdout', text: 'x\n'.repeat(60) }],
    },
    md('methods', '## Methods\nmethod text'),
    md('results', '# Results\nresult text'),
  ],
});

function setup(text: string | Promise<string> = NB) {
  const file = new TFile('dir/nb.ipynb');
  const handlers: Record<string, (f: unknown) => void> = {};
  const openFile = vi.fn(async () => {});
  const cachedRead = vi.fn(async () => text);
  const app = {
    vault: {
      cachedRead,
      on: (name: string, cb: (f: unknown) => void) => ((handlers[name] = cb), { name, cb }),
      getAbstractFileByPath: (p: string) => (p === file.path ? file : null),
    },
    workspace: { getLeaf: () => ({ openFile }) },
    metadataCache: {
      // Like Obsidian: any existing file resolves, whatever its type.
      getFirstLinkpathDest: (link: string) =>
        link === 'nb.ipynb' || link === 'dir/nb.ipynb'
          ? file
          : link === 'img.png' || link === 'note.md'
            ? new TFile(link)
            : null,
    },
  };
  const host: EmbedHost = {
    app: app as never,
    settings: { ...DEFAULT_SETTINGS },
    highlighter: async () => undefined,
    embeds: new Set(),
  };
  const el = document.createElement('div');
  const embed = (subpath = '') => new NotebookEmbed(host, el, file as never, subpath);
  return { file, host, el, embed, cachedRead, handlers, openFile, app };
}

const cellsIn = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('.nbl-cell')).map(c => c.getAttribute('data-cell-index'));

describe('NotebookEmbed', () => {
  it('renders the whole notebook in a bounded scrollable box, with a link to open it', async () => {
    const s = setup();
    const e = s.embed();
    e.onload();
    await e.loadFile();
    expect(cellsIn(s.el)).toEqual(['0', '1', '2', '3']);
    const body = s.el.querySelector<HTMLElement>('.nbl-embed-body')!;
    expect(body.style.maxHeight).toBe(EMBED_MAX_HEIGHT);
    expect(s.el.classList.contains('nbl-embed')).toBe(true);
    expect(s.el.querySelector('.nbl-header')).toBeNull();
    expect(s.el.querySelector('.nbl-embed-open')!.textContent).toBe('Open nb');
  });

  it('reads once even though both onload and loadFile ask to render', async () => {
    const s = setup();
    const e = s.embed();
    e.onload();
    await e.loadFile();
    await e.loadFile();
    expect(s.cachedRead).toHaveBeenCalledTimes(1);
    expect(s.host.embeds.has(e)).toBe(true);
  });

  it('renders a heading section up to the next heading of the same or higher level', async () => {
    const s = setup();
    const e = s.embed('#Methods');
    await e.loadFile();
    expect(cellsIn(s.el)).toEqual(['2']);
    const t = setup();
    const top = t.embed('#Title');
    await top.loadFile();
    expect(cellsIn(t.el)).toEqual(['0', '1', '2']);
  });

  it('renders one cell for a block id', async () => {
    const s = setup();
    await s.embed('#^c1').loadFile();
    expect(cellsIn(s.el)).toEqual(['1']);
    expect(s.el.querySelector('details')!.textContent).toContain('print(1)');
  });

  it('says so when the heading or id is not in the notebook', async () => {
    for (const sub of ['#Nope', '#^nope']) {
      const s = setup();
      await s.embed(sub).loadFile();
      expect(cellsIn(s.el)).toEqual([]);
      expect(s.el.querySelector('.nbl-failure')!.textContent).toBe(`Could not find ${sub} in nb.`);
      expect(s.el.querySelector('.nbl-embed-open')).not.toBeNull();
    }
  });

  it('shows why a notebook cannot be read', async () => {
    const s = setup('{"nbformat":3}');
    await s.embed().loadFile();
    expect(s.el.textContent).toContain('Cannot open this notebook');
  });

  it('applies the settings: fold, counts and the output cap', async () => {
    const s = setup();
    Object.assign(s.host.settings, { foldCode: false, showCounts: false, maxOutputLines: 5 });
    await s.embed().loadFile();
    const d = s.el.querySelector('details')!;
    expect(d.hasAttribute('open')).toBe(true);
    expect(d.querySelector('.nbl-count')).toBeNull();
    expect(s.el.querySelector('.nbl-more')).not.toBeNull();
  });

  it('opens the notebook at the same subpath from the link', async () => {
    const s = setup();
    await s.embed('#Methods').loadFile();
    const ev = new MouseEvent('click', { cancelable: true });
    s.el.querySelector('.nbl-embed-open')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(s.openFile).toHaveBeenCalledWith(s.file, { eState: { subpath: '#Methods' } });
  });

  describe('re-rendering', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('redraws after a quiet modify of its own file only', async () => {
      const s = setup();
      const e = s.embed();
      e.onload();
      await vi.advanceTimersByTimeAsync(0);
      s.cachedRead.mockClear();
      s.handlers.modify(new TFile('other.ipynb'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(s.cachedRead).not.toHaveBeenCalled();
      s.handlers.modify(s.file);
      await vi.advanceTimersByTimeAsync(400);
      expect(s.cachedRead).toHaveBeenCalledTimes(1);
    });

    it('drops a pending redraw and a late read once unloaded', async () => {
      let finish!: (t: string) => void;
      const s = setup();
      const e = s.embed();
      e.onload();
      await vi.advanceTimersByTimeAsync(0);
      s.cachedRead.mockClear();
      s.handlers.modify(s.file);
      e.onunload();
      await vi.advanceTimersByTimeAsync(1000);
      expect(s.cachedRead).not.toHaveBeenCalled();
      expect(s.host.embeds.has(e)).toBe(false);

      s.cachedRead.mockReturnValueOnce(new Promise<string>(r => (finish = r)));
      s.el.replaceChildren();
      const pending = e.render();
      e.onunload();
      finish(NB);
      await pending;
      expect(s.el.querySelector('.nbl-cell')).toBeNull();
    });
  });
});

describe('embedRegistryOf', () => {
  it('finds a registry only when both methods exist', () => {
    const fn = () => {};
    expect(embedRegistryOf({} as never)).toBeNull();
    expect(embedRegistryOf({ embedRegistry: {} } as never)).toBeNull();
    expect(embedRegistryOf({ embedRegistry: { registerExtension: fn } } as never)).toBeNull();
    expect(
      embedRegistryOf({ embedRegistry: { registerExtension: 1, unregisterExtension: 2 } } as never),
    ).toBeNull();
    const reg = { registerExtension: fn, unregisterExtension: fn };
    expect(embedRegistryOf({ embedRegistry: reg } as never)).toBe(reg);
  });
});

describe('registerNotebookEmbeds', () => {
  it('registers with the embed registry and unregisters on unload', () => {
    const s = setup();
    const registry = { registerExtension: vi.fn(), unregisterExtension: vi.fn() };
    const plugin = new Plugin({ ...s.app, embedRegistry: registry } as never, {} as never);
    expect(registerNotebookEmbeds(plugin as never, s.host)).toBe('registry');
    expect(plugin.postProcessors).toHaveLength(0);
    expect(registry.registerExtension.mock.calls[0][0]).toBe('ipynb');
    const factory = registry.registerExtension.mock.calls[0][1];
    const container = document.createElement('div');
    const made = factory({ containerEl: container }, s.file, '#Methods');
    expect(made).toBeInstanceOf(NotebookEmbed);
    expect(made.containerEl).toBe(container);
    // A registry call without a subpath still works.
    expect(factory({ containerEl: container }, s.file, undefined)).toBeInstanceOf(NotebookEmbed);
    plugin.cleanups.forEach(c => c());
    expect(registry.unregisterExtension).toHaveBeenCalledWith('ipynb');
  });

  it('falls back to the post-processor when the registry refuses', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = setup();
    const registry = {
      registerExtension: vi.fn(() => {
        throw new Error('exists');
      }),
      unregisterExtension: vi.fn(),
    };
    const plugin = new Plugin({ ...s.app, embedRegistry: registry } as never, {} as never);
    expect(registerNotebookEmbeds(plugin as never, s.host)).toBe('post-processor');
    expect(plugin.postProcessors).toHaveLength(1);
    expect(plugin.cleanups).toHaveLength(0);
  });

  describe('post-processor fallback', () => {
    function run(html: string) {
      const s = setup();
      const plugin = new Plugin(s.app as never, {} as never);
      expect(registerNotebookEmbeds(plugin as never, s.host)).toBe('post-processor');
      const el = document.createElement('div');
      el.innerHTML = html;
      const children: unknown[] = [];
      plugin.postProcessors[0](el, {
        sourcePath: 'note.md',
        addChild: (c: unknown) => children.push(c),
      });
      return { el, children, s };
    }

    it('renders .internal-embed placeholders of notebooks, with subpath and size stripped', async () => {
      const { el, children } = run(
        '<div class="internal-embed" src="nb.ipynb#Methods|400">stale</div>',
      );
      expect(children).toHaveLength(1);
      const embed = children[0] as NotebookEmbed;
      expect(embed).toBeInstanceOf(NotebookEmbed);
      await embed.loadFile();
      const target = el.querySelector('.internal-embed')!;
      expect(target.classList.contains('is-loaded')).toBe(true);
      expect(cellsIn(target as HTMLElement)).toEqual(['2']);
      expect(target.textContent).not.toContain('stale');
    });

    it('leaves other embeds and unresolved notebooks alone', () => {
      const { el, children } = run(
        '<div class="internal-embed" src="img.png">a</div><div class="internal-embed" src="note.md#H">b</div><div class="internal-embed" src="missing.ipynb">c</div><div class="internal-embed">d</div>',
      );
      expect(children).toHaveLength(0);
      expect(el.textContent).toBe('abcd');
      expect(el.querySelector('.is-loaded')).toBeNull();
    });

    it('renders several embeds in one note', () => {
      const { children } = run(
        '<div class="internal-embed" src="nb.ipynb"></div><div class="internal-embed" src="dir/nb.ipynb#^c1"></div>',
      );
      expect(children).toHaveLength(2);
    });
  });
});
