import { describe, expect, it } from 'vitest';
import { renderSafeMarkdown } from './markdown.ts';

function md(src: string): HTMLElement {
  const el = document.createElement('div');
  document.body.replaceChildren(el);
  renderSafeMarkdown(src, el);
  return el;
}

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('renderSafeMarkdown', () => {
  it('wraps output in the classes Obsidian styles', () => {
    const el = md('hi');
    const wrap = el.firstElementChild!;
    expect(wrap.classList.contains('markdown-rendered')).toBe(true);
    expect(wrap.classList.contains('nbl-markdown')).toBe(true);
  });

  it('renders headings and emphasis', () => {
    const el = md('# Title\n\nsome *em* and **strong** and ~~gone~~');
    expect(el.querySelector('h1')!.textContent).toBe('Title');
    expect(el.querySelector('em')!.textContent).toBe('em');
    expect(el.querySelector('strong')!.textContent).toBe('strong');
    expect(el.querySelector('del')!.textContent).toBe('gone');
  });

  it('drops a script tag with its contents', () => {
    const el = md('before\n\n<script>alert("pwn")</script>\n\nafter');
    expect(el.querySelector('script')).toBeNull();
    expect(el.textContent).not.toContain('pwn');
    expect(el.textContent).toContain('before');
    expect(el.textContent).toContain('after');
  });

  it('drops style, iframe, object, embed and svg with their contents', () => {
    const el = md(
      '<style>x{}</style><iframe src="https://e.test/x">ifr</iframe><object data="x">obj</object><embed src="x"><svg><text>svgtext</text></svg>\n\nok',
    );
    for (const t of ['style', 'iframe', 'object', 'embed', 'svg']) {
      expect(el.querySelector(t), t).toBeNull();
    }
    expect(el.textContent).not.toMatch(/ifr|obj|svgtext/);
    expect(el.textContent).toContain('ok');
  });

  it('replaces an http image with its alt text', () => {
    const el = md('<img src="https://x/y.png" alt="a">');
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent?.trim()).toBe('a');
    const el2 = md('![alt2](https://x/y.png)');
    expect(el2.querySelector('img')).toBeNull();
    expect(el2.textContent?.trim()).toBe('alt2');
  });

  it('keeps a data:image/png image', () => {
    const el = md(`![pic](${PNG})`);
    expect(el.querySelector('img')!.getAttribute('src')).toBe(PNG);
    expect(el.querySelector('img')!.getAttribute('alt')).toBe('pic');
  });

  it('drops a data:image/svg+xml image', () => {
    const el = md('<img src="data:image/svg+xml;base64,PHN2Zz4=" alt="s">');
    expect(el.querySelector('img')).toBeNull();
  });

  it('removes javascript: and data: hrefs but keeps the link text', () => {
    const el = md(
      '[a](javascript:alert(1)) [b](data:text/html;base64,AAAA) <a href="  JaVa\nScript:alert(1)">c</a>',
    );
    expect(el.querySelectorAll('a[href]')).toHaveLength(0);
    expect(el.textContent).toContain('a');
    expect(el.textContent).toContain('b');
    expect(el.textContent).toContain('c');
  });

  it('keeps http, https, mailto and fragment links with rel set', () => {
    const el = md(
      '[a](https://e.test) [b](http://e.test) [c](mailto:x@e.test) <a href="#frag">d</a>',
    );
    const hrefs = [...el.querySelectorAll('a')].map(a => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://e.test', 'http://e.test', 'mailto:x@e.test', '#frag']);
    for (const a of el.querySelectorAll('a')) {
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
    const [web, plain, mail, frag] = [...el.querySelectorAll('a')];
    for (const a of [web, plain]) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.className).toBe('external-link');
    }
    for (const a of [mail, frag]) {
      expect(a.hasAttribute('target')).toBe(false);
      expect(a.className).toBe('');
    }
  });

  it('rejects control characters in a scheme, as a browser would', () => {
    const el = md(
      '<a href="java\u0001script:alert(1)">a</a> <a href="h\u0001ttps://x">b</a> <a href="ht\ttps://x.test">c</a> <a href="\u0001 https://y.test">d</a>',
    );
    const hrefs = [...el.querySelectorAll('a[href]')].map(a => a.getAttribute('href'));
    // A tab inside is removed by browsers, so it is https; a stray control character is not.
    expect(hrefs).toEqual(['https://x.test', 'https://y.test']);
    expect(el.querySelector('a[href="https://x.test"]')!.getAttribute('target')).toBe('_blank');
  });

  it('strips onclick, style, class and id', () => {
    const el = md('<p onclick="x()" style="color:red" class="c" id="i">t</p>');
    const p = el.querySelector('p')!;
    expect(p.textContent).toBe('t');
    expect(p.getAttributeNames()).toEqual([]);
  });

  it('renders a dataviewjs fence as an inert pre/code', () => {
    const el = md('```dataviewjs\ndv.paragraph(app.vault)\n```');
    const code = el.querySelector('pre > code')!;
    expect(code.textContent).toBe('dv.paragraph(app.vault)\n');
    expect(code.className).toBe('');
    expect(el.querySelector('pre')!.className).toBe('');
  });

  it('keeps inline $= queries as literal code', () => {
    const el = md('see `$= dv.pages().length` here');
    expect(el.querySelector('code')!.textContent).toBe('$= dv.pages().length');
    expect(el.querySelector('code')!.className).toBe('');
  });

  it('renders a GFM table with th, td and align', () => {
    const el = md('| a | b |\n|:--|--:|\n| 1 | 2 |');
    expect(el.querySelectorAll('th')).toHaveLength(2);
    expect(el.querySelectorAll('td')).toHaveLength(2);
    expect(el.querySelector('th')!.getAttribute('align')).toBe('left');
    expect(el.querySelectorAll('th')[1].getAttribute('align')).toBe('right');
    expect(el.querySelector('td')!.textContent).toBe('1');
  });

  it('renders task lists with disabled checkboxes', () => {
    const el = md('- [x] done\n- [ ] todo');
    const boxes = el.querySelectorAll('input');
    expect(boxes).toHaveLength(2);
    for (const b of boxes) {
      expect(b.getAttribute('type')).toBe('checkbox');
      expect(b.hasAttribute('disabled')).toBe(true);
    }
    expect(boxes[0].hasAttribute('checked')).toBe(true);
    expect(boxes[1].hasAttribute('checked')).toBe(false);
  });

  it('drops other inputs', () => {
    expect(
      md('<input type="text" value="x"><input type="file">').querySelector('input'),
    ).toBeNull();
  });

  it('keeps the text of an unknown nested tag', () => {
    const el = md('<custom-box>inner <em>text</em></custom-box>');
    expect(el.querySelector('custom-box')).toBeNull();
    expect(el.textContent?.trim()).toBe('inner text');
    expect(el.querySelector('em')!.textContent).toBe('text');
  });

  it('resolves attachment: images to bitmap data URLs only', () => {
    const el = document.createElement('div');
    renderSafeMarkdown(
      '![p](attachment:a.png) ![s](attachment:b.svg) ![m](attachment:none.png) <img src="attachment:my%20pic.png" alt="sp">',
      el,
      {
        'a.png': PNG,
        'b.svg': 'data:image/svg+xml;base64,PHN2Zz4=',
        'my pic.png': PNG,
      },
    );
    const imgs = [...el.querySelectorAll('img')];
    expect(imgs.map(i => i.getAttribute('src'))).toEqual([PNG, PNG]);
    expect(el.textContent).toContain('s');
    expect(el.textContent).toContain('m');
  });

  describe('math stays literal', () => {
    const math = (src: string) => md(src).querySelectorAll('.nbl-math');

    it('inline math keeps its asterisks', () => {
      const el = md('see $a*b*c$ here');
      expect(el.querySelector('em')).toBeNull();
      expect(el.querySelector('.nbl-math')!.textContent).toBe('$a*b*c$');
      expect(el.textContent?.trim()).toBe('see $a*b*c$ here');
    });

    it('display math keeps backslashes and underscores', () => {
      const el = md('before\n\n$$ a \\\\ b_1 + c_2 $$\n\nafter');
      expect(el.querySelector('.nbl-math')!.textContent).toBe('$$ a \\\\ b_1 + c_2 $$');
      expect(el.querySelector('em')).toBeNull();
    });

    it('multiline display math survives', () => {
      const el = md('$$\nx_1 *y*\n$$');
      expect(el.querySelector('.nbl-math')!.textContent).toBe('$$\nx_1 *y*\n$$');
    });

    it('escaped dollars and prices are not math', () => {
      expect(math('\\$5 and \\$6')).toHaveLength(0);
      expect(md('\\$5 and \\$6').textContent?.trim()).toBe('$5 and $6');
      expect(math('it costs $5 and $6 today')).toHaveLength(0);
      expect(math('a $ b * c $ d')).toHaveLength(0);
    });

    it('math is not taken from code', () => {
      const el = md('`$a*b*c$`\n\n```\n$x_1$ $$y$$\n```');
      expect(el.querySelectorAll('.nbl-math')).toHaveLength(0);
      expect(el.querySelectorAll('code')[0].textContent).toBe('$a*b*c$');
      expect(el.querySelector('pre code')!.textContent).toBe('$x_1$ $$y$$\n');
    });

    it('math is not taken from indented code', () => {
      const el = md('text\n\n    $x_1$ and $$y$$\n    $z*w*$\n\nafter $a*b*c$');
      expect(el.querySelector('pre code')!.textContent).toBe('$x_1$ and $$y$$\n$z*w*$\n');
      const spans = el.querySelectorAll('.nbl-math');
      expect(spans).toHaveLength(1);
      expect(spans[0].textContent).toBe('$a*b*c$');
      expect(md('\t$q_1$').querySelectorAll('.nbl-math')).toHaveLength(0);
      expect(md('\t$q_1$').querySelector('pre code')!.textContent).toBe('$q_1$\n');
    });

    it('indented code after a heading or after mixed indents is code', () => {
      const h = md('# H\n    $a*b*$');
      expect(h.querySelector('pre code')!.textContent).toBe('$a*b*$\n');
      expect(h.querySelectorAll('.nbl-math')).toHaveLength(0);
      const t = md('  \t$a_1$');
      expect(t.querySelector('pre code')!.textContent).toContain('$a_1$');
      expect(t.querySelectorAll('.nbl-math')).toHaveLength(0);
    });

    it('math in a loose list item continuation stays math', () => {
      const el = md('1. step\n\n    where $a*b*c$ holds\n');
      expect(el.querySelector('pre')).toBeNull();
      expect(el.querySelector('em')).toBeNull();
      expect(el.querySelector('.nbl-math')!.textContent).toBe('$a*b*c$');
    });

    it('an indented line in a paragraph is not code, so its math stays math', () => {
      const el = md('para\n    $a*b*c$ still the paragraph');
      expect(el.querySelector('pre')).toBeNull();
      expect(el.querySelector('.nbl-math')!.textContent).toBe('$a*b*c$');
    });

    it('literal text with the old marker is not mangled', () => {
      const el = md('zzgnbmath0zz then $a*b*c$ and zzgnbmath1zz');
      expect(el.textContent?.trim()).toBe('zzgnbmath0zz then $a*b*c$ and zzgnbmath1zz');
      expect(el.querySelectorAll('.nbl-math')).toHaveLength(1);
    });

    it('literal private-use characters are kept and cannot forge a placeholder', () => {
      const src = '0 and  then $a*b*c$ 0';
      const el = md(src);
      expect(el.textContent?.trim()).toBe(src);
      const spans = el.querySelectorAll('.nbl-math');
      expect(spans).toHaveLength(1);
      expect(spans[0].textContent).toBe('$a*b*c$');
    });

    it.each(['&#xE000;', '&#57344;', '&#XE000;'])(
      'numeric reference %s cannot forge a placeholder',
      ref => {
        const el = md(`${ref}0${ref} $a*b*c$`);
        expect(el.querySelectorAll('.nbl-math')).toHaveLength(1);
        expect(el.textContent?.trim()).toBe('0 $a*b*c$');
      },
    );

    it('math is not taken from raw HTML pre', () => {
      const el = md('<pre>\n$a*b*c$\n</pre>');
      expect(el.querySelectorAll('.nbl-math')).toHaveLength(0);
      expect(el.querySelector('pre')!.textContent).toContain('$a*b*c$');
    });

    it('math in image alt and link title is restored as source', () => {
      const img = md('![a $x_1$ b](data:image/png;base64,iVBORw0KGgo=)').querySelector('img')!;
      expect(img.getAttribute('alt')).toBe('a $x_1$ b');
      const a = md('[t](https://x "a $x_1$ b")').querySelector('a')!;
      expect(a.getAttribute('title')).toBe('a $x_1$ b');
    });

    it('with every private-use character in the text, math is left as is', () => {
      let all = '';
      for (let c = 0xe000; c <= 0xf8ff; c++) all += String.fromCharCode(c);
      const el = md(`${all} $a*b*c$`);
      expect(el.querySelectorAll('.nbl-math')).toHaveLength(0);
      expect(el.textContent).toContain(all);
    });

    it('the math span is text, never markup', () => {
      const el = md('$<b>x</b>$');
      expect(el.querySelector('b')).toBeNull();
      expect(el.querySelector('.nbl-math')!.textContent).toBe('$<b>x</b>$');
    });
  });

  it('keeps only numeric colspan and rowspan', () => {
    const el = md('<table><tr><td colspan="2" rowspan="x" onclick="1">c</td></tr></table>');
    const td = el.querySelector('td')!;
    expect(td.getAttribute('colspan')).toBe('2');
    expect(td.hasAttribute('rowspan')).toBe(false);
    expect(td.hasAttribute('onclick')).toBe(false);
  });
});
