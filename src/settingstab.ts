import { Notice, PluginSettingTab, Setting } from 'obsidian';
import type { App, Plugin } from 'obsidian';
import { validateUrlTemplate } from './openwith.ts';
import { OPEN_WITH_VALUES } from './settings.ts';
import type { OpenWith, Settings } from './settings.ts';

export interface SettingsHost extends Plugin {
  settings: Settings;
  /**
   * Save, and redraw open notebooks, embeds and header actions; or with
   * 'actions', save and only re-decide the header actions.
   */
  saveSettings(scope?: 'actions'): Promise<void>;
}

/** Text fields save this long after the last keystroke, not on each one. */
export const SAVE_DEBOUNCE_MS = 500;

const OPEN_WITH_LABELS: Record<OpenWith, string> = {
  ganymede: 'Ganymede',
  system: 'System default app',
  custom: 'Custom URL',
  off: 'Off',
};

export class NotebookSettingTab extends PluginSettingTab {
  private readonly pending = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; run: () => void }
  >();

  constructor(
    app: App,
    private readonly plugin: SettingsHost,
  ) {
    super(app, plugin);
  }

  /** Save; a failed write is reported, not lost in a rejected promise. */
  private async save(scope?: 'actions'): Promise<void> {
    try {
      await (scope ? this.plugin.saveSettings(scope) : this.plugin.saveSettings());
    } catch (e) {
      console.error('Notebook Library: could not save settings', e);
      new Notice('Notebook Library: could not save settings');
    }
  }

  /** Run `run` after a quiet time; a newer call for the same key replaces it. */
  private later(key: string, run: () => void): void {
    clearTimeout(this.pending.get(key)?.timer);
    const timer = setTimeout(() => {
      this.pending.delete(key);
      run();
    }, SAVE_DEBOUNCE_MS);
    this.pending.set(key, { timer, run });
  }

  /** Closing the tab saves what is still waiting. */
  hide(): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const w of waiting) {
      clearTimeout(w.timer);
      w.run();
    }
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Fold code cells by default')
      .setDesc('Code stays behind a "Code" summary until you open it.')
      .addToggle(t =>
        t.setValue(s.foldCode).onChange(async v => {
          s.foldCode = v;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Show execution counts')
      .setDesc('Show [n] after "Code".')
      .addToggle(t =>
        t.setValue(s.showCounts).onChange(async v => {
          s.showCounts = v;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Long output limit')
      .setDesc(
        'Lines of text, stream and error output shown before "Show more". 0 shows everything.',
      )
      .addText(t =>
        t.setValue(String(s.maxOutputLines)).onChange(v => {
          const n = Number(v.trim());
          if (v.trim() === '' || !Number.isInteger(n) || n < 0 || n > 100000) return;
          s.maxOutputLines = n;
          this.later('maxOutputLines', () => void this.save());
        }),
      );

    new Setting(containerEl)
      .setName('Search text outputs')
      .setDesc('Also search stream and plain-text outputs, not only cell source.')
      .addToggle(t =>
        t.setValue(s.searchOutputs).onChange(async v => {
          s.searchOutputs = v;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Open with')
      .setDesc(
        "The action in a notebook's header. Ganymede is macOS desktop only; System default app is desktop only.",
      )
      .addDropdown(d => {
        for (const v of OPEN_WITH_VALUES) d.addOption(v, OPEN_WITH_LABELS[v]);
        d.setValue(s.openWith).onChange(async v => {
          s.openWith = v as OpenWith;
          await this.save();
          this.display();
        });
      });

    if (s.openWith === 'custom') {
      const check = validateUrlTemplate(s.customUrl);
      const setting = new Setting(containerEl)
        .setName('Custom URL')
        .setDesc(
          'Placeholders: {path} (absolute path, desktop only), {vaultPath}, {vault}, {name}. Values are percent-encoded. javascript:, data:, file: and vbscript: are refused.',
        )
        .addText(t =>
          t
            .setPlaceholder('myapp://open?path={path}')
            .setValue(s.customUrl)
            .onChange(v => {
              s.customUrl = v;
              // Only the header actions depend on the template.
              this.later('customUrl', () => void this.save('actions'));
              const r = validateUrlTemplate(v);
              problem.textContent = r.ok ? '' : r.reason;
            }),
        );
      const problem = setting.descEl.ownerDocument.createElement('div');
      problem.className = 'nbl-setting-error';
      problem.textContent = check.ok || !s.customUrl ? '' : check.reason;
      setting.descEl.appendChild(problem);
    }
  }
}
