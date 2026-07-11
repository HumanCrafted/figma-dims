# Auto-layout architecture (v2) — details

Verbose companion to CLAUDE.md. This is the **current** dimension structure (v2),
which replaced the v1 constraints model. It is **runtime-verified** in Figma.

Why the change: v1 pinned children with per-child `constraints` (STRETCH/CENTER/MIN/MAX).
Jon rebuilt the dimension by hand in Figma using **auto-layout + Fill/Hug/Fixed**, which
is genuinely parametric in both axes with no constraint math and no rotation. We ported
the plugin to emit that exact structure. Reference frames live on the Figma dev doc
("New" section: `Horizontal Dims`, `Vertical Dims`).

---

## Node tree

Each dimension is an auto-layout `FrameNode` (transparent, `clipsContent = false`).

**Horizontal** — root is a VERTICAL stack, `counterAxisAlignItems = CENTER`, `paddingBottom = PAD_BOTTOM`:

| child | role | H-sizing | V-sizing | notes |
|---|---|---|---|---|
| `Text` (frame) | `text` | HUG | FIXED = `fontSize*TEXT_TIGHTEN_H` | wraps the label; short fixed height, text top-aligned (`counterAxisAlignItems=MIN`) so it spills **down** toward the line, tightening the gap |
| `Extension` (frame) | `extension` | FILL | FIXED = `witnessOvershoot` | outside overshoot stubs; two vector bars, `SPACE_BETWEEN` |
| `Dim` (vector) | `line` | FILL | (0) | open path, arrow `strokeCap` both ends |
| `Extension` (frame) | `extension` | FILL | FILL (grows) | inside witness lines; grows to reach the feature |

**Vertical** — root is a HORIZONTAL row, `counterAxisAlignItems = CENTER`:

| child | role | H-sizing | V-sizing | notes |
|---|---|---|---|---|
| `Extension` (frame) | `extension` | FILL (grows) | FILL | inside witness lines |
| `Dim` (vector) | `line` | (0) | FILL | vertical open path |
| `Extension` (frame) | `extension` | FIXED = `witnessOvershoot` | FILL | outside overshoot stubs |
| `Text` (frame) | `text` | FIXED = `label.width - fontSize*TEXT_TIGHTEN_V` | HUG | narrower than text, `primaryAxisAlignItems=MAX` (right-align) so text spills **left** toward the line |

**Witness/extension bars** are open vectors (`witnessBar`), not rectangles — chosen so
stroke weight stays hand-adjustable later without the plugin. Each is 0 on the thickness
axis and FILLs the band's cross axis (its length).

**Measured span** is still `frame.width` (H) / `frame.height` (V) — the Dim line and the
witness endpoints span 0..width, so the frame dimension *is* the measured length. Recalc
and live-update read it exactly as in v1.

---

## The three gotchas (all learned the hard way this session)

### 1. `resize()` clobbers BOTH axes back to Fixed
`node.resize(w, h)` sets `layoutSizingHorizontal` AND `layoutSizingVertical` to `FIXED`.
So any `FILL`/`HUG` must be applied **after** the last `resize()` on that node, or it's
silently overwritten. Rule in `buildDimension`: **resize first, Fill/Hug last.**

### 2. Nested auto-layout frames keep a STALE 0 on their Fill (stretch) axis
When the whole tree is built in one synchronous plugin pass, a nested band frame set to
`FILL` along its parent's counter axis computes to **width/height 0** — even though its
properties are byte-for-byte identical to a hand-built band that reads 250. (Verified by
diffing raw props via `use_figma`.) The Dim *vector* fills fine; nested *frames* don't.

**Fix: a "settle" pass** (`settleBand`) run **after the entire tree is assembled** — resize
each band to a nonzero fixed size on its fill axis, then re-apply `FILL`. Doing this
mid-build does **not** work; the tree must be complete first. This mirrors the manual
"set a fixed width, then re-apply Fill" workaround Jon found by hand.

### 3. `documentchange` registration requires `loadAllPagesAsync()` first
Under `documentAccess: dynamic-page`, `figma.on('documentchange', …)` **throws at
registration** unless `figma.loadAllPagesAsync()` has already been awaited — not just
before the handler fires, before it's even registered. So the handler is a named function
registered inside `init()` after an **unconditional** `await loadAllPagesAsync()` (it
early-returns when `live` is off, so registering it always is cheap). Never register at
module top level.

---

## Arrow styles

Native `StrokeCap` enum (typings v1.130.0) — 5 exposed in the UI as **single words**:

| UI label | `StrokeCap` |
|---|---|
| Line | `ARROW_LINES` |
| Triangle | `ARROW_EQUILATERAL` |
| Reversed | `TRIANGLE_FILLED` |
| Circle | `CIRCLE_FILLED` |
| Diamond | `DIAMOND_FILLED` |

The API also has `NONE`/`ROUND`/`SQUARE` (not offered — not dimension arrowheads).
**Unverified:** the `Reversed` → `TRIANGLE_FILLED` mapping is a best guess; two enum
values are triangles. Confirm against a render and swap with `ARROW_EQUILATERAL` if wrong.

**Rounded extension ends (Line style only):** when `arrowStyle === 'ARROW_LINES'`, the
witness bars get `strokeCap = 'ROUND'` (else `'NONE'`) to match Figma's native Line-arrow
look. Threaded through `witnessBar(orient, thickness, roundEnds)`. Matched exactly to
Jon's hand-fixed reference. Scoped to Line "for now" — other styles may want it later.

---

## Value math (with scale)

```
displayed = (px / dpi) * PER_INCH[unit] / scale
```

`scale` is the drawing scale (e.g. 0.25 for quarter-scale): measured ÷ scale, so a
quarter-scale drawing annotates real-world size (0.25 → labels read 4× larger). Stored
per-dimension in `hcd:scale`, parsed from a UI field that accepts decimals, whole numbers,
or fractions (`1/4`). Inverse (`px = value / PER_INCH[unit] * dpi`) is the basis for the
deferred size-input mode (see CLAUDE.md).

---

## Debugging layout via `use_figma` (the workflow that cracked gotcha #2)

Blind edits to auto-layout sizing failed twice. What worked: read **raw property values**
of a hand-built reference vs the plugin's output directly in the file via `use_figma`
(`figma-use` skill), diff them, and — when props matched but layout didn't — reproduce the
build sequence live and screenshot. This is the go-to for any future layout snag: prototype
in the doc, read back ground truth, then port the confirmed sequence into `code.ts`.

---

## Build/tsconfig note

`tsconfig.json` must **not** include the `DOM` lib — `@figma/plugin-typings` declares
`console`/`fetch` globally and DOM double-declares them (TS2451). `code.ts` (the sandbox)
uses no DOM APIs; the browser code is inline in `ui.html`, which TS doesn't compile.
