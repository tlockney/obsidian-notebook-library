// Vitest resolves `obsidian` here (the real package is types only). It has
// just enough of each class for the plugin's modules to import and run under
// jsdom; tests drive it through the `stub` handles. view.test.ts builds on it
// with vi.mock.

export const stub = {
  notices: [] as string[],
  settingRows: [] as StubSetting[],
};

export const Platform = { isMacOS: true, isDesktopApp: true, isMobile: false };

export class Notice {
  constructor(message: string) {
    stub.notices.push(message);
  }
}

export class TFile {
  basename: string;
  name: string;
  extension: string;
  stat = { size: 0, mtime: 0, ctime: 0 };
  constructor(public path: string) {
    this.name = path.slice(path.lastIndexOf('/') + 1);
    const dot = this.name.lastIndexOf('.');
    this.basename = dot === -1 ? this.name : this.name.slice(0, dot);
    this.extension = dot === -1 ? '' : this.name.slice(dot + 1);
  }
}

export class FileSystemAdapter {
  getFullPath(p: string): string {
    return `/vault/${p}`;
  }
}

type Cb = (...args: never[]) => unknown;

export class Component {
  events: { name: string; cb: Cb }[] = [];
  cleanups: (() => void)[] = [];
  load(): void {}
  onload(): void {}
  onunload(): void {}
  registerEvent(ref: unknown): void {
    this.events.push(ref as never);
  }
  register(cb: () => void): void {
    this.cleanups.push(cb);
  }
}

export class MarkdownRenderChild extends Component {
  constructor(public containerEl: HTMLElement) {
    super();
  }
}

export class Plugin extends Component {
  commands: { id: string; name: string; callback: () => void }[] = [];
  views = new Map<string, unknown>();
  postProcessors: ((el: HTMLElement, ctx: unknown) => void)[] = [];
  data: unknown = null;
  constructor(
    public app: never,
    public manifest: never,
  ) {
    super();
  }
  registerView(type: string, creator: unknown): void {
    this.views.set(type, creator);
  }
  registerExtensions = (_exts: string[], _type: string): void => {};
  registerMarkdownPostProcessor(cb: (el: HTMLElement, ctx: unknown) => void): void {
    this.postProcessors.push(cb);
  }
  addCommand(c: { id: string; name: string; callback: () => void }): void {
    this.commands.push(c);
  }
  addSettingTab(): void {}
  loadData(): Promise<unknown> {
    return Promise.resolve(this.data);
  }
  saveData(d: unknown): Promise<void> {
    this.data = d;
    return Promise.resolve();
  }
}

export class ItemView extends Component {
  contentEl = document.createElement('div');
  app: unknown;
  constructor(public leaf: { app: unknown }) {
    super();
    this.app = leaf.app;
  }
}

export class FileView extends ItemView {
  file: TFile | null = null;
  navigation = false;
  addAction(_icon: string, _title: string, _cb: () => void): HTMLElement {
    return document.createElement('div');
  }
  setEphemeralState(_state: unknown): void {}
}

export abstract class Modal {
  constructor(public app: unknown) {}
  open(): void {}
  close(): void {}
}

export abstract class SuggestModal<T> extends Modal {
  emptyStateText = '';
  placeholder = '';
  setPlaceholder(p: string): void {
    this.placeholder = p;
  }
  abstract getSuggestions(query: string): T[] | Promise<T[]>;
  abstract renderSuggestion(item: T, el: HTMLElement): void;
  abstract onChooseSuggestion(item: T, evt: unknown): void;
}

/** Obsidian adds `empty()` and `addClass()` to every element. */
export function withEmpty<T extends HTMLElement>(
  el: T,
): T & { empty(): void; addClass(c: string): void } {
  return Object.assign(el, {
    empty: () => el.replaceChildren(),
    addClass: (c: string) => el.classList.add(c),
  });
}

export class PluginSettingTab {
  containerEl = withEmpty(document.createElement('div'));
  constructor(
    public app: unknown,
    public plugin: unknown,
  ) {}
}

/** A settings row: its controls keep their onChange handlers for tests to call. */
export class StubSetting {
  name = '';
  desc = '';
  descEl = document.createElement('div');
  controls: {
    kind: string;
    onChange?: (v: never) => unknown;
    value?: unknown;
    options?: string[];
  }[] = [];
  constructor(_container: HTMLElement) {
    stub.settingRows.push(this);
  }
  setName(n: string): this {
    this.name = n;
    return this;
  }
  setDesc(d: string): this {
    this.desc = d;
    return this;
  }
  addToggle(cb: (t: object) => void): this {
    const c: StubSetting['controls'][number] = { kind: 'toggle' };
    this.controls.push(c);
    cb(this.api(c));
    return this;
  }
  private api(c: StubSetting['controls'][number]) {
    const api = {
      setValue: (v: unknown) => ((c.value = v), api),
      onChange: (f: (v: never) => unknown) => ((c.onChange = f), api),
      setPlaceholder: () => api,
    };
    return api;
  }
  addText(cb: (t: object) => void): this {
    const c: StubSetting['controls'][number] = { kind: 'text' };
    this.controls.push(c);
    cb(this.api(c));
    return this;
  }
  addDropdown(cb: (d: object) => void): this {
    const c: StubSetting['controls'][number] = { kind: 'dropdown', options: [] };
    this.controls.push(c);
    const api = {
      addOption: (v: string) => (c.options!.push(v), api),
      setValue: (v: unknown) => ((c.value = v), api),
      onChange: (f: (v: never) => unknown) => ((c.onChange = f), api),
    };
    cb(api);
    return this;
  }
}
export { StubSetting as Setting };

export function loadPrism(): Promise<unknown> {
  return Promise.resolve(undefined);
}
