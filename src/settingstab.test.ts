import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stub } from './test/obsidian-stub.ts';
import type { StubSetting } from './test/obsidian-stub.ts';
import { DEFAULT_SETTINGS } from './settings.ts';
import { NotebookSettingTab } from './settingstab.ts';

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

  it('saves a valid output limit, including 0, and ignores invalid ones', async () => {
    const { plugin, row } = setup();
    const change = row('Long output limit').controls[0].onChange!;
    await change('0' as never);
    expect(plugin.settings.maxOutputLines).toBe(0);
    await change(' 25 ' as never);
    expect(plugin.settings.maxOutputLines).toBe(25);
    plugin.saveSettings.mockClear();
    for (const bad of ['', 'abc', '-1', '1.5', '1e9']) await change(bad as never);
    expect(plugin.settings.maxOutputLines).toBe(25);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
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
