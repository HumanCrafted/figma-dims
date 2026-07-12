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

**Horizontal** — root is a VERTICAL stack, `counterAxisAlignItems = CENTER`, feature-side `paddingBottom = witnessGap` (see `featurePad`):

| child | role | H-sizing | V-sizing | notes |
|---|---|---|---|---|
| `Text` (frame) | `text` | HUG | FIXED = `fontSize*TEXT_TIGHTEN_H` | wraps the label; short fixed height, text top-aligned (`counterAxisAlignItems=MIN`) so it spills **down** toward the line, tightening the gap |
| `Extension` (frame) | `extension` | FILL | FIXED = `witnessOvershoot` | outside overshoot stubs; two vector bars, `SPACE_BETWEEN` |
| `Dim` (vector) | `line` | FILL | (0) | open path, arrow `strokeCap` both ends |
| `Extension` (frame) | `extension` | FILL | FILL (grows) | inside witness lines; grows to reach the feature |

**Vertical** — root is a HORIZONTAL row, `counterAxisAlignItems = CENTER`, feature-side `paddingLeft = witnessGap` (see `featurePad`):

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

## Variants: `flip` and `labelStyle` (v2.1)

Two independent modifiers layer on top of `orient`, all from one builder
(`buildDimension` → `assembleStandard` / `assembleInline`). 8 combos total.

### `flip` (mirror) — reverse the stack

The standard stacks above have a natural side (H: label **above**, V: label on the
**right**). `flip` mirrors it. Because each child's Fill/Hug sizing depends only on
`orient` + role — **not** on position — the flip is literally *reverse the child append
order*, plus two touch-ups:

- **Label spill** flips: H uses `counterAxisAlignItems = flip ? MAX : MIN` (spill up vs
  down); V uses `primaryAxisAlignItems = flip ? MIN : MAX` (spill right vs left). The
  label always spills **toward** the line.
- **Feature-side padding** (`featurePad`, = `witnessGap`) follows the growing band's edge:
  H `paddingBottom` → `paddingTop` when flipped; V `paddingLeft` → `paddingRight` when
  flipped. This is the single source of the witness-to-feature standoff on **every** variant.

`assembleStandard` builds each child as a role-keyed closure (`steps.text/outside/line/
inside`) and runs them in `flip ? reversed : natural` order. Root resize is
flip-independent (total size is order-agnostic) and adds `witnessGap` on the measured-axis'
counter (H height, V width) to make room for the standoff.

> **`witnessGap` wiring (v2.1).** Originally only H had a feature standoff, via a hardcoded
> `PAD_BOTTOM = 4`; V had none. `featurePad` now applies the `witnessGap` setting on all four
> orient×flip cases, so V finally gets its standoff and the value is user-tunable everywhere.

Reference frames: `Dimension (H) - Above` (natural) and `Dimension (H) - Below` (flip).

### `labelStyle: 'inline'` — the label breaks the line

The middle band becomes a row/column
`[witness ‖ segA → · Text · ← segB ‖ witness]` (`assembleInline`):

| child | role | length-axis | cross-axis | notes |
|---|---|---|---|---|
| `witness` ×2 | `witness` | FIXED (0) | FILL | crossing witness at each extremity — keeps the witness line continuous **through** the band |
| `segA` / `segB` | `line` | FILL | (0) | the two dim-line pieces; arrow on the **outer** end only |
| `Text` (frame) | `text` | H: HUG · **V: FIXED = `textH`** | HUG | centered on the line, `gap` padding on the near sides; see the cross-thickness note below |

Around this band sit the same **fixed outside-overshoot stub** and **growing inside band**
as standard. Their order is **orientation-specific** (like `assembleStandard`): H natural =
`[stub, band, inside]` (feature bottom); V natural = `[inside, band, stub]` (feature left);
`flip` reverses each. (An earlier cut shared one order array across both orients, which put
the V-inline feature on the wrong side — fixed.)

**Outer-end-only arrows.** A segment can't use node-level `strokeCap` (that caps *both*
ends → an arrow pointing at the text). Instead `inlineSegment` builds a two-vertex
`setVectorNetworkAsync` network and sets **per-vertex `strokeCap`**: the arrow style on the
outer vertex, `NONE` on the inner. `capOnStart` selects which vertex (segA=left/top outer,
segB=right/bottom outer). **Runtime-confirmed** by prototyping this exact band in the dev
file via `use_figma`: after FILL-stretch the two segments split to 101.5px each (matching
Jon's reference), the arrows land on the outer ends, and the inner ends stay clean.

**Band cross-thickness = the label's SHORT dimension (`textH`), in both orientations.** The
crossing witness spans the band's cross axis, so that axis must stay small and stable. In H
the text's height is naturally the cross axis, so the Text frame just HUGs. In V the cross
axis is horizontal — HUG would size it to the label's **width** (the perpendicular axis for a
vertical dim), so a longer number would stretch the witness-crossing (and eat the overshoot
stub via the `textCross/2` term). Fix: in V the Text frame is pinned to a **fixed width =
`textH`**; the label overflows it, centered on the line (a number straddling the line). This
makes the V frame width independent of the label text — runtime-confirmed via `use_figma`
(at one font size "3.3 in" and "100.0 in" both yield the same frame width; the
witness-crossing becomes `textH` instead of the full label width).

**Overshoot bookkeeping.** The inline band's near half already provides part of the
overshoot, so the stub is `max(witnessOvershoot - textH/2, 1)` — `textH` is the band's
cross-thickness in both orientations (see above) — keeping total overshoot past the line ≈
`witnessOvershoot`.

**Settle (gotcha #2) applies to the inline band too** — it's a nested Fill frame, so after
the tree is assembled it gets the same resize-then-refill treatment (`FILL` on the length
axis, `HUG` on the cross axis) as the extension bands.

Reference frame: `Dimension (H) - Inline`. V-inline is the symmetric case — vertical band,
horizontal crossing witnesses, upright label straddling the line — and its cross-thickness
fix (above) is runtime-confirmed.

> **Runtime status:** the new primitive — **per-vertex `strokeCap` under Fill-stretch** — is
> runtime-confirmed via `use_figma` (outer-end arrows, clean inner ends, even 101.5px split),
> as is the **V-inline cross-thickness fix** (frame width independent of label text). `flip`
> and the rest of the inline assembly reuse the already-verified sizing machinery.

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
All five mappings are **runtime-confirmed** (incl. `Reversed` → `TRIANGLE_FILLED`).

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
