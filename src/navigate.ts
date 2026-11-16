import { TFile } from 'obsidian';
import type { App } from 'obsidian';

/** Open a notebook in the current tab; `eState` reaches the view's setEphemeralState. */
export async function openNotebook(
  app: App,
  path: string,
  eState: Record<string, unknown>,
): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return false;
  await app.workspace.getLeaf(false).openFile(file, { eState });
  return true;
}
