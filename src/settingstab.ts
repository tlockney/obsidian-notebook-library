import { PluginSettingTab, Setting } from 'obsidian';
import type { App, Plugin } from 'obsidian';
import { validateUrlTemplate } from './openwith.ts';
import { OPEN_WITH_VALUES } from './settings.ts';
import type { OpenWith, Settings } from './settings.ts';

export interface SettingsHost extends Plugin {
  settings: Settings;
  /** Save, and redraw open notebooks, embeds and header actions. */
  saveSettings(): Promise<void>;
}

const OPEN_WITH_LABELS: Record<OpenWith, string> = {
  ganymede: 'Ganymede',
  system: 'System default app',
  custom: 'Custom URL',
  off: 'Off',
};

export class NotebookSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: SettingsHost,
  ) {
    super(app, plugin);
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
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Show execution counts')
      .setDesc('Show [n] after "Code".')
      .addToggle(t =>
        t.setValue(s.showCounts).onChange(async v => {
          s.showCounts = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Long output limit')
      .setDesc(
        'Lines of text, stream and error output shown before "Show more". 0 shows everything.',
      )
      .addText(t =>
        t.setValue(String(s.maxOutputLines)).onChange(async v => {
          const n = Number(v.trim());
          if (v.trim() === '' || !Number.isInteger(n) || n < 0 || n > 100000) return;
          s.maxOutputLines = n;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Search text outputs')
      .setDesc('Also search stream and plain-text outputs, not only cell source.')
      .addToggle(t =>
        t.setValue(s.searchOutputs).onChange(async v => {
          s.searchOutputs = v;
          await this.plugin.saveSettings();
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
          await this.plugin.saveSettings();
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
            .onChange(async v => {
              s.customUrl = v;
              await this.plugin.saveSettings();
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
