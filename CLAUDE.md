# CLAUDE.md — Dims (Figma plugin)

Context for any session picking this up. Read this first; it captures the design
decisions and the dead ends we already ruled out, so we don't re-litigate them.

**Status:** **v2 — runtime-verified in Figma; v2.1 variants pending Figma check.** Both
orientations build, stretch, and recompute correctly. Architecture moved from per-child
*constraints* (v1) to **auto-layout Fill/Hug/Fixed** (v2) — see
[docs/auto-layout.md](docs/auto-layout.md) for the full node tree and the three hard-won
gotchas. Arrow mappings and both label-tighten heuristics are runtime-confirmed.

**v2.1** adds two orthogonal style modifiers on top of `orient`: **`flip`** (mirror — H
above↔below, V right↔left) and **`labelStyle: standard|inline`** (inline = the label breaks
the line, arrows on the outer ends only). One builder, 8 combos. Details in the
[variants section](docs/auto-layout.md#variants-flip-and-labelstyle-v21). The one new
primitive — per-vertex `strokeCap` on inline segments under Fill-stretch — is
**runtime-confirmed** via a `use_figma` prototype (outer-end arrows, clean inner ends, even
101.5px split). Full 8-combo drop from the plugin still wants an end-to-end eyeball.

---

## What it is

A CAD-style **dimension annotation tool** for Figma, which has no native equivalent.
Jon (industrial design / mechanical engineering) uses Figma for technical-ish
drawings and wants to drop well-formatted dimension callouts (line, arrows, witness/
extension lines, a value label) that read like real drafting and carry **real-world
units**, not screen pixels.

The core framing that drove every decision: **this is a formatting engine, not a
measurement engine.** The plugin's job is to construct one perfectly-formatted,
correctly-constrained dimension object; Figma's own resize machinery then does the
stretching/dragging natively. The only thing the plugin has to keep doing after
construction is keep the *number* correct.

---

## Approaches we ruled out (do not revisit without new information)

- **Click two arbitrary points on the canvas.** Not possible. Plugins get no canvas
  pointer/click event. The only cursor data is `figma.activeUsers[].position`, a stale
  snapshot that's null when the mouse isn't over the canvas — not a click stream.
- **Pick two vertices in vector edit mode.** The Plugin API does **not** expose which
  vertices are selected in edit mode (confirmed, long-standing). Vertex *geometry* is
  readable (`vectorNetwork.vertices` + `absoluteTransform`), but you can't know which
  ones the user selected.
- **Fully parametric dimension that auto-updates after a drag when the plugin is
  closed.** Plugins don't run in the background. Live update only works while the UI is
  open; on reopen we recalc.
- **Bounding-box selection (like the figma-measure plugin).** Rejected because Jon's
  targets are often loose vectors, not tidy boxes.

## The approach we chose

A **self-contained dimension = an auto-layout FrameNode** whose children use Fill/Hug/
Fixed sizing. Figma reflows it natively in both axes when the user resizes the frame —
no constraints, no rotation. The plugin constructs it once; the label value recomputes
**live while open** (`documentchange`) and **on reopen** (scan + recalc).

> v1 used per-child `constraints` (STRETCH/CENTER/MIN/MAX). That is **gone** — replaced
> because Jon hand-built the parametric auto-layout version and it's cleaner. Don't
> reintroduce constraints; the auto-layout model dissolved the old fragility risks
> (zero-thickness line under STRETCH, flaky vertical constraints).

---

## Architecture

Each dimension is an auto-layout `FrameNode` (transparent, `clipsContent = false`).
**Full node tree, sizing table, and the build-order gotchas are in
[docs/auto-layout.md](docs/auto-layout.md)** — read it before touching `buildDimension`.
The essentials:

- **H** = vertical stack `[Text · Extension Outside · Dim · Extension Inside]`;
  **V** = the rotated row. The **inside Extension band grows** (`FILL` on the length
  axis) to reach the feature; everything else stays fixed. Bands and the line `FILL` the
  measured axis.
- **Dimension line** — open vector (`windingRule: 'NONE'`), `strokeCap = arrowStyle`.
- **Witness/extension lines** — open **vectors** (not rectangles), so thickness stays
  stroke-adjustable by hand. Split into `Extension Outside` (fixed overshoot stubs) and
  `Extension Inside` (grows toward feature). Knobs: `witnessGap`, `witnessOvershoot`.
- **Label** — a text node inside a `Text` wrapper frame whose fixed short cross-size
  (`fontSize * TEXT_TIGHTEN_*`) makes the text spill toward the line, tightening the gap.
  `recalcLabel` reloads the label's own font before rewriting (font ownership rule, as
  with units).

**Three gotchas that WILL bite** (details in the sub-doc): (1) `resize()` resets both
axes to Fixed — apply Fill/Hug **last**; (2) nested bands keep a **stale 0** on their
Fill axis, fixed by a **settle pass** (`settleBand`) after the whole tree is built;
(3) `documentchange` must be registered only **after** `loadAllPagesAsync()`.

**Arrows use native stroke caps, not vector arrowheads** — `strokeCap` scales with weight
and stretches for free. UI offers 5 as single words (Line/Triangle/Reversed/Circle/
Diamond → `ARROW_LINES`/`ARROW_EQUILATERAL`/`TRIANGLE_FILLED`/`CIRCLE_FILLED`/
`DIAMOND_FILLED`). Line style also rounds the extension-line ends (`strokeCap='ROUND'`).
**Trade-off:** arrow size isn't independently tunable (couple-to-weight was Jon's call).

**Measured span = `frame.width` (H) or `frame.height` (V).** Displayed value =
`(span / dpi) * PER_INCH[unit] / scale` — canvas inches = pixels / DPI, converted to the
unit (`PER_INCH`: in 1, ft 1/12, mm 25.4, cm 2.54, m 0.0254), then divided by drawing
`scale` (0.25 = quarter-scale → labels read 4× larger).

### Self-describing via pluginData (this is what makes reopen-recalc work)

The frame stores its own parameters, and each child stores its role, under the `hcd:`
namespace (Human Crafted):

```
hcd:isDimension   "1"        (on the frame)
hcd:orientation   "H" | "V"  (on the frame)
hcd:labelStyle    "standard" | "inline"  (on the frame)
hcd:flip          "1"|"0" — mirrored to the far side  (on the frame)
hcd:dpi           px per inch (Figma baseline 72)  (on the frame)
hcd:unit          "in" | "ft" | "mm" | "cm" | "m"  (on the frame)
hcd:scale         float — drawing scale, value ÷= scale  (on the frame)
hcd:decimals      int        (on the frame)
hcd:showUnit      "1"|"0"    (on the frame)
hcd:role          "line" | "witness" | "label" | "extension" | "text" | "inline"  (on children)
```

`labelStyle`/`flip` are stored for self-description; recalc doesn't need them (measured span
is still `frame.width`/`height` in every variant, so the label math is variant-agnostic).

Because each dimension carries its own dpi/unit, **old dimensions keep their original
units even after the global defaults change** (toggling the unit in the panel only
affects the *next* dimension dropped, not existing ones). Recalc looks up children by their role
tag, not by child order (robust to reordering).

### Settings persistence

Global **default** settings live in `figma.clientStorage` (per-user, per-machine).
Per-dimension params live in pluginData on the frame (above). UI edits push a `settings`
message; code merges, saves to clientStorage, and applies to the *next* drop.

### Live update (loop-guarded)

`figma.on('documentchange')`:
- only active when the `live` setting is on;
- filters to `PROPERTY_CHANGE` on `width`/`height` of frames flagged `hcd:isDimension`;
- diffs the newly computed value against the current label text before writing;
- wraps the write in a module-level `suppress` flag.

That diff + suppress combination prevents the label write from feeding back and
retriggering. The handler is registered in `init()` **after an unconditional**
`await figma.loadAllPagesAsync()` — under `documentAccess: dynamic-page` registration
itself throws otherwise (not just cross-page firing). Never register at module top level.

### Reopen recalc

`init()` on startup scans `currentPage` for `hcd:isDimension` frames and refreshes each
label (`recalcAll`). This runs automatically on open — there is no manual recalc button
(the label value is also kept live while open via `documentchange`).

### Select all / Update selected (restyle existing dims)

Two footer buttons operate on placed dims:

- **Select all** → selects every `hcd:isDimension` frame on `currentPage`.
- **Update selected Dims** → re-applies the current UI settings to each selected dim.

"Update" is a **rebuild**, not a surgical mutation: `updateDimension` reads the dim's own
stored `orient`/`labelStyle`/`flip`, calls `createDimensionRoot` (the extracted core of
`buildDimension`) with the *current* settings, resizes the new frame to the old
**footprint** (position, parent + z-order via `insertChild`, and width/height so the
measured span is preserved), removes the old, and `recalcLabel`s. Rebuilding guarantees
every setting — including **font size, which drives layout** — lands correctly, which a
field-by-field mutation wouldn't. The build-then-`resize()`-in-one-pass reflow is
runtime-confirmed via `use_figma` (nested Fill bands reflow to nonzero after the resize;
no stale-0). Pre-v2.1 dims (no `labelStyle`/`flip` data) rebuild as standard non-flip,
matching their original geometry.

---

## Files

```
manifest.json   name "Dims". editorType: figma, documentAccess: dynamic-page,
                networkAccess none, main: code.js, ui: ui.html.
                id is a placeholder — fine for local dev, only matters at publish.
code.ts         all plugin logic. Compiles to code.js (which Figma actually runs).
ui.html         control panel: a fixed "Drop a dimension" heading + 4x2 Variant grid (8
                SVG-icon drop buttons, one per orient x labelStyle x flip combo), then four
                collapsible <details> settings sections (Line & arrows, Label, Witness
                lines, Units) — COLLAPSED by default — plus a live toggle and two footer
                buttons (Select all / Update selected Dims). No in-UI branding. The UI posts
                its content height (measured from
                the last element's offset — body can stretch to the iframe) on load and on
                every section toggle; code calls figma.ui.resize so the window tracks it.
                postMessage <-> code.
logo.svg        128x128 badge logo (dark rounded square + white dimension mark). This is the
                PUBLISH icon source — the plugin window title-bar icon can ONLY be set at
                publish time (uploaded on the publishing page); there is no manifest/API/CSS
                way to set it for a local dev build, and the window frame isn't customizable.
tsconfig.json   compiles code.ts. strict: true (flip to false as an escape hatch).
                lib must NOT include DOM (collides with @figma/plugin-typings'
                console/fetch globals — TS2451). See docs/auto-layout.md.
package.json    name "figma-dims". devDeps: @figma/plugin-typings, typescript.
                scripts: build, watch.
```

## Build & run

```bash
cd <folder-with-all-files>
npm install      # needs Node
npm run watch    # code.ts -> code.js, recompiles on save
```

Figma **desktop app** (required — plugin dev reads local files):
Plugins → Development → Import plugin from manifest… → pick `manifest.json` → run.
`Cmd+Opt+P` re-runs the last plugin. Figma does not hot-reload — re-run after each
compile. Runtime errors surface in Plugins → Development → Show/Hide console.

---

## Key constants / tuning knobs (in code.ts)

- `COLOR` — dimension color. **Not yet a UI control** (see next steps).
- `FONT` = Inter Regular — fallback only. Actual label font/size come from the
  `fontFamily` + `fontSize` settings (UI controls). `resolveFont(family)` picks the
  "Regular" style if present, else the family's first available style; falls back to
  `FONT` if the family can't be resolved or `loadFontAsync` throws. Family list comes
  from `figma.listAvailableFontsAsync()` (cached in `availableFonts`, sent to the UI on
  init so the dropdown only offers loadable fonts).
- `LEN` = 240 (default measured span), `INSIDE` = 40 (default inside-band reach, grows).
  The feature-side standoff is `witnessGap` (a setting), applied via `featurePad()` as
  padding between the growing inside band and the frame edge — H bottom/top, V left/right,
  following orient + flip.
- `TEXT_TIGHTEN_H` = 0.7 (H label wrapper height as a fraction of font size — text spills
  down toward the line), `TEXT_TIGHTEN_V` = 0.4 (V: wrapper narrower than the text by this
  fraction — text spills left toward the line). Both are runtime-confirmed to look right;
  simple font-relative heuristics, tunable if the look should change.
- `Settings`: `thickness`, `arrowStyle`, `labelStyle`, `flip`, `fontFamily`, `fontSize`,
  `witnessGap`, `witnessOvershoot`, `dpi`, `unit`, `scale`, `decimals`, `showUnit`, `live`.
  Units use a DPI field + unit toggle (in/ft/mm/cm/m) via `PER_INCH`; `scale` is a text
  field that parses decimals, whole numbers, or fractions (`1/4`). `labelStyle` + `flip` are
  **not** editable fields — each of the 8 Variant-grid buttons carries its own `orient` +
  `labelStyle` + `flip`, sent with the `create` message; code folds them into `settings`
  (so they persist and land in pluginData) just before building. `witnessGap` drives
  `featurePad()` — the standoff between the witness line and the feature — on every variant
  (H and V, standard and inline).

## Open threads / next candidates

- **Verify v2.1 variants end-to-end in Figma** — drop all 8 combos (H/V × standard/inline
  × flip) from the plugin and resize each. The per-vertex arrow-cap primitive is already
  confirmed; what's left to eyeball is the full assembly, especially **V-inline** (the
  symmetric extrapolation not drawn in the reference). Then mark the Status line verified.
- **Rounded extension ends** — currently Line-style only; other styles may want it.
- **Color control** — currently the `COLOR` constant; promote to the UI. (Jon flagged
  this as the likely next add.)
- **Feature tracking** — the dimension is freestanding; it does not attach to or
  auto-follow another object. True tracking needs an anchor/association layer. Phase two.
- **Vertical label orientation** — currently upright beside the line; option to rotate
  it to read along the line.
- **Arrow sizing** — coupled to stroke weight by design; text-height sizing would mean
  reintroducing vector arrowheads.

## Future concept: size-input mode (units -> px)

Requested feature: type a real-world size like "12 cm" and have it applied as pixels to
a node — what Illustrator/InDesign allow but Figma doesn't.

**Native limitation (verified).** Figma's W/H fields are pixel-only. They evaluate basic
arithmetic (`100+50`) but not unit suffixes, and there is no document-level unit setting.
A plugin **cannot** augment the native fields — plugins have no access to Figma's
property-panel inputs. So this must live in the plugin's own input, never the native UI.

**It's the inverse of the dimension engine — same machinery.** Display math is
`value = px / dpi * PER_INCH[unit]`; size input is the inverse:

```
px = value / PER_INCH[unit] * dpi
```

Same `PER_INCH` table, same `dpi` setting. Build it as another **mode of this same
plugin**, not a separate tool: one direction reads sizes out (dimensions), the other
writes sizes in (resize / create).

**Behavior:** parse a unit value, convert to px, then either `resize()` the current
selection or create a frame at that size. Offer a keep-aspect toggle (set one axis,
scale the other from the current ratio). Optionally echo the selection's current size in
the chosen unit.

**Interaction options:**
- Panel W/H fields (fuller, mouse-friendly).
- `figma.parameters` quick-action input — type "12cm" in the command bar, keyboard-only;
  closest to the "type in a field" feel. Could ship both.

**DPI gotcha (the thing to get right).** Figma's canvas is 72 DPI; a "12 in" object is
864 px and only prints as 12 in if exported at 72. Existing unit plugins have been burned
by the 72-vs-export-DPI mismatch (a 12" frame exporting as 16" is 72->96). Read the same
`dpi` setting the dimension mode uses so both stay consistent.

**Prior art (reference, don't necessarily reinvent):** Easy Units, "Convert real
dimensions to pixels," Units to Pixels, Millimeters, Unit Converter & Frame Creator.

**Status:** concept only. The core dimension stack is now verified (v2), so this is
unblocked — but the `scale` field already shipped and shares `PER_INCH`/`dpi`, so build
size-input as the inverse mode on top of that, reusing the same math.

## Provenance

Written from the official Figma Plugin API docs. The `figma-measure` open-source plugin
was a *conceptual* reference only (proof of feasibility; contrast case for its
bounding-box selection model) — **no code was copied from it.** If any technique is ever
lifted from it later, check its license (MIT per its repo, but confirm) and attribute.
