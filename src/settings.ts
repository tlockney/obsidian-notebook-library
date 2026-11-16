// The plugin's settings, without Obsidian so they can be tested.

export type OpenWith = 'ganymede' | 'system' | 'custom' | 'off';

export const OPEN_WITH_VALUES: readonly OpenWith[] = ['ganymede', 'system', 'custom', 'off'];

export interface Settings {
  foldCode: boolean;
  showCounts: boolean;
  /** Lines of a text output shown before "Show more"; 0 shows all. */
  maxOutputLines: number;
  searchOutputs: boolean;
  openWith: OpenWith;
  customUrl: string;
}

export const DEFAULT_SETTINGS: Settings = {
  foldCode: true,
  showCounts: true,
  maxOutputLines: 40,
  searchOutputs: true,
  openWith: 'ganymede',
  customUrl: '',
};

/**
 * Saved data merged over the defaults, field by field: a missing, mistyped or
 * out-of-range value (a hand-edited data.json) falls back to its default.
 */
export function mergeSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const bool = (k: 'foldCode' | 'showCounts' | 'searchOutputs') =>
    typeof r[k] === 'boolean' ? r[k] : d[k];
  const lines = r.maxOutputLines;
  return {
    foldCode: bool('foldCode'),
    showCounts: bool('showCounts'),
    maxOutputLines:
      typeof lines === 'number' && Number.isInteger(lines) && lines >= 0 && lines <= 100000
        ? lines
        : d.maxOutputLines,
    searchOutputs: bool('searchOutputs'),
    openWith: OPEN_WITH_VALUES.includes(r.openWith as OpenWith)
      ? (r.openWith as OpenWith)
      : d.openWith,
    customUrl: typeof r.customUrl === 'string' ? r.customUrl : d.customUrl,
  };
}
