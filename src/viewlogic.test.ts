import { describe, expect, it } from 'vitest';
import { appliesTo, RenderSequencer } from './viewlogic.ts';

describe('appliesTo', () => {
  it('matches only the open file', () => {
    expect(appliesTo('a/b.ipynb', 'a/b.ipynb')).toBe(true);
    expect(appliesTo('a/c.ipynb', 'a/b.ipynb')).toBe(false);
    expect(appliesTo('a/b.ipynb', null)).toBe(false);
    expect(appliesTo('a/b.ipynb', undefined)).toBe(false);
  });
});

describe('RenderSequencer', () => {
  it('drops a result after a newer begin', () => {
    const s = new RenderSequencer();
    const first = s.begin();
    const second = s.begin();
    expect(s.isCurrent(first)).toBe(false);
    expect(s.isCurrent(second)).toBe(true);
  });

  it('drops a result after invalidate', () => {
    const s = new RenderSequencer();
    const t = s.begin();
    s.invalidate();
    expect(s.isCurrent(t)).toBe(false);
    expect(s.isCurrent(s.begin())).toBe(true);
  });
});
