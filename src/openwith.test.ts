import { describe, expect, it } from 'vitest';
import {
  buildCustomUrl,
  ganymedeFolderUrl,
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

describe('ganymedeFolderUrl', () => {
  it('encodes spaces, # ? & % and / in both values', () => {
    expect(ganymedeFolderUrl('My Vault', 'a b/c#1?x=1&y%2.ipynb')).toBe(
      'ganymede://open?folder=My%20Vault&file=a%20b%2Fc%231%3Fx%3D1%26y%252.ipynb',
    );
    expect(ganymedeFolderUrl('a/b#c?d&e%f', 'x.ipynb')).toBe(
      'ganymede://open?folder=a%2Fb%23c%3Fd%26e%25f&file=x.ipynb',
    );
  });

  it('encodes non-ASCII in both values', () => {
    expect(ganymedeFolderUrl('Zürich 日本', 'Notizen/é.ipynb')).toBe(
      'ganymede://open?folder=Z%C3%BCrich%20%E6%97%A5%E6%9C%AC&file=Notizen%2F%C3%A9.ipynb',
    );
  });

  it('round-trips through URL parsing', () => {
    const u = new URL(ganymedeFolderUrl('V&1 #x', 'd 1/n?&#%.ipynb'));
    expect(u.searchParams.get('folder')).toBe('V&1 #x');
    expect(u.searchParams.get('file')).toBe('d 1/n?&#%.ipynb');
    expect(u.searchParams.has('path')).toBe(false);
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
    isIosApp: false,
    hasFilePath: true,
    hasOpenWithDefaultApp: true,
    ...o,
  });
  const ganymede = { openWith: 'ganymede' as const, customUrl: '' };

  it.each([
    ['mac desktop', env(), true],
    ['Android (not iOS, no path)', env({ isMacOS: false, isDesktopApp: false, hasFilePath: false }), false],
    ['iPad without the iOS flag (isMacOS only)', env({ isDesktopApp: false, hasFilePath: false }), false],
    ['Windows or Linux desktop', env({ isMacOS: false }), false],
    ['no file-system path', env({ hasFilePath: false }), false],
  ])('Ganymede on %s', (_n, e, offered) => {
    expect(resolveOpenAction(ganymede, e)?.label ?? null).toBe(offered ? 'Open in Ganymede' : null);
  });

  it('offers the path form on macOS desktop and the folder form on iPad and iPhone', () => {
    expect(resolveOpenAction(ganymede, env())).toEqual({
      kind: 'ganymede',
      label: 'Open in Ganymede',
      form: 'path',
    });
    const ios = { isDesktopApp: false, hasFilePath: false, isIosApp: true };
    // iPad reports isMacOS; iPhone does not. Both get the folder form.
    for (const isMacOS of [true, false]) {
      expect(resolveOpenAction(ganymede, env({ ...ios, isMacOS }))).toEqual({
        kind: 'ganymede',
        label: 'Open in Ganymede',
        form: 'folder',
      });
    }
  });

  it('leaves the other settings unchanged on iOS', () => {
    const ios = env({ isDesktopApp: false, hasFilePath: false, isIosApp: true });
    expect(resolveOpenAction({ openWith: 'system', customUrl: '' }, ios)).toBeNull();
    expect(resolveOpenAction({ openWith: 'off', customUrl: '' }, ios)).toBeNull();
    expect(resolveOpenAction({ openWith: 'custom', customUrl: 'myapp://{path}' }, ios)).toBeNull();
    expect(resolveOpenAction({ openWith: 'custom', customUrl: 'myapp://{name}' }, ios)).toEqual({
      kind: 'custom',
      label: 'Open externally',
    });
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
