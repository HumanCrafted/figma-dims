# CLAUDE.md — Dimension Tool (Figma plugin)

Context for any session picking this up. Read this first; it captures the design
decisions and the dead ends we already ruled out, so we don't re-litigate them.

**Status:** Written from the official Figma Plugin API. **Not yet runtime-tested** —
Jon is about to import and test. Treat runtime behavior as unverified. Most likely
first bugs: the zero-thickness open-vector dimension line under STRETCH constraints,
and the vertical orientation specifically.

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

A **self-contained dimension = a FrameNode with per-child constraints.** Figma resizes
frame children natively per their constraints, so stretching the frame stretches the
dimension correctly with the plugin closed. The plugin constructs it once; the label
value recomputes **live while open** (`documentchange`) and **on reopen** (scan +
recalc).

---

## Architecture

Each dimension is a `FrameNode` (transparent fill, `clipsContent = false`) containing:

- **Dimension line** — a two-point **open** vector (`vectorPaths` with
  `windingRule: 'NONE'`), `strokeWeight = thickness`, `strokeCap = arrowStyle`.
  Constraints: STRETCH along the measured axis, CENTER across it. Built natively per
  orientation (horizontal vs vertical geometry) rather than rotating a line node —
  **rotation + constraints is flaky in Figma**, so we avoid it.
- **Two witness (extension) lines** — thin rectangles pinned to each extremity
  (MIN / MAX along the axis, CENTER across). Two tunable knobs: `witnessGap` (standoff
  from the feature) and `witnessOvershoot` (how far past the dimension line).
- **Label** — a text node. Horizontal: centered above the line (CENTER / MIN). Vertical:
  upright, to the right of the line (MIN / CENTER). Its `fontName`/`fontSize` are the
  source of truth for the callout's font, set from settings at build via `resolveFont`.
  `recalcLabel` reloads the label's own font before rewriting, so changing the default
  font only affects new dimensions (same ownership rule as units).

**Arrows use native stroke caps, not vector arrowheads.** Earlier design had separate
vector arrowheads to allow an independent arrow-scale knob; Jon chose to couple arrow
size to stroke weight, so we switched to `strokeCap` (`ARROW_EQUILATERAL` = solid
triangle, `ARROW_LINES` = open chevron). Fewer nodes, always crisp, stretch for free.
**Trade-off:** arrow size is not independently tunable. **Reason to revisit:** if arrows
should be sized to text height rather than line weight — that's the case that would
justify going back to vector arrowheads.

**Measured span = `frame.width` (H) or `frame.height` (V).** The line spans the true
endpoints (0..LEN), so the frame's dimension *is* the measured length in pixels.
Displayed value = `(span / dpi) * PER_INCH[unit]` — canvas inches = pixels / DPI, then
converted to the chosen unit (`PER_INCH`: in 1, ft 1/12, mm 25.4, cm 2.54, m 0.0254).

### Self-describing via pluginData (this is what makes reopen-recalc work)

The frame stores its own parameters, and each child stores its role, under the `hcd:`
namespace (Human Crafted):

```
hcd:isDimension   "1"        (on the frame)
hcd:orientation   "H" | "V"  (on the frame)
hcd:dpi           px per inch (Figma baseline 72)  (on the frame)
hcd:unit          "in" | "ft" | "mm" | "cm" | "m"  (on the frame)
hcd:decimals      int        (on the frame)
hcd:showUnit      "1"|"0"    (on the frame)
hcd:role          "line" | "witness" | "label"  (on children)
```

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
retriggering. `loadAllPagesAsync()` is called when live is on (required for
cross-page `documentchange` under `documentAccess: dynamic-page`).

### Reopen recalc

`init()` on startup scans `currentPage` for `hcd:isDimension` frames and refreshes each
label. A **Recalculate all** button does the same on demand.

---

## Files

```
manifest.json   editorType: figma, documentAccess: dynamic-page,
                networkAccess none, main: code.js, ui: ui.html.
                id is a placeholder — fine for local dev, only matters at publish.
code.ts         all plugin logic. Compiles to code.js (which Figma actually runs).
ui.html         control panel: Horizontal/Vertical drop buttons, option fields,
                live toggle, Recalculate button. postMessage <-> code.
tsconfig.json   compiles code.ts. strict: true (flip to false as an escape hatch).
package.json    devDeps: @figma/plugin-typings, typescript. scripts: build, watch.
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
- `LEN` = 240 (default span), `CROSS` = 44 (frame cross-axis size).
- Witness geometry (`wTop`/`wBot`, and `label.y`) are the pixel spots to nudge for a
  preferred drafting look. Everything else is driven by the option fields.
- `Settings`: `thickness`, `arrowStyle`, `fontFamily`, `fontSize`, `witnessGap`,
  `witnessOvershoot`, `dpi`, `unit`, `decimals`, `showUnit`, `live`. Units use a DPI
  field + unit toggle (in/ft/mm/cm/m) via `PER_INCH`; there is no `scale` field anymore.

## Open threads / next candidates

- **Color control** — currently the `COLOR` constant; promote to the UI. (Jon flagged
  this as the likely next add.)
- **Feature tracking** — v1 is freestanding; it does not attach to or auto-follow
  another object. True tracking needs an anchor/association layer. Phase two.
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

**Status:** concept only. Deferred behind the first real test run of the current
(untested) feature stack — extend working code, don't pile onto unverified code.

## Provenance

Written from the official Figma Plugin API docs. The `figma-measure` open-source plugin
was a *conceptual* reference only (proof of feasibility; contrast case for its
bounding-box selection model) — **no code was copied from it.** If any technique is ever
lifted from it later, check its license (MIT per its repo, but confirm) and attribute.
