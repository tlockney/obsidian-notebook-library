import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stub } from './test/obsidian-stub.ts';
import type { Plugin as StubPlugin } from './test/obsidian-stub.ts';
import NotebookLibraryPlugin from './main.ts';
import { DEFAULT_SETTINGS } from './settings.ts';
import { NotebookView } from './view.ts';
import { OUTLINE_VIEW_TYPE, OutlineView } from './outlineview.ts';

/** The plugin as the stub models it: it records what the plugin registers. */
const rec = (p: NotebookLibraryPlugin) => p as unknown as StubPlugin;

function fakeApp(extra: object = {}) {
  const leaves: Record<string, { view: unknown; setViewState?: unknown }[]> = {};
  const workspace = {
    onLayoutReady: vi.fn(),
    getLeavesOfType: (t: string) => leaves[t] ?? [],
    getActiveViewOfType: vi.fn(() => null as unknown),
    getRightLeaf: vi.fn(() => null as unknown),
    revealLeaf: vi.fn(async () => {}),
  };
  const app = {
    vault: { on: () => ({}), getFiles: () => [], cachedRead: async () => '' },
    metadataCache: {},
    workspace,
    ...extra,
  };
  return { app, workspace, leaves };
}

beforeEach(() => {
  stub.notices.length = 0;
});

async function load(app: object, data: unknown = null) {
  const plugin = new NotebookLibraryPlugin(app as never, {} as never);
  rec(plugin).data = data;
  await plugin.onload();
  return plugin;
}

describe('NotebookLibraryPlugin', () => {
  it('tells the person when another plugin already opens .ipynb', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = fakeApp();
    const plugin = new NotebookLibraryPlugin(app as never, {} as never);
    plugin.registerExtensions = () => {
      throw new Error('Attempting to register an existing file extension "ipynb"');
    };
    await plugin.onload();
    expect(stub.notices).toEqual(['Notebook Library: another plugin already opens .ipynb files']);
  });

  it('registers both views, the extension, the commands and the embeds', async () => {
    const { app } = fakeApp();
    const registry = { registerExtension: vi.fn(), unregisterExtension: vi.fn() };
    const plugin = new NotebookLibraryPlugin(
      { ...app, embedRegistry: registry } as never,
      {} as never,
    );
    const ext = vi.fn();
    plugin.registerExtensions = ext;
    await plugin.onload();
    expect(ext).toHaveBeenCalledWith(['ipynb'], 'notebook-library-view');
    expect([...rec(plugin).views.keys()]).toEqual(['notebook-library-view', OUTLINE_VIEW_TYPE]);
    expect(rec(plugin).commands.map(c => [c.id, c.name])).toEqual([
      ['search-notebooks', 'Search notebooks'],
      ['show-outline', 'Show notebook outline'],
    ]);
    expect(registry.registerExtension).toHaveBeenCalledWith('ipynb', expect.any(Function));
    expect(stub.notices).toEqual([]);
  });

  it('uses the post-processor fallback when there is no embed registry', async () => {
    const plugin = await load(fakeApp().app);
    expect(rec(plugin).postProcessors).toHaveLength(1);
  });

  it('merges saved settings over the defaults', async () => {
    const plugin = await load(fakeApp().app, { foldCode: false, openWith: 'bogus' });
    expect(plugin.settings).toEqual({ ...DEFAULT_SETTINGS, foldCode: false });
  });

  it('saves settings and redraws open notebooks and embeds', async () => {
    const { app, leaves } = fakeApp();
    const plugin = await load(app);
    const view = Object.create(NotebookView.prototype) as NotebookView;
    view.refresh = vi.fn();
    leaves['notebook-library-view'] = [{ view }, { view: {} }];
    const embed = { render: vi.fn(async () => {}) };
    plugin.embeds.add(embed as never);
    plugin.settings.foldCode = false;
    await plugin.saveSettings();
    expect(rec(plugin).data).toMatchObject({ foldCode: false });
    expect(view.refresh).toHaveBeenCalledTimes(1);
    expect(embed.render).toHaveBeenCalledTimes(1);
  });

  it('follows the active notebook view, then the last one still open', async () => {
    const { app, workspace, leaves } = fakeApp();
    const plugin = await load(app);
    const a = Object.create(NotebookView.prototype) as NotebookView;
    const b = Object.create(NotebookView.prototype) as NotebookView;
    leaves['notebook-library-view'] = [{ view: a }, { view: b }];
    expect(plugin.currentNotebookView()).toBe(a);
    workspace.getActiveViewOfType.mockReturnValue(b);
    expect(plugin.currentNotebookView()).toBe(b);
    // The outline is active: keep b.
    workspace.getActiveViewOfType.mockReturnValue(null);
    expect(plugin.currentNotebookView()).toBe(b);
    // b closed: fall back to what is open.
    leaves['notebook-library-view'] = [{ view: a }];
    expect(plugin.currentNotebookView()).toBe(a);
    leaves['notebook-library-view'] = [];
    expect(plugin.currentNotebookView()).toBeNull();
  });

  it('remembers the active view when it renders, for when the outline takes focus', async () => {
    const { app, workspace, leaves } = fakeApp();
    const plugin = await load(app);
    const a = Object.create(NotebookView.prototype) as NotebookView;
    const b = Object.create(NotebookView.prototype) as NotebookView;
    leaves['notebook-library-view'] = [{ view: a }, { view: b }];
    workspace.getActiveViewOfType.mockReturnValue(b);
    plugin.onRendered(b);
    workspace.getActiveViewOfType.mockReturnValue(null);
    expect(plugin.currentNotebookView()).toBe(b);
  });

  it('on an actions-only save, refreshes the header actions and does not redraw', async () => {
    const { app, leaves } = fakeApp();
    const plugin = await load(app);
    const view = Object.create(NotebookView.prototype) as NotebookView;
    view.refresh = vi.fn();
    view.refreshActions = vi.fn();
    leaves['notebook-library-view'] = [{ view }];
    const embed = { render: vi.fn(async () => {}) };
    plugin.embeds.add(embed as never);
    await plugin.saveSettings('actions');
    expect(rec(plugin).data).toMatchObject({ foldCode: true });
    expect(view.refreshActions).toHaveBeenCalledTimes(1);
    expect(view.refresh).not.toHaveBeenCalled();
    expect(embed.render).not.toHaveBeenCalled();
  });

  it('redraws the outline when a notebook finishes rendering', async () => {
    const { app, leaves } = fakeApp();
    const plugin = await load(app);
    const outline = Object.create(OutlineView.prototype) as OutlineView;
    outline.refresh = vi.fn();
    leaves[OUTLINE_VIEW_TYPE] = [{ view: outline }];
    plugin.onRendered({} as NotebookView);
    expect(outline.refresh).toHaveBeenCalledTimes(1);
  });

  it('opens the outline in the right sidebar once, and reveals an existing one', async () => {
    const { app, workspace, leaves } = fakeApp();
    const plugin = await load(app);
    const show = rec(plugin).commands.find(c => c.id === 'show-outline')!;
    const leaf = { setViewState: vi.fn(async () => {}) };
    workspace.getRightLeaf.mockReturnValue(leaf);
    show.callback();
    await vi.waitFor(() => expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf));
    expect(leaf.setViewState).toHaveBeenCalledWith({ type: OUTLINE_VIEW_TYPE, active: true });
    workspace.getRightLeaf.mockClear();
    leaves[OUTLINE_VIEW_TYPE] = [{ view: {} } as never];
    show.callback();
    await vi.waitFor(() => expect(workspace.revealLeaf).toHaveBeenCalledTimes(2));
    expect(workspace.getRightLeaf).not.toHaveBeenCalled();
  });
});
