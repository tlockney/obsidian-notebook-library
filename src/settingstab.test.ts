import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stub } from './test/obsidian-stub.ts';
import type { StubSetting } from './test/obsidian-stub.ts';
import { DEFAULT_SETTINGS } from './settings.ts';
import { NotebookSettingTab, SAVE_DEBOUNCE_MS } from './settingstab.ts';

function setup(overrides = {}) {
  const plugin = {
    settings: { ...DEFAULT_SETTINGS, ...overrides },
    saveSettings: vi.fn(async () => {}),
  };
  const tab = new NotebookSettingTab({} as never, plugin as never);
  tab.display();
  const row = (name: string): StubSetting => stub.settingRows.find(r => r.name === name)!;
  return { plugin, tab, row };
}

beforeEach(() => {
  stub.settingRows.length = 0;
  stub.notices.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('NotebookSettingTab', () => {
  it('shows the current values', () => {
    const { row } = setup({ foldCode: false, maxOutputLines: 12 });
    expect(row('Fold code cells by default').controls[0].value).toBe(false);
    expect(row('Show execution counts').controls[0].value).toBe(true);
    expect(row('Long output limit').controls[0].value).toBe('12');
    expect(row('Search text outputs').controls[0].value).toBe(true);
    expect(row('Open with').controls[0].options).toEqual(['ganymede', 'system', 'custom', 'off']);
    expect(row('Open with').controls[0].value).toBe('ganymede');
  });

  it.each([
    ['Fold code cells by default', 'foldCode'],
    ['Show execution counts', 'showCounts'],
    ['Search text outputs', 'searchOutputs'],
  ] as const)('saves the %s toggle', async (name, key) => {
    const { plugin, row } = setup();
    await row(name).controls[0].onChange!(false as never);
    expect(plugin.settings[key]).toBe(false);
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
  });

  it('saves a valid output limit, including 0, once after the typing stops', async () => {
    const { plugin, row } = setup();
    const change = row('Long output limit').controls[0].onChange!;
    await change('2' as never);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 100);
    await change('25' as never);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 100);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(plugin.settings.maxOutputLines).toBe(25);
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    expect(plugin.saveSettings).toHaveBeenCalledWith();
    await change('0' as never);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(plugin.settings.maxOutputLines).toBe(0);
  });

  it('ignores invalid output limits', async () => {
    const { plugin, row } = setup({ maxOutputLines: 25 });
    const change = row('Long output limit').controls[0].onChange!;
    for (const bad of ['', 'abc', '-1', '1.5', '1e9']) await change(bad as never);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
    expect(plugin.settings.maxOutputLines).toBe(25);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it('saves a pending text change when the tab is closed', async () => {
    const { plugin, row, tab } = setup();
    await row('Long output limit').controls[0].onChange!('7' as never);
    tab.hide();
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
  });

  it('saves the custom URL after typing stops, and only refreshes the header actions', async () => {
    const { plugin, row } = setup({ openWith: 'custom' });
    const change = row('Custom URL').controls[0].onChange!;
    for (const v of ['m', 'my', 'myapp://{name}']) await change(v as never);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(plugin.settings.customUrl).toBe('myapp://{name}');
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    expect(plugin.saveSettings).toHaveBeenCalledWith('actions');
  });

  it('shows the custom URL field only for Custom URL, with the reason a template is refused', async () => {
    const { plugin, row, tab } = setup();
    expect(row('Custom URL')).toBeUndefined();
    // Choosing Custom URL redraws the tab with the field.
    await row('Open with').controls[0].onChange!('custom' as never);
    expect(plugin.settings.openWith).toBe('custom');
    expect(tab.containerEl.isConnected).toBe(false);
    const url = stub.settingRows.filter(r => r.name === 'Custom URL').at(-1)!;
    expect(url).toBeDefined();
    await url.controls[0].onChange!('javascript:alert(1)' as never);
    expect(plugin.settings.customUrl).toBe('javascript:alert(1)');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(url.descEl.querySelector('.nbl-setting-error')!.textContent).toBe(
      'The javascript: scheme is not allowed.',
    );
    await url.controls[0].onChange!('myapp://{name}' as never);
    expect(url.descEl.querySelector('.nbl-setting-error')!.textContent).toBe('');
  });

  it('shows a problem with a template that was saved invalid', () => {
    const { row } = setup({ openWith: 'custom', customUrl: 'file:///etc/passwd' });
    expect(row('Custom URL').descEl.querySelector('.nbl-setting-error')!.textContent).toBe(
      'The file: scheme is not allowed.',
    );
  });
});

describe('NotebookSettingTab when saving fails', () => {
  const failing = (overrides = {}) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = setup(overrides);
    s.plugin.saveSettings.mockRejectedValue(new Error('disk full'));
    return { ...s, err };
  };
  const reported = (err: ReturnType<typeof vi.spyOn>) => {
    expect(stub.notices).toEqual(['Notebook Library: could not save settings']);
    expect(err).toHaveBeenCalled();
  };

  it.each(['Fold code cells by default', 'Show execution counts', 'Search text outputs'])(
    'reports a failed save of the %s toggle',
    async name => {
      const { row, err } = failing();
      await row(name).controls[0].onChange!(false as never);
      reported(err);
    },
  );

  it('reports a failed save of the Open with dropdown, and still redraws', async () => {
    const { row, err, tab } = failing();
    const redraw = vi.spyOn(tab, 'display');
    await row('Open with').controls[0].onChange!('off' as never);
    reported(err);
    expect(redraw).toHaveBeenCalled();
  });

  it('reports a failed debounced save, and one that runs when the tab closes', async () => {
    const { row, err, tab } = failing();
    await row('Long output limit').controls[0].onChange!('9' as never);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    reported(err);
    stub.notices.length = 0;
    await row('Long output limit').controls[0].onChange!('8' as never);
    tab.hide();
    await vi.advanceTimersByTimeAsync(0);
    expect(stub.notices).toEqual(['Notebook Library: could not save settings']);
  });

  it('reports a failed debounced save of the Custom URL, which saves actions only', async () => {
    const { row, err, plugin } = failing({ openWith: 'custom' });
    await row('Custom URL').controls[0].onChange!('myapp://open?f={vaultPath}' as never);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(plugin.saveSettings).toHaveBeenCalledWith('actions');
    reported(err);
  });
});
