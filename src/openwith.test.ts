import { describe, expect, it } from 'vitest';
import {
  buildCustomUrl,
  ganymedeOpenUrl,
  resolveOpenAction,
  usesAbsolutePath,
  validateUrlTemplate,
} from './openwith.ts';
import type { OpenEnv } from './openwith.ts';

describe('ganymedeOpenUrl', () => {
  it('percent-encodes spaces, unicode and URL punctuation', () => {
    expect(ganymedeOpenUrl('/Users/t/My Vault/a b.ipynb')).toBe(
      'ganymede://open?path=%2FUsers%2Ft%2FMy%20Vault%2Fa%20b.ipynb',
    );
    expect(ganymedeOpenUrl('/v/ü日本#1?x=1&y.ipynb')).toBe(
      'ganymede://open?path=%2Fv%2F%C3%BC%E6%97%A5%E6%9C%AC%231%3Fx%3D1%26y.ipynb',
    );
  });
});

describe('validateUrlTemplate', () => {
  it.each([
    'myapp://open?path={path}',
    'obsidian://adv-uri?vault={vault}&filepath={vaultPath}',
    'https://example.com/{name}',
    '  MyApp+x.y-z:{name}  ',
    'x-callback://go',
  ])('accepts %s', t => {
    expect(validateUrlTemplate(t)).toEqual({ ok: true });
  });

  it.each([
    'javascript:alert(1)',
    ' JavaScript:alert(1)',
    'data:text/html,hi',
    'DATA:text/html,hi',
    'file:///etc/passwd',
    'vbscript:x',
    '\tjavascript:alert(1)',
  ])('rejects the blocked scheme in %j', t => {
    const r = validateUrlTemplate(t);
    expect(r.ok).toBe(false);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['no scheme', 'no scheme'],
    ['/relative/{path}', 'no scheme'],
    ['{path}:x', 'placeholder as scheme'],
    ['{vault}://x', 'placeholder as scheme'],
    ['java script:alert(1)', 'space in scheme'],
    ['java\nscript:alert(1)', 'newline in scheme'],
    ['java\tscript:alert(1)', 'tab in scheme'],
    ['\u0001javascript:alert(1)', 'control character first'],
    ['1app:x', 'starts with a digit'],
    ['myapp://x?{nope}', 'unknown placeholder'],
    ['myapp://x y', 'space in the template'],
    ['myapp://a\tb', 'tab in the template'],
    ['myapp:// x', 'space after the scheme'],
    ['myapp://a\nb', 'newline in the template'],
    ['myapp://a\u0000b', 'NUL in the template'],
    ['myapp://a\u007fb', 'DEL in the template'],
    ['myapp://a\u00a0b', 'no-break space in the template'],
  ])('rejects %j (%s)', t => {
    expect(validateUrlTemplate(t).ok).toBe(false);
  });

  it('names the reason', () => {
    const r = validateUrlTemplate('javascript:x');
    expect(r).toEqual({ ok: false, reason: 'The javascript: scheme is not allowed.' });
  });
});

describe('buildCustomUrl', () => {
  const values = {
    path: '/Users/t/My Vault/Notes/a b.ipynb',
    vaultPath: 'Notes/a b.ipynb',
    vault: 'My Vault',
    name: 'a b.ipynb',
  };

  it('substitutes and percent-encodes every placeholder', () => {
    expect(
      buildCustomUrl('myapp://open?p={path}&v={vaultPath}&n={name}&vault={vault}', values),
    ).toBe(
      'myapp://open?p=%2FUsers%2Ft%2FMy%20Vault%2FNotes%2Fa%20b.ipynb&v=Notes%2Fa%20b.ipynb&n=a%20b.ipynb&vault=My%20Vault',
    );
  });

  it('replaces a placeholder used more than once and trims the template', () => {
    expect(buildCustomUrl('  x:{name}{name}  ', values)).toBe('x:a%20b.ipynba%20b.ipynb');
  });

  it('cannot be redirected by a value that looks like a scheme or a placeholder', () => {
    const evil = { ...values, name: 'javascript:alert(1)', vault: '{path}' };
    expect(buildCustomUrl('myapp://x?n={name}&v={vault}', evil)).toBe(
      'myapp://x?n=javascript%3Aalert(1)&v=%7Bpath%7D',
    );
    expect(buildCustomUrl('{name}', evil)).toBeNull();
  });

  it('returns null for an invalid template, or {path} without a path', () => {
    expect(buildCustomUrl('javascript:{name}', values)).toBeNull();
    expect(buildCustomUrl('myapp://{path}', { ...values, path: undefined })).toBeNull();
    expect(buildCustomUrl('myapp://{name}', { ...values, path: undefined })).toBe(
      'myapp://a%20b.ipynb',
    );
  });

  it('knows which templates need the absolute path', () => {
    expect(usesAbsolutePath('x://{path}')).toBe(true);
    expect(usesAbsolutePath('x://{vaultPath}')).toBe(false);
  });
});

describe('resolveOpenAction', () => {
  const env = (o: Partial<OpenEnv> = {}): OpenEnv => ({
    isMacOS: true,
    isDesktopApp: true,
    hasFilePath: true,
    hasOpenWithDefaultApp: true,
    ...o,
  });
  const ganymede = { openWith: 'ganymede' as const, customUrl: '' };

  it.each([
    ['mac desktop', env(), true],
    [
      'iPad (isMacOS, not the desktop app)',
      env({ isDesktopApp: false, hasFilePath: false }),
      false,
    ],
    ['iPhone', env({ isMacOS: false, isDesktopApp: false, hasFilePath: false }), false],
    ['Windows or Linux desktop', env({ isMacOS: false }), false],
    ['no file-system path', env({ hasFilePath: false }), false],
  ])('Ganymede on %s', (_n, e, offered) => {
    expect(resolveOpenAction(ganymede, e)?.label ?? null).toBe(offered ? 'Open in Ganymede' : null);
  });

  it('offers the system app on any desktop with a path and openWithDefaultApp', () => {
    const s = { openWith: 'system' as const, customUrl: '' };
    expect(resolveOpenAction(s, env({ isMacOS: false }))).toEqual({
      kind: 'system',
      label: 'Open in default app',
    });
    expect(resolveOpenAction(s, env({ hasOpenWithDefaultApp: false }))).toBeNull();
    expect(resolveOpenAction(s, env({ isDesktopApp: false }))).toBeNull();
    expect(resolveOpenAction(s, env({ hasFilePath: false }))).toBeNull();
  });

  it('offers a custom URL on mobile only without {path}', () => {
    const mobile = env({ isDesktopApp: false, isMacOS: false, hasFilePath: false });
    const withName = { openWith: 'custom' as const, customUrl: 'myapp://{vaultPath}' };
    const withPath = { openWith: 'custom' as const, customUrl: 'myapp://{path}' };
    expect(resolveOpenAction(withName, mobile)).toEqual({
      kind: 'custom',
      label: 'Open externally',
    });
    expect(resolveOpenAction(withPath, mobile)).toBeNull();
    expect(resolveOpenAction(withPath, env())?.kind).toBe('custom');
  });

  it('offers nothing for an invalid custom template, or for Off', () => {
    expect(resolveOpenAction({ openWith: 'custom', customUrl: 'javascript:x' }, env())).toBeNull();
    expect(resolveOpenAction({ openWith: 'custom', customUrl: '' }, env())).toBeNull();
    expect(resolveOpenAction({ openWith: 'off', customUrl: 'x:y' }, env())).toBeNull();
  });
});
