## 2026-11-15, Obsidian notebook viewer (#636)

Step 1 of the Obsidian notebook library spike: `packages/obsidian`, a
read-only Obsidian plugin that opens `.ipynb` files in a vault on desktop
and mobile. The vault syncs through Obsidian Sync, so notebooks reach
the iPad and iPhone without Ganymede's help, and Ganymede stays the
runtime. It is installed by copying `dist/` into
`<vault>/.obsidian/plugins/ganymede-notebooks/`, not through Obsidian's
directory.

`src/notebook.ts` parses nbformat 4 into a model (no DOM, no Obsidian):
source as a string or a list, missing fields, unknown cell types as raw,
ANSI removed from streams and tracebacks, and one representation chosen
per output by MIME preference (Ganymede's named result, SVG, bitmaps,
HTML, Markdown, JSON, plain text: the same relative order as Ganymede's
HTML export for the types both show; empty HTML, Markdown and SVG, and
bitmaps that aren't base64, fall through to the next type). `src/render.ts` builds the DOM from
it and takes an optional highlighter callback, so it is tested under
jsdom; `src/viewlogic.ts` holds the view's decisions for the same reason. `src/view.ts` is the `FileView`; it re-renders on the vault's
modify event, which is how Sync updates arrive.

Security: Obsidian desktop is Electron with Node access, so an output
that ran script would be code execution. HTML outputs go in an iframe
with an empty `sandbox`, `referrerpolicy="no-referrer"` and a CSP meta
(`default-src 'none'`; a clicked link can still navigate the frame, and no
script runs); SVG only
as an `<img>` data URL; bitmaps only for a fixed list of types; text
through `textContent`; no `innerHTML` with notebook content. The
iframe has a fixed, resizable height because no script can report one.
Code cells never go through Obsidian's MarkdownRenderer, whose output
every plugin's post-processors see (Execute Code adds run buttons, for
one): the plugin builds `pre > code` with `textContent` and calls
Obsidian's Prism on it. The language is lowercased (`deno` maps to
`typescript`) and used only if it is a plain token (`[a-z0-9+#-]`), as a
class and a Prism lookup.

Markdown cells and outputs don't go through Obsidian's renderer, which
runs other plugins' processors (Dataview JS, inline `$=` queries) and
passes raw HTML through. `src/markdown.ts` parses with `marked`, reads
the HTML with `DOMParser`, and copies only allowlisted elements and
attributes (http, https, mailto and `#` links; `data:` PNG, JPEG, GIF
and WebP images). The trade-off is no wikilinks, embeds or callouts in
notebook Markdown. Math (`$…$`, `$$…$$`, not in code) is swapped for
placeholders before `marked` and restored as literal source in a
`nbl-math` span, so `*` and `_` in it survive; it isn't typeset.
`marked` 17.0.6, already in the lockfile through
JupyterLab, is bundled into `main.js`.

The notebook sits in Obsidian's reading-view root classes so the theme
styles it. Code cells are folded under a `Code [n]` summary, as in
Ganymede's published `code=folded`; a header action toggles them all. Expanded cells stay expanded across
a re-render, matched by cell id (else position); modify events re-render
after 300 ms of quiet, and Prism loads once per view.
Charts get a white background so they read in dark themes.

SVG outputs get the `xmlns` (and `xmlns:xlink`) that Observable Plot's
serializer leaves out, by the rule of Ganymede's HTML exporter, since an
`<img>` can't draw them without it.

"Open in Ganymede" (`ganymede://open?path=`) is added only on macOS
desktop with a file-system vault; on iPad and iPhone Ganymede can't read
Obsidian's sandbox. The action uses the `ganymede://open` URL the Mac
app already handles (`AppURL.swift`, `AppURLHandler.swift`, #471), so
the apps need no change for it.

`npm run check` type-checks and builds the package; the build job always
runs, so `scripts/ci-changes.sh` skips the app jobs for changes only
under `packages/obsidian/`. The `obsidian` typings package (1.14.4) and `marked` are
the only new dependencies; it pins `@codemirror/view` 6.43.13 as a peer, so
npm installs a second, types-only copy under `packages/obsidian`.

Checked by hand: an earlier build of this branch loaded in Obsidian on
a Mac and rendered a journal. Not verified in a run, only from the
typings: `loadPrism`, the `FileView` load and unload order,
`registerExtensions`, `getConfig('readableLineLength')`, `window.open`
with a `ganymede://` URL, and `minAppVersion` 1.5.0. The view's
`onunload` timer clear and `invalidate()` are a backstop to the
file-close path, which the tests cover; they have no test of their own. Next: step 2, pointing the journal plugin and the
Mac app at a vault folder and using it for a while (check Obsidian Sync's
"Sync all other types" setting and its file size limit); step 3, search
inside notebooks (a plugin index or Markdown summaries).

## 2026-11-15, Notebook Library: search, links, embeds, outline, settings (obsidian-notebooks#1)

The plugin is renamed **Notebook Library** (manifest id `notebook-library`,
install path `.obsidian/plugins/notebook-library/`, CSS prefix `nbl-`,
view type `notebook-library-view`). Ganymede is one "Open with" choice,
not the brand. An install of the old `ganymede-notebooks` id is a
different plugin to Obsidian: copy the new folder and disable the old one.

**Model.** `parseNotebook` now keeps every cell's id (Markdown and raw as
well as code) and a `meta` with title, kernel, tags and the latest
execution time. Tags are strings from `metadata.tags` and from
`metadata.ganymede.tags`; nothing in this repo's history or code defines a
Ganymede metadata convention, so `ganymede.tags` is a guess at one and is
read only when it is an array of strings. Cells in the DOM carry
`data-cell-index` and `data-cell-id`, which search, links, the outline and
embeds scroll by.

**Search** (`search.ts`, `library.ts`, `searchmodal.ts`). `NotebookIndex`
(pure) holds per-cell source and text outputs and answers queries: words
split on whitespace, case-insensitive, all in one cell; score is
occurrences (each word capped at 5) plus 10 per word in the file name and
4 per word in a heading of the cell; ties by path then cell order. The
snippet is cut around the earliest match and returned as matched and
unmatched segments, which the modal builds with `textContent` and `<mark>`.
`NotebookLibrary` reads files and follows create, modify (1 s debounce),
delete and rename. Each path has a generation number, so a read that
finishes after a newer change, a delete or a rename is dropped; a read
also checks that the file is still at its path, because a folder delete or
rename may not report the files inside. Events before the first build are
ignored, since the build reads current state. The build runs once the
workspace is ready on desktop and on the first search on mobile, yielding
to the UI every 5 files; files over 20 MB are recorded and not read.
Choosing a result opens the file with `eState` `{ notebookCell: { id,
index } }`; the id wins over a stale index.

**Links and embeds** (`outline.ts`, `embeds.ts`). `parseSubpath`,
`selectCells` and `resolveTarget` are pure: `#Heading` (a section runs to
the next Markdown cell with a heading of the same or a higher level),
`#A#B`, `#^id`. The view applies a target after the render, so a target
that arrives first (Obsidian can set state before `onLoadFile` finishes)
waits, and a re-render does not scroll again. An embed is a
`MarkdownRenderChild` that draws the selected cells with `renderNotebook`
in a box with `max-height: 30em`, a link that opens the notebook at the
same subpath, and a redraw on modify and on settings changes. Known
limit: heading matching ignores case and the characters Obsidian strips
from link text, but not other differences (for example inline math in a
heading).

**Outline** (`outlineview.ts`). A right-sidebar `ItemView` reading
`NotebookView.headings`; the plugin tells it when a notebook renders, and
it also redraws on `active-leaf-change` and `layout-change`. Heading
extraction skips fenced code (a fence closes on the same character, at
least as long) and does not read setext headings.

**Settings** (`settings.ts`, `settingstab.ts`, `openwith.ts`). Saved data
is merged field by field, so a mistyped value in `data.json` falls back to
its default. The custom URL template is checked after trimming: a plain
scheme token then `:`, no whitespace or control characters, not
`javascript`, `data`, `file` or `vbscript`, and only known placeholders.
Values are percent-encoded in one pass. Ganymede stays macOS desktop
only; System default app and a custom URL with `{path}` need a
file-system vault on desktop; a custom URL without `{path}` is offered on
mobile. The header action is replaced when the setting changes.

Not verified in a real Obsidian; only the typings and jsdom tests. These
use APIs that are not in `obsidian.d.ts` 1.14.4 or behaviour the typings
do not state:

- `app.embedRegistry.registerExtension('ipynb', (ctx, file, subpath) =>
  component)` and `unregisterExtension`: the factory's arguments, that
  `ctx.containerEl` is the element to fill, and that Obsidian calls
  `loadFile()` on the returned component (the embed also renders from
  `onload`, once). Feature-detected; the fallback is a Markdown
  post-processor on `.internal-embed[src]`, whose attribute format is also
  an assumption.
- `app.openWithDefaultApp(path)` with a vault-relative path
  (feature-detected).
- `vault.getConfig('readableLineLength')` (already used).
- That `[[nb.ipynb#Heading]]` reaches `setEphemeralState` as
  `{ subpath: '#Heading' }`, and that `openFile(file, { eState })`
  delivers `eState` to a view that is already open.
- That renaming a folder reports the folder (and possibly each file);
  the library handles both.
- `window.open` with a custom scheme from Obsidian mobile.
- Obsidian's reading-view embed placeholder being replaceable
  (`replaceChildren`) without Obsidian putting its content back.

Pre-push review fixes: `applyOpen` now sets or clears `open` from the
captured state (a cell the reader collapsed stays collapsed with fold off),
and the view ignores the captured state when the fold setting changed since
the last render. Text settings save 500 ms after the last keystroke (and on
closing the tab); the custom URL save only re-decides header actions. A
failed render clears the view's notebook model, so the outline and pending
targets don't act on the old file.
