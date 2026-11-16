# Notebook Library for Obsidian

A read-only [Obsidian](https://obsidian.md) plugin that turns the `.ipynb`
notebooks in a vault into a library: open, search, link to and embed
them, on desktop and mobile (iPad, iPhone). It works with any notebook
tool; [Ganymede](https://github.com/tlockney/ganymede) is one of the apps
it can hand a notebook to (see Open with). It started as a spike in
[ganymede-ui#636](https://github.com/tlockney/ganymede-ui/issues/636) and
moved here with its history; [docs/history.md](docs/history.md) is the
design log from that spike. It is not yet published to Obsidian's plugin
directory.

## Install

The plugin isn't in Obsidian's plugin directory and has no release yet,
so you build it and copy three files into your vault. It needs Obsidian
1.5.0 or later, and, to build, git and [Node.js](https://nodejs.org)
22.12 or later (`npm run check` needs 22.22 or later).

1. Build it:

   ```sh
   git clone https://github.com/tlockney/obsidian-notebook-library.git
   cd obsidian-notebook-library
   npm ci
   npm run build
   ```

   This writes `dist/` with `main.js`, `manifest.json` and `styles.css`.

2. Find your vault's plugin folder, `.obsidian/plugins/` inside the vault
   folder. The easiest way: in Obsidian, open Settings › Community
   plugins and click the folder icon next to **Installed plugins**, which
   opens it. Otherwise, right-click a note at the top level of the file
   list, choose **Reveal in Finder** (**Show in system explorer** on
   Windows and Linux), and open `.obsidian` there. Its name starts with a
   dot, so it is hidden by default (in the macOS Finder, Cmd+Shift+.
   shows it). In a vault with no community plugins yet, create the
   `plugins` folder.

3. In the plugins folder, make a folder named `notebook-library` (it must
   match the plugin id) and copy `main.js`, `manifest.json` and
   `styles.css` from `dist/` into it, in Finder or Explorer, or on macOS
   and Linux:

   ```sh
   VAULT="$HOME/path/to/your/vault"
   mkdir -p "$VAULT/.obsidian/plugins/notebook-library"
   cp dist/main.js dist/manifest.json dist/styles.css \
     "$VAULT/.obsidian/plugins/notebook-library/"
   ```

4. In Obsidian, open Settings › Community plugins. If it says Restricted
   mode is on, click **Turn on community plugins**. Click the reload
   button next to **Installed plugins** (or restart Obsidian), then turn
   on **Notebook Library**.

5. Open any `.ipynb` file in the vault. **Search notebooks** and
   **Show notebook outline** are in the command palette (Cmd/Ctrl+P), and
   the plugin's settings are under Settings › Notebook Library.

To update, build again, copy the three files over the old ones, and run
**Reload app without saving** from the command palette, or restart
Obsidian. On other devices, restart Obsidian once the new files have
synced.

### iPad and iPhone

Mobile Obsidian can't build the plugin, so install it on a desktop first,
then sync the vault to the device:

- **Obsidian Sync:** on each device, under Settings › Sync › Vault
  configuration sync, turn on **Installed community plugins** (and
  **Active community plugin list** to sync which plugins are on). Under
  Selective sync, turn on **Sync all other types** so `.ipynb` files
  sync. Restart Obsidian on the device after the first sync. Check Sync's
  file size limit for your plan: notebooks with large outputs can exceed
  it.
- **iCloud:** the `.obsidian/plugins/notebook-library` folder syncs with
  the vault like any other folder. (On iPhone and iPad, Obsidian reads
  only vaults on the device or in iCloud.)

Then, if the plugin isn't on yet, turn on **Notebook Library** under
Settings › Community plugins on the device, as in step 4.

## Development

```sh
npm ci
npm run check   # lint, type-check, tests, build
```

## What it shows

- A header with the notebook's title (`metadata.title`, else the first
  `#` heading of its first Markdown cell, else the file name), kernel
  (`kernelspec.display_name`, else the language), last run (the latest
  `metadata.execution` time of any cell, when Jupyter recorded one) and
  tags (strings in `metadata.tags` or `metadata.ganymede.tags`). All of it
  is shown as text.
- Markdown cells, rendered by the plugin (see Security) and styled by Obsidian's reading-view CSS.
- Code cells folded under a `Code [n]` summary (a header action shows or hides all code), syntax-highlighted with Obsidian's Prism when it knows the language (plain text otherwise). The language is used only as a class and a Prism lookup, and only if it is a plain token.
- Outputs: streams, errors (ANSI colors removed), plain text, JSON,
  Markdown, images (PNG, JPEG, GIF, WebP, SVG) and HTML. SVG from kernels that omit the `xmlns` attribute (Observable Plot's) gets it added, as Ganymede's HTML exporter does, so it draws. Ganymede's named
  results (`application/vnd.ganymede.result+json`) show as `name = value`.
  When an output has several representations, one is chosen: Ganymede
  result (with a non-empty name), SVG, bitmap, HTML, Markdown, JSON, plain text: the same relative order as Ganymede's HTML export for the types both show. Empty HTML, Markdown and SVG, and bitmaps whose data isn't base64, are skipped for the next type. Consecutive outputs of one stream are merged and carriage returns overwrite (progress bars). An error shows its traceback, or `name: value` without one. Long text, stream and error outputs stop after a number of lines (a setting) with a **Show more** button. Images in Markdown cells given as `attachment:` names show for PNG, JPEG, GIF and WebP. Code cells you expanded stay expanded when the file changes (matched by cell id, else position); a change re-renders after 300 ms of quiet. Math (`$…$`, `$$…$$`) shows as its source, not typeset.
- Changes that arrive while a notebook is open, such as from Obsidian
  Sync, re-render it. A notebook that can't be read shows why in the
  view.

## Search

**Search notebooks** (command palette) searches every `.ipynb` in the
vault. Each cell is one unit: the query is split into words, and a cell
matches when it contains all of them, in any order, ignoring case. A cell
counts its source (Markdown and code) and, with **Search text outputs**
on, its stream and plain-text outputs (the text of an output that is
drawn as an image or HTML is not searched). Results are ranked by how often the words occur, with extra
weight for words in the file name and in a Markdown heading of the cell.
Each shows the file name, the cell's kind and number, and a snippet
around the first match. Choosing one opens the notebook, scrolls to the
cell and highlights it briefly.

The index is built when Obsidian's workspace is ready on desktop, and on
the first search on mobile, so opening the app never reads every
notebook. It follows create, modify (after 1 s of quiet), delete and
rename events. Notebooks over 20 MB are not read; when a search finds
nothing, the box says how many were skipped. The index lives in memory and is rebuilt each launch.

## Links and embeds

- `[[nb.ipynb#Heading]]` opens the notebook scrolled to a Markdown
  heading. A heading's section runs from its cell to the next Markdown
  cell that has a heading of the same or a higher level. `[[nb.ipynb#A#B]]`
  finds B after A. Heading text matches ignoring case and the marks
  Obsidian drops from links (`# | ^ : % [ ]`). Setext headings (underlined
  with `===` or `---`) are not recognised, and headings in fenced code are
  ignored.
- `[[nb.ipynb#^cell-id]]` points at one cell by its nbformat 4.5 `id`.
- `![[nb.ipynb]]`, `![[nb.ipynb#Heading]]` and `![[nb.ipynb#^cell-id]]`
  draw the notebook, the section or the cell inside the note, in a box
  that scrolls past 30 em, with an **Open** link to the full notebook. An
  embed follows the settings and redraws when the file changes. Embeds
  have no header. A notebook over 5 MB isn't drawn inside a note (it
  would stall mobile); the embed says so and keeps the Open link.

Embeds use Obsidian's internal embed registry when this version has one,
and otherwise a Markdown post-processor that fills the placeholder in
reading view. Either way the notebook is drawn by the plugin's own
renderer, not Obsidian's.

## Outline

**Show notebook outline** opens a right-sidebar view listing the Markdown
headings of the active notebook, indented by level. Clicking one scrolls
the notebook to its cell. It follows the active notebook and updates when
the notebook re-renders.

## Settings

| Setting | Default | |
|---|---|---|
| Fold code cells by default | on | Code starts folded under its summary. |
| Show execution counts | on | `[n]` after "Code". |
| Long output limit | 40 | Lines of text, stream and error output before **Show more**; 0 shows everything. |
| Search text outputs | on | Include outputs in search. |
| Open with | Ganymede | See below. |

Changing a setting redraws open notebooks and embeds; text fields save 0.5 s after you stop typing, and the custom URL only updates the header action. Code cells you expanded or collapsed keep that state across a redraw, except when the fold setting itself changed.

### Open with

The header action opens the notebook in another app:

- **Ganymede** (default): action "Open in Ganymede".
  - macOS desktop: `ganymede://open?path=<absolute path>`, which the Mac app
    handles.
  - iPad and iPhone: `ganymede://open?folder=<vault name>&file=<path in the
    vault>`. Ganymede must have the vault folder, once: grant it in
    Ganymede under Settings › Link Folders, or choose Grant Access… when the
    first link asks. The folder name has to match the vault's name exactly.
    Not offered on Android, Windows or Linux.

  > [!NOTE]
  > **Unreleased.** Needs a Ganymede build that includes
  > [ganymede-ui#640](https://github.com/tlockney/ganymede-ui/issues/640);
  > no release has it yet. Until then the action is offered on iPad and
  > iPhone but Ganymede doesn't open the notebook.
- **System default app**: Obsidian's `openWithDefaultApp`, on desktop
  only, and only when this Obsidian has it. Action: "Open in default app".
- **Custom URL**: a template with `{path}` (absolute path), `{vaultPath}`
  (path inside the vault), `{vault}` (vault name) and `{name}` (file name),
  each percent-encoded when filled in. The template must start with a
  plain scheme and `:`, may not contain spaces or control characters, and
  may not use `javascript:`, `data:`, `file:` or `vbscript:`; the settings
  page says why a template is refused, and none is offered until it is
  valid. `{path}` needs a file-system vault on desktop; a template without
  it also works on mobile. Action: "Open externally".
- **Off**: no action.

## What it does not do

No running, no editing, no widgets (they show their plain-text fallback or
an "unsupported output" note), no LaTeX or JavaScript outputs. Only
nbformat 4 is read. Search covers cell source and text outputs, not
images, HTML or error tracebacks.

## Security

Obsidian's desktop app is Electron with Node access, so a script that
ran from a notebook output would run with the person's privileges. The
viewer therefore:

- renders HTML outputs only in an `<iframe sandbox="">` (no scripts, no
  same-origin access), `referrerpolicy="no-referrer"`, whose document
  carries a Content-Security-Policy of
  `default-src 'none'; img-src data:; style-src 'unsafe-inline'`. A link
  clicked inside an HTML output can still navigate the frame (no script
  runs there);
- shows SVG only as an `<img>` data URL, never inline, and bitmaps only
  for the listed image types;
- puts text, stream and error output in `<pre>` through `textContent`;
- never sets `innerHTML` with notebook content.

Markdown cells and Markdown outputs are untrusted too, and Obsidian's own
renderer would run other plugins' processors on them (Dataview JS, inline
`$=` queries) and pass raw HTML through. So the plugin renders them itself:
`marked` (bundled, the plugin's only runtime dependency) parses them, the
HTML is read with `DOMParser` (inert), and only allowlisted elements and
attributes are copied into the page. Scripts, frames, objects, SVG and
styles are dropped; links keep only `http:`, `https:`, `mailto:` and `#`;
images keep only `data:` PNG, JPEG, GIF and WebP, and any other image
shows its alt text. Trade-off: no wikilinks, embeds or callouts in
notebook Markdown. Code cells don't go through Obsidian's Markdown renderer
either, since every plugin's post-processors would see them: the plugin
builds `<pre><code>` with `textContent` and only then asks Prism to
highlight it, for a plain-token language. External links open in a new
window with `rel="noopener noreferrer"`.

The new surfaces follow the same rules. Search snippets, file names,
headings, header fields, outline entries and the "Show more" button are
built with `textContent`, never `innerHTML` or Obsidian's
MarkdownRenderer. Embeds draw through the same renderer as the view. The
search index and the settings are plain data; nothing from a notebook is
evaluated. A custom "Open with" URL is built only from the template you
typed and percent-encoded values (a value can't change the scheme), and
`javascript:`, `data:`, `file:` and `vbscript:` templates are refused.
