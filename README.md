# Dims.

A CAD-style dimension annotation tool for Figma. Drop well-formatted dimension
callouts — line, arrows, witness/extension lines, and a value label — that read like
real drafting and carry real-world units instead of screen pixels.

Figma has no native equivalent. Dims fills that gap for anyone doing technical or
mechanical drawings who wants proper dimension callouts.

## Features

- **Real-world units** — in, ft, mm, cm, m, with a configurable DPI and drawing scale.
- **Figma native** — every dimension is built from standard Figma vectors and frames,
  no custom rendering. Each one is an auto-layout frame, so Figma stretches it in both
  axes when you drag and the label recomputes automatically. Lines and witnesses stay
  editable by hand like any other vector.
- **8 variants** — horizontal / vertical × standard / inline label × flip, from a grid
  of one-click drop buttons.
- **Adjustable styling** — arrow styles (line, triangle, reversed, circle, diamond),
  stroke thickness, font, witness-line gap and overshoot.
- **Live updates** — labels stay correct while resizing and are refreshed on reopen.
- **Restyle in place** — select placed dims and re-apply the current settings.

## Install (local development)

Requires the Figma **desktop app**.

```bash
npm install
npm run watch    # compiles code.ts -> code.js
```

Then in Figma: **Plugins → Development → Import plugin from manifest…** and pick
`manifest.json`. Run it from **Plugins → Development → Dims** (`Cmd+Opt+P` re-runs the
last plugin). Re-run after each recompile — Figma doesn't hot-reload.

## Usage

1. Open the plugin panel.
2. Set your units, scale, and styling (sections are collapsible).
3. Click a variant button to drop a dimension.
4. Resize the dimension frame to fit your feature — the value updates automatically.
5. To restyle existing dimensions, adjust the settings, click **Select all** (or select
   dims manually), then click **Update selected Dims** to re-apply the current settings.

## License

MIT © Human Crafted, LLC. See [LICENSE](LICENSE) for details.
