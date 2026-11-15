import { describe, expect, it, vi } from 'vitest';
import { OUTLINE_VIEW_TYPE, OutlineView } from './outlineview.ts';
import type { NotebookView } from './view.ts';

function setup(view: Partial<NotebookView> | null) {
  const handlers: Record<string, () => void> = {};
  const app = {
    workspace: {
      on: (name: string, cb: () => void) => ((handlers[name] = cb), { name, cb }),
    },
  };
  const host = { currentNotebookView: vi.fn(() => view as NotebookView | null) };
  const outline = new OutlineView({ app } as never, host);
  return { outline, host, handlers, el: outline.contentEl };
}

const items = (el: HTMLElement) =>
  Array.from(el.querySelectorAll<HTMLElement>('.nbl-outline-item'));

describe('OutlineView', () => {
  it('lists headings indented by level relative to the shallowest', async () => {
    const { outline, el } = setup({
      headings: [
        { cellIndex: 0, level: 2, text: 'Top' },
        { cellIndex: 1, level: 3, text: 'Child' },
        { cellIndex: 2, level: 4, text: 'Grandchild' },
        { cellIndex: 3, level: 2, text: 'Next' },
      ],
    });
    await outline.onOpen();
    expect(items(el).map(i => i.textContent)).toEqual(['Top', 'Child', 'Grandchild', 'Next']);
    expect(items(el).map(i => i.style.paddingLeft)).toEqual(['8px', '24px', '40px', '8px']);
    expect(outline.getViewType()).toBe(OUTLINE_VIEW_TYPE);
  });

  it('scrolls the notebook to the clicked heading', async () => {
    const scrollToCell = vi.fn();
    const { outline, el } = setup({
      headings: [
        { cellIndex: 4, level: 1, text: 'A' },
        { cellIndex: 9, level: 1, text: 'B' },
      ],
      scrollToCell,
    });
    await outline.onOpen();
    items(el)[1].click();
    expect(scrollToCell).toHaveBeenCalledWith(9);
  });

  it('sets heading text with textContent, never as markup', async () => {
    const { outline, el } = setup({
      headings: [{ cellIndex: 0, level: 1, text: '<img src=x onerror=alert(1)>' }],
    });
    await outline.onOpen();
    expect(el.querySelector('img')).toBeNull();
    expect(items(el)[0].textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('says what is missing: no notebook, or no headings', async () => {
    const none = setup(null);
    await none.outline.onOpen();
    expect(none.el.textContent).toBe('Open a notebook to see its outline.');
    const empty = setup({ headings: [] });
    await empty.outline.onOpen();
    expect(empty.el.textContent).toBe('No headings in this notebook.');
  });

  it('redraws on active-leaf-change and layout-change', async () => {
    const view = { headings: [{ cellIndex: 0, level: 1, text: 'Old' }] };
    const { outline, handlers, el } = setup(view);
    await outline.onOpen();
    view.headings = [{ cellIndex: 0, level: 1, text: 'New' }];
    handlers['active-leaf-change']();
    expect(items(el).map(i => i.textContent)).toEqual(['New']);
    view.headings = [{ cellIndex: 0, level: 1, text: 'Newer' }];
    handlers['layout-change']();
    expect(items(el).map(i => i.textContent)).toEqual(['Newer']);
  });
});
