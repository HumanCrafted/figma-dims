/// <reference types="@figma/plugin-typings" />

/**
 * Dimension Tool
 * --------------
 * Drops a well-formatted dimension (horizontal or vertical) onto the canvas as a
 * FRAME with per-child constraints, so Figma stretches it natively:
 *   - dimension line   -> open path with ARROW stroke caps; STRETCH along the axis
 *   - witness lines    -> pinned to each end
 *   - label            -> pinned CENTER (horizontal) / to the side (vertical)
 *
 * Arrow size follows stroke weight (native stroke caps). The label value is the
 * only non-native piece; it recomputes live (while open) and on reopen, because
 * each frame stores its own params in pluginData.
 */

const NS = 'hcd';
const K = {
  isDim: `${NS}:isDimension`,
  orient: `${NS}:orientation`,
  dpi: `${NS}:dpi`,
  unit: `${NS}:unit`,
  decimals: `${NS}:decimals`,
  showUnit: `${NS}:showUnit`,
  role: `${NS}:role`,
};

const FONT: FontName = { family: 'Inter', style: 'Regular' };
const COLOR: RGB = { r: 0.11, g: 0.11, b: 0.12 };

// Unit magnitude per inch. Canvas inches = pixels / dpi (Figma baseline dpi = 72),
// so value = (pixels / dpi) * PER_INCH[unit].
const PER_INCH: Record<string, number> = {
  in: 1,
  ft: 1 / 12,
  mm: 25.4,
  cm: 2.54,
  m: 0.0254,
};

interface Settings {
  thickness: number;        // px stroke weight of the dimension line -> also drives arrow size
  arrowStyle: StrokeCap;    // 'ARROW_EQUILATERAL' | 'ARROW_LINES'
  witnessGap: number;       // px standoff from the feature before the witness line begins
  witnessOvershoot: number; // px the witness line extends past the dimension line
  dpi: number;              // pixels per inch (Figma baseline = 72)
  unit: string;             // 'in' | 'ft' | 'mm' | 'cm' | 'm'
  fontFamily: string;       // label font family (must be available/loadable)
  fontSize: number;         // label font size in px
  decimals: number;
  showUnit: boolean;
  live: boolean;
}

const DEFAULTS: Settings = {
  thickness: 1.5,
  arrowStyle: 'ARROW_EQUILATERAL',
  witnessGap: 4,
  witnessOvershoot: 8,
  dpi: 72,
  unit: 'in',
  fontFamily: 'Inter',
  fontSize: 11,
  decimals: 1,
  showUnit: true,
  live: true,
};

let settings: Settings = { ...DEFAULTS };
let liveOn = false;
let suppress = false; // guards the documentchange feedback loop
let availableFonts: Font[] = []; // cached from listAvailableFontsAsync()

// ---------- geometry helpers ----------

/** Solid rectangle used for the witness lines. */
function bar(w: number, h: number, role: string): RectangleNode {
  const r = figma.createRectangle();
  r.resize(Math.max(w, 0.01), Math.max(h, 0.01));
  r.fills = [{ type: 'SOLID', color: COLOR }];
  r.strokes = [];
  r.setPluginData(K.role, role);
  return r;
}

/**
 * The dimension line: a two-point OPEN path, so both ends are open and receive
 * the arrow stroke cap. Built natively per orientation (no rotation), so it
 * stretches cleanly under constraints. Arrow size scales with strokeWeight.
 */
function dimLine(orient: 'H' | 'V', length: number, thickness: number, style: StrokeCap): VectorNode {
  const data = orient === 'H' ? `M 0 0 L ${length} 0` : `M 0 0 L 0 ${length}`;
  const v = figma.createVector();
  v.vectorPaths = [{ windingRule: 'NONE', data }]; // NONE = open path
  v.fills = [];
  v.strokes = [{ type: 'SOLID', color: COLOR }];
  v.strokeWeight = thickness;
  v.strokeCap = style; // applies to both open ends
  v.setPluginData(K.role, 'line');
  return v;
}

// ---------- value formatting ----------

function fmtFrom(frame: FrameNode, px: number): string {
  const dpi = parseFloat(frame.getPluginData(K.dpi) || '72') || 72;
  const unit = frame.getPluginData(K.unit) || 'in';
  const perInch = PER_INCH[unit] !== undefined ? PER_INCH[unit] : 1;
  const dec = parseInt(frame.getPluginData(K.decimals) || '1', 10);
  const showU = frame.getPluginData(K.showUnit) === '1';
  const v = ((px / dpi) * perInch).toFixed(dec);
  return showU && unit ? `${v} ${unit}` : v;
}

/** Resolve a family name to a loadable FontName (prefer Regular, else first style). */
function resolveFont(family: string): FontName {
  const styles = availableFonts
    .filter((f) => f.fontName.family === family)
    .map((f) => f.fontName.style);
  if (styles.length) {
    const style = styles.indexOf('Regular') >= 0 ? 'Regular' : styles[0];
    return { family, style };
  }
  return FONT; // fallback: Inter Regular
}

// ---------- build ----------

async function buildDimension(orient: 'H' | 'V') {
  const s = settings;
  if (!availableFonts.length) availableFonts = await figma.listAvailableFontsAsync();
  let font = resolveFont(s.fontFamily);
  try {
    await figma.loadFontAsync(font);
  } catch (e) {
    font = FONT; // family vanished / not loadable -> fall back to Inter
    await figma.loadFontAsync(FONT);
  }
  const LEN = 240;   // default measured span (the value tracks this)
  const CROSS = 44;  // cross-axis size of the frame

  const frame = figma.createFrame();
  frame.name = `Dimension (${orient})`;
  frame.fills = [];
  frame.clipsContent = false;
  frame.setPluginData(K.isDim, '1');
  frame.setPluginData(K.orient, orient);
  frame.setPluginData(K.dpi, String(s.dpi));
  frame.setPluginData(K.unit, s.unit);
  frame.setPluginData(K.decimals, String(s.decimals));
  frame.setPluginData(K.showUnit, s.showUnit ? '1' : '0');

  const label = figma.createText();
  label.fontName = font;
  label.fontSize = s.fontSize;
  label.fills = [{ type: 'SOLID', color: COLOR }];
  label.textAlignHorizontal = 'CENTER';
  label.setPluginData(K.role, 'label');

  if (orient === 'H') {
    frame.resize(LEN, CROSS);
    const yMid = CROSS / 2;

    // dimension line spans the full measured length; arrow caps sit at each tip.
    const line = dimLine('H', LEN, s.thickness, s.arrowStyle);
    frame.appendChild(line);
    line.x = 0;
    line.y = yMid;
    line.constraints = { horizontal: 'STRETCH', vertical: 'CENTER' };

    // witness lines: vertical, at each extremity. Tunable geometry.
    const wTop = yMid - s.witnessOvershoot;
    const wBot = CROSS - s.witnessGap;
    const wH = Math.max(wBot - wTop, 0.01);
    const wL = bar(s.thickness, wH, 'witness');
    frame.appendChild(wL);
    wL.x = -s.thickness / 2; wL.y = wTop;
    wL.constraints = { horizontal: 'MIN', vertical: 'CENTER' };
    const wR = bar(s.thickness, wH, 'witness');
    frame.appendChild(wR);
    wR.x = LEN - s.thickness / 2; wR.y = wTop;
    wR.constraints = { horizontal: 'MAX', vertical: 'CENTER' };

    label.characters = fmtFrom(frame, LEN);
    frame.appendChild(label);
    label.x = (LEN - label.width) / 2;
    label.y = -(label.height + 4); // floats just above the line; adjust to taste
    label.constraints = { horizontal: 'CENTER', vertical: 'MIN' };
  } else {
    frame.resize(CROSS, LEN);
    const xMid = CROSS / 2;

    const line = dimLine('V', LEN, s.thickness, s.arrowStyle);
    frame.appendChild(line);
    line.x = xMid;
    line.y = 0;
    line.constraints = { horizontal: 'CENTER', vertical: 'STRETCH' };

    const wLeft = xMid - s.witnessOvershoot;
    const wRight = CROSS - s.witnessGap;
    const wW = Math.max(wRight - wLeft, 0.01);
    const wT = bar(wW, s.thickness, 'witness');
    frame.appendChild(wT);
    wT.x = wLeft; wT.y = -s.thickness / 2;
    wT.constraints = { horizontal: 'CENTER', vertical: 'MIN' };
    const wB = bar(wW, s.thickness, 'witness');
    frame.appendChild(wB);
    wB.x = wLeft; wB.y = LEN - s.thickness / 2;
    wB.constraints = { horizontal: 'CENTER', vertical: 'MAX' };

    label.characters = fmtFrom(frame, LEN);
    frame.appendChild(label);
    label.x = CROSS + 4; // upright, to the right of the line
    label.y = (LEN - label.height) / 2;
    label.constraints = { horizontal: 'MIN', vertical: 'CENTER' };
  }

  frame.x = Math.round(figma.viewport.center.x - frame.width / 2);
  frame.y = Math.round(figma.viewport.center.y - frame.height / 2);
  figma.currentPage.selection = [frame];
}

// ---------- recompute ----------

async function recalcLabel(frame: FrameNode) {
  if (frame.getPluginData(K.isDim) !== '1') return;
  const label = frame.findOne((n) => n.getPluginData(K.role) === 'label') as TextNode | null;
  if (!label) return;
  const orient = frame.getPluginData(K.orient) as 'H' | 'V';
  const span = orient === 'V' ? frame.height : frame.width;
  const next = fmtFrom(frame, span);
  if (label.characters === next) return; // diff guard: no needless writes / loops
  await figma.loadFontAsync(label.fontName as FontName);
  suppress = true;
  label.characters = next;
  suppress = false;
}

async function recalcAll() {
  const dims = figma.currentPage.findAll((n) => n.getPluginData(K.isDim) === '1') as FrameNode[];
  for (const d of dims) await recalcLabel(d);
}

// ---------- live mode ----------

figma.on('documentchange', async (e) => {
  if (!liveOn || suppress) return;
  const seen = new Set<string>();
  for (const c of e.documentChanges) {
    if (c.type !== 'PROPERTY_CHANGE') continue;
    if (!(c.properties.includes('width') || c.properties.includes('height'))) continue;
    const n = c.node as SceneNode;
    if (!n || n.removed) continue;
    if (n.getPluginData && n.getPluginData(K.isDim) === '1' && !seen.has(n.id)) {
      seen.add(n.id);
      await recalcLabel(n as FrameNode);
    }
  }
});

// ---------- lifecycle ----------

figma.showUI(__html__, { width: 264, height: 560, themeColors: true });

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'create') {
    await buildDimension(msg.orient);
  } else if (msg.type === 'settings') {
    settings = { ...settings, ...msg.settings };
    liveOn = settings.live;
    await figma.clientStorage.setAsync('settings', settings);
    if (liveOn) await figma.loadAllPagesAsync().catch(() => {});
  } else if (msg.type === 'recalc') {
    await recalcAll();
  }
};

(async function init() {
  const saved = (await figma.clientStorage.getAsync('settings')) as Partial<Settings> | undefined;
  if (saved) settings = { ...DEFAULTS, ...saved };
  liveOn = settings.live;
  availableFonts = await figma.listAvailableFontsAsync();
  const families = Array.from(new Set(availableFonts.map((f) => f.fontName.family))).sort();
  figma.ui.postMessage({ type: 'init', settings, fonts: families });
  if (liveOn) await figma.loadAllPagesAsync().catch(() => {});
  await recalcAll(); // refresh any stale labels on reopen
})();
