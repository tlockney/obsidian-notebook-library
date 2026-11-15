import { loadPrism } from 'obsidian';
import type { Highlight } from './render.ts';

interface PrismLike {
  languages: Record<string, unknown>;
  highlightElement(el: Element): void;
}

/** Obsidian's Prism, or undefined: code then shows as plain text. */
export async function prismHighlighter(): Promise<Highlight | undefined> {
  try {
    const prism = (await loadPrism()) as PrismLike | undefined;
    if (!prism?.languages || typeof prism.highlightElement !== 'function') return undefined;
    return (code, lang) => {
      if (prism.languages[lang]) prism.highlightElement(code);
    };
  } catch (e) {
    console.warn('Notebook Library: Prism unavailable, showing code unhighlighted', e);
    return undefined;
  }
}
