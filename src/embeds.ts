// `![[nb.ipynb]]`, `![[nb.ipynb#Heading]]` and `![[nb.ipynb#^cell-id]]` in a note.
// Notebook content goes through renderNotebook only, never MarkdownRenderer.

import { MarkdownRenderChild, TFile } from 'obsidian';
import type { App, Plugin } from 'obsidian';
import { NotebookError, parseNotebook } from './notebook.ts';
import { openNotebook } from './navigate.ts';
import { parseSubpath, selectCells, splitLinkText } from './outline.ts';
import { renderError, renderNotebook } from './render.ts';
import type { Highlight } from './render.ts';
import type { Settings } from './settings.ts';
import { RenderSequencer } from './viewlogic.ts';

export interface EmbedHost {
  app: App;
  settings: Settings;
  highlighter(): Promise<Highlight | undefined>;
  embeds: Set<NotebookEmbed>;
}

/** The embed area scrolls inside the note past this height. */
export const EMBED_MAX_HEIGHT = '30em';

/** A notebook larger than this is not drawn inside a note. */
export const EMBED_MAX_BYTES = 5 * 1024 * 1024;

export class NotebookEmbed extends MarkdownRenderChild {
  private rendering: Promise<void> | null = null;
  private readonly renders = new RenderSequencer();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly host: EmbedHost,
    containerEl: HTMLElement,
    private readonly file: TFile,
    private readonly subpath: string,
  ) {
    super(containerEl);
  }

  onload(): void {
    this.host.embeds.add(this);
    this.registerEvent(
      this.host.app.vault.on('modify', f => {
        if (f.path !== this.file.path) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.render(), 300);
      }),
    );
    void this.start();
  }

  onunload(): void {
    this.host.embeds.delete(this);
    clearTimeout(this.timer);
    this.renders.invalidate();
  }

  /** Obsidian's embed registry calls this after creating the component. */
  loadFile(): Promise<void> {
    return this.start();
  }

  private start(): Promise<void> {
    return (this.rendering ??= this.render());
  }

  /** Draw again (the file changed, or a setting did). */
  async render(): Promise<void> {
    const token = this.renders.begin();
    const root = this.containerEl;
    root.classList.add('nbl-embed');
    const settings = this.host.settings;
    try {
      const doc = root.ownerDocument;
      const bar = doc.createElement('div');
      bar.className = 'nbl-embed-bar';
      const open = doc.createElement('a');
      open.className = 'nbl-embed-open';
      open.setAttribute('href', '#');
      open.textContent = `Open ${this.file.basename}${this.subpath}`;
      open.addEventListener('click', ev => {
        ev.preventDefault();
        void openNotebook(this.host.app, this.file.path, { subpath: this.subpath });
      });
      bar.appendChild(open);

      const body = doc.createElement('div');
      body.className = 'nbl-embed-body';
      body.style.maxHeight = EMBED_MAX_HEIGHT;
      // An embed draws every cell in the note, so it has a lower cap than search.
      if (this.file.stat.size > EMBED_MAX_BYTES) {
        const big = doc.createElement('p');
        big.className = 'nbl-failure';
        big.textContent = `Too large to embed (over ${EMBED_MAX_BYTES / 1024 / 1024} MB). Open the notebook to read it.`;
        body.appendChild(big);
        root.replaceChildren(bar, body);
        return;
      }
      const [text, highlight] = await Promise.all([
        this.host.app.vault.cachedRead(this.file),
        this.host.highlighter(),
      ]);
      if (!this.renders.isCurrent(token)) return;
      const nb = parseNotebook(text);
      const sub = parseSubpath(this.subpath);
      const cells = sub ? selectCells(nb, sub) : undefined;

      if (sub && !cells) {
        const missing = doc.createElement('p');
        missing.className = 'nbl-failure';
        missing.textContent = `Could not find ${this.subpath} in ${this.file.basename}.`;
        body.appendChild(missing);
      } else {
        renderNotebook(nb, body, highlight, {
          foldCode: settings.foldCode,
          showCounts: settings.showCounts,
          maxOutputLines: settings.maxOutputLines,
          cells: cells ?? undefined,
        });
      }
      root.replaceChildren(bar, body);
    } catch (e) {
      if (!this.renders.isCurrent(token)) return;
      const message =
        e instanceof NotebookError ? e.message : `Could not read the file: ${String(e)}`;
      renderError(root, message);
    }
  }
}

/** The undocumented `app.embedRegistry`, when this Obsidian has it. */
interface EmbedRegistry {
  registerExtension(
    ext: string,
    factory: (ctx: EmbedContext, file: TFile, subpath: string) => unknown,
  ): void;
  unregisterExtension(ext: string): void;
}

interface EmbedContext {
  app?: App;
  containerEl: HTMLElement;
}

export function embedRegistryOf(app: App): EmbedRegistry | null {
  const reg = (app as unknown as { embedRegistry?: Partial<EmbedRegistry> }).embedRegistry;
  return reg &&
    typeof reg.registerExtension === 'function' &&
    typeof reg.unregisterExtension === 'function'
    ? (reg as EmbedRegistry)
    : null;
}

/**
 * Make `![[x.ipynb]]` render the notebook. Obsidian's embed registry is the
 * way when it exists; else a Markdown post-processor fills the
 * `.internal-embed` placeholders of reading view. Returns which was used.
 */
export function registerNotebookEmbeds(
  plugin: Plugin,
  host: EmbedHost,
): 'registry' | 'post-processor' {
  const registry = embedRegistryOf(plugin.app);
  if (registry) {
    try {
      registry.registerExtension(
        'ipynb',
        (ctx, file, subpath) => new NotebookEmbed(host, ctx.containerEl, file, subpath ?? ''),
      );
      plugin.register(() => registry.unregisterExtension('ipynb'));
      return 'registry';
    } catch (e) {
      console.warn('Notebook Library: embed registry refused .ipynb, using the fallback', e);
    }
  }
  plugin.registerMarkdownPostProcessor((el, ctx) => {
    for (const embed of Array.from(el.querySelectorAll('.internal-embed'))) {
      const { path, subpath } = splitLinkText(embed.getAttribute('src') ?? '');
      if (!/\.ipynb$/i.test(path)) continue;
      const file = host.app.metadataCache.getFirstLinkpathDest(path, ctx.sourcePath);
      if (!(file instanceof TFile)) continue;
      embed.classList.add('is-loaded');
      embed.replaceChildren();
      ctx.addChild(new NotebookEmbed(host, embed as HTMLElement, file, subpath));
    }
  });
  return 'post-processor';
}
