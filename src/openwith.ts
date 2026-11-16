// "Open with": which external action to offer and the URL it opens. Pure: no
// Obsidian, so the URL building and the scheme check can be tested.

import type { Settings } from './settings.ts';

/** The Mac app's link: an absolute path. The Mac app refuses `folder=` links. */
export function ganymedeOpenUrl(fullPath: string): string {
  return `ganymede://open?path=${encodeURIComponent(fullPath)}`;
}

/**
 * The iPad and iPhone link: the name of a folder the person granted in
 * Ganymede (matched exactly against its last path component) and the file's
 * path relative to that folder. Both values are encoded, so a `/` in the file
 * path becomes %2F; the app decodes query values.
 */
export function ganymedeFolderUrl(vaultFolderName: string, vaultRelativePath: string): string {
  return `ganymede://open?folder=${encodeURIComponent(vaultFolderName)}&file=${encodeURIComponent(vaultRelativePath)}`;
}

/** Schemes a template may never use: they run script or reach local files. */
export const BLOCKED_SCHEMES = ['javascript', 'data', 'file', 'vbscript'];

const PLACEHOLDER = /\{([^{}]*)\}/g;
const KNOWN = ['path', 'vaultPath', 'vault', 'name'];
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

export type TemplateCheck = { ok: true } | { ok: false; reason: string };

/**
 * A custom URL template is valid when, after trimming, it starts with a plain
 * scheme token and ':' (no placeholder, no space or control character), the
 * scheme isn't one of BLOCKED_SCHEMES, and every `{...}` is a known
 * placeholder. Values are percent-encoded when substituted, so they can't
 * change the scheme.
 */
export function validateUrlTemplate(template: string): TemplateCheck {
  const t = template.trim();
  if (!t) return { ok: false, reason: 'Enter a URL template.' };
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(t)) {
    return { ok: false, reason: 'The template may not contain spaces or control characters.' };
  }
  const m = SCHEME.exec(t);
  if (!m) return { ok: false, reason: 'Start with a scheme such as myapp: or https:.' };
  if (BLOCKED_SCHEMES.includes(m[1].toLowerCase())) {
    return { ok: false, reason: `The ${m[1].toLowerCase()}: scheme is not allowed.` };
  }
  for (const p of t.matchAll(PLACEHOLDER)) {
    if (!KNOWN.includes(p[1])) {
      return { ok: false, reason: `Unknown placeholder {${p[1]}}.` };
    }
  }
  return { ok: true };
}

/** Whether the template needs the file's absolute path (a desktop file-system vault). */
export function usesAbsolutePath(template: string): boolean {
  return template.includes('{path}');
}

export interface UrlValues {
  /** Absolute path; undefined when the vault has no file-system path. */
  path?: string;
  vaultPath: string;
  vault: string;
  name: string;
}

/** The template with each placeholder replaced by its percent-encoded value, or null if invalid. */
export function buildCustomUrl(template: string, values: UrlValues): string | null {
  if (!validateUrlTemplate(template).ok) return null;
  if (usesAbsolutePath(template) && values.path === undefined) return null;
  const t = template.trim();
  // One pass: a substituted value is never scanned for placeholders again.
  return t.replace(PLACEHOLDER, (_all, key: string) =>
    encodeURIComponent(
      key === 'path' ? (values.path ?? '') : (values[key as keyof UrlValues] ?? ''),
    ),
  );
}

export interface OpenEnv {
  isMacOS: boolean;
  isDesktopApp: boolean;
  /** Obsidian on iPad or iPhone (`Platform.isIosApp`). iPad also reports `isMacOS`. */
  isIosApp: boolean;
  /** The vault is on a file system, so an absolute path exists. */
  hasFilePath: boolean;
  /** `app.openWithDefaultApp` exists in this Obsidian. */
  hasOpenWithDefaultApp: boolean;
}

export type OpenAction =
  | {
      kind: 'ganymede';
      label: string;
      /** `path`: absolute path (Mac app). `folder`: granted folder name plus relative path (iPad, iPhone). */
      form: 'path' | 'folder';
    }
  | { kind: 'system' | 'custom'; label: string };

/**
 * The action the header offers, or null for none. Ganymede: macOS desktop,
 * where the Mac app handles ganymede:// and can read the vault (path form);
 * iPad and iPhone, where the app reads a folder the person granted (folder
 * form; checked first because an iPad also reports isMacOS). Never Android,
 * Windows or Linux. System app:
 * desktop with a path and Obsidian's openWithDefaultApp. Custom URL: an
 * invalid template offers nothing; one using {path} needs a desktop path.
 */
export function resolveOpenAction(
  settings: Pick<Settings, 'openWith' | 'customUrl'>,
  env: OpenEnv,
): OpenAction | null {
  const desktopPath = env.isDesktopApp && env.hasFilePath;
  switch (settings.openWith) {
    case 'ganymede':
      if (env.isIosApp) return { kind: 'ganymede', label: 'Open in Ganymede', form: 'folder' };
      return env.isMacOS && desktopPath
        ? { kind: 'ganymede', label: 'Open in Ganymede', form: 'path' }
        : null;
    case 'system':
      return desktopPath && env.hasOpenWithDefaultApp
        ? { kind: 'system', label: 'Open in default app' }
        : null;
    case 'custom': {
      if (!validateUrlTemplate(settings.customUrl).ok) return null;
      if (usesAbsolutePath(settings.customUrl) && !desktopPath) return null;
      return { kind: 'custom', label: 'Open externally' };
    }
    default:
      return null;
  }
}
