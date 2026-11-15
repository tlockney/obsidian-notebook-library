import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from './settings.ts';

describe('mergeSettings', () => {
  it('uses the defaults for no data', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings('x')).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toMatchObject({
      foldCode: true,
      showCounts: true,
      maxOutputLines: 40,
      searchOutputs: true,
      openWith: 'ganymede',
    });
  });

  it('keeps valid saved values and fills in the missing ones', () => {
    expect(mergeSettings({ foldCode: false, maxOutputLines: 0, openWith: 'off' })).toEqual({
      ...DEFAULT_SETTINGS,
      foldCode: false,
      maxOutputLines: 0,
      openWith: 'off',
    });
  });

  it.each([
    [{ foldCode: 'no' }],
    [{ maxOutputLines: -1 }],
    [{ maxOutputLines: 1.5 }],
    [{ maxOutputLines: '10' }],
    [{ openWith: 'javascript' }],
    [{ customUrl: 5 }],
  ])('ignores a mistyped value %j', bad => {
    expect(mergeSettings(bad)).toEqual(DEFAULT_SETTINGS);
  });
});
