/// <reference types="@figma/plugin-typings" />

/**
 * Dimension Tool
 * --------------
 * Drops a well-formatted dimension (horizontal or vertical) onto the canvas.
 *
 * v2 architecture: the dimension is an AUTO-LAYOUT frame (not constraints), so
 * Figma reflows it natively when the user resizes it — in both axes, with no
 * rotation and no per-child constraint math. Structure mirrors the hand-built
 * parametric version:
 *
 *   Horizontal = vertical stack, top -> bottom:
 *     [ Text (hug, short fixed cross-height) ]
 *     [ Extension Outside (fixed band)       ]   overshoot stubs above the line
 *     [ Dim line (open vector, STRETCH)      ]   arrow stroke caps at both ends
 *     [ Extension Inside (GROWS)             ]   witness lines reaching the feature
 *
 *   Vertical = the same stack rotated into a row:
 *     [ Extension Inside (GROWS) | Dim | Extension Outside | Text ]
 *
 * The growing inside band is what makes it parametric: resize the frame across
 * the measured axis and the inside witness band absorbs the slack to reach the
 * feature at any depth, while label / overshoot / line stay fixed.
 *
 * Arrows are native stroke caps (StrokeCap enum) — they render exactly like
 * Figma's own, including the rounded line-arrow ends, and scale with weight.
 * The label value is the only non-native piece; it recomputes live (while open)
 * and on reopen, from params each frame stores in pluginData.
 */

const NS = 'hcd';
const K = {
  isDim: `${NS}:isDimension`,
  orient: `${NS}:orientation`,
  labelStyle: `${NS}:labelStyle`,
  flip: `${NS}:flip`,
  dpi: `${NS}:dpi`,
  unit: `${NS}:unit`,
  scale: `${NS}:scale`,
  decimals: `${NS}:decimals`,
  showUnit: `${NS}:showUnit`,
  role: `${NS}:role`,
};

type LabelStyle = 'standard' | 'inline';

const FONT: FontName = { family: 'Inter', style: 'Regular' };
const COLOR: RGB = { r: 0.11, g: 0.11, b: 0.12 };

// Unit magnitude per inch. Canvas inches = pixels / dpi (Figma baseline dpi = 72),
// so value = (pixels / dpi) * PER_INCH[unit] / scale.
const PER_INCH: Record<string, number> = {
  in: 1,
  ft: 1 / 12,
  mm: 25.4,
  cm: 2.54,
  m: 0.0254,
};

// The label wrapper is given a fixed size SHORTER than the text so the text
// overflows toward the line, tightening the label-to-line gap. Expressed as a
// fraction of font size so it scales with the font. Starting heuristics — refine as
// needed (Jon flagged this may want a fuller calc, esp. for the vertical case).
const TEXT_TIGHTEN_H = 0.7; // H: wrapper height = fontSize * this (text spills down)
const TEXT_TIGHTEN_V = 0.4; // V: wrapper narrower than text by fontSize * this (text spills toward line)

const LEN = 240;   // default measured span (the value tracks this)
const INSIDE = 40; // default inside-extension reach (grows on resize)

interface Settings {
  thickness: number;        // px stroke weight of the dimension line -> also drives arrow size
  arrowStyle: StrokeCap;    // native stroke cap enum value
  labelStyle: LabelStyle;   // 'standard' (offset from line) | 'inline' (breaks the line)
  flip: boolean;            // mirror the stack: H text above->below, V text right->left
  witnessGap: number;       // px standoff from the feature before the witness line begins
  witnessOvershoot: number; // px the witness line extends past the dimension line
  dpi: number;              // pixels per inch (Figma baseline = 72)
  unit: string;             // 'in' | 'ft' | 'mm' | 'cm' | 'm'
  scale: number;            // drawing scale: displayed value = measured / scale
  fontFamily: string;       // label font family (must be available/loadable)
  fontSize: number;         // label font size in px
  decimals: number;
  showUnit: boolean;
  live: boolean;
}

const DEFAULTS: Settings = {
  thickness: 1.5,
  arrowStyle: 'ARROW_EQUILATERAL',
  labelStyle: 'standard',
  flip: false,
  witnessGap: 4,
  witnessOvershoot: 8,
  dpi: 72,
  unit: 'in',
  scale: 1,
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

/**
 * The dimension line: a two-point OPEN path, so both ends are open and receive
 * the arrow stroke cap. Length is provisional — as an auto-layout child with
 * layoutAlign STRETCH, Figma stretches it along the measured axis, moving the
 * far endpoint so the cap always sits at the true extremity.
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

/**
 * A single witness/extension line: an OPEN vector (like the dim line), so its
 * thickness stays stroke-driven and hand-adjustable later without the plugin.
 * Length is provisional — it FILLs its band's cross axis via layoutSizing.
 *   orient 'H' -> vertical line; orient 'V' -> horizontal line.
 */
function witnessBar(orient: 'H' | 'V', thickness: number, roundEnds: boolean): VectorNode {
  const data = orient === 'H' ? 'M 0 0 L 0 100' : 'M 0 0 L 100 0';
  const v = figma.createVector();
  v.vectorPaths = [{ windingRule: 'NONE', data }];
  v.fills = [];
  v.strokes = [{ type: 'SOLID', color: COLOR }];
  v.strokeWeight = thickness;
  // Round the extension-line ends to match Figma's Line-arrow look (Line style only).
  v.strokeCap = roundEnds ? 'ROUND' : 'NONE';
  v.setPluginData(K.role, 'witness');
  return v;
}

/**
 * A single segment of an INLINE dimension line — the piece of the dim line on one
 * side of the label. Built as a two-vertex vectorNetwork so the arrow strokeCap can be
 * placed on the OUTER vertex ONLY (the inner end, by the text, stays clean). The node
 * fills its band's length axis, stretching to reach the frame extremity where the arrow
 * sits.  capOnStart true -> arrow on the x0/y0 vertex; false -> on the far vertex.
 */
async function inlineSegment(orient: 'H' | 'V', thickness: number, cap: StrokeCap, capOnStart: boolean): Promise<VectorNode> {
  const v = figma.createVector();
  const far = orient === 'H' ? { x: LEN / 2, y: 0 } : { x: 0, y: LEN / 2 };
  await v.setVectorNetworkAsync({
    vertices: [
      { x: 0, y: 0, strokeCap: capOnStart ? cap : 'NONE' },
      { x: far.x, y: far.y, strokeCap: capOnStart ? 'NONE' : cap },
    ],
    segments: [{ start: 0, end: 1 }],
  });
  v.fills = [];
  v.strokes = [{ type: 'SOLID', color: COLOR }];
  v.strokeWeight = thickness;
  v.setPluginData(K.role, 'line');
  return v;
}

/**
 * An extension band: an auto-layout frame holding two witness vectors pushed to the
 * two ends (SPACE_BETWEEN). Used for both the outside overshoot stubs and the inside
 * witness lines.
 *   orient 'H' -> horizontal band, vertical bars at each end.
 *   orient 'V' -> vertical band, horizontal bars at top/bottom.
 * Bars are appended here; their FILL sizing is applied by fillBars() AFTER the band
 * itself has been parented and sized (Fill/Hug/Fixed must resolve outermost-first).
 */
function extensionBand(orient: 'H' | 'V', thickness: number, roundEnds: boolean): FrameNode {
  const band = figma.createFrame();
  band.name = 'Extension';
  band.fills = [];
  band.clipsContent = false;
  band.layoutMode = orient === 'H' ? 'HORIZONTAL' : 'VERTICAL';
  band.primaryAxisAlignItems = 'SPACE_BETWEEN';
  band.counterAxisAlignItems = 'CENTER';
  band.itemSpacing = 0;
  band.setPluginData(K.role, 'extension');
  band.appendChild(witnessBar(orient, thickness, roundEnds));
  band.appendChild(witnessBar(orient, thickness, roundEnds));
  return band;
}

/** Make each bar FILL the band's cross axis (its length) and stay 0 on thickness. */
function fillBars(band: FrameNode, orient: 'H' | 'V') {
  for (const bar of band.children as VectorNode[]) {
    if (orient === 'H') {
      bar.layoutSizingHorizontal = 'FIXED'; // 0-width path
      bar.layoutSizingVertical = 'FILL';
    } else {
      bar.layoutSizingVertical = 'FIXED'; // 0-height path
      bar.layoutSizingHorizontal = 'FILL';
    }
  }
}

/**
 * Force a nested band to recompute its Fill size. Built in one synchronous pass, a
 * nested auto-layout frame keeps a STALE 0 on the axis that fills its parent's counter
 * axis (verified: identical props to a hand-built band, but width 0 vs 250). The only
 * fix is to resize it to a NONZERO fixed size and re-apply Fill — and it must run AFTER
 * the whole tree is assembled, so this is a final "settle" pass, not done mid-build.
 *   grows = the band also fills its primary (length) axis (the inside band);
 *   overshoot = the fixed cross size to preserve for the non-growing outside band.
 */
function settleBand(band: FrameNode, orient: 'H' | 'V', grows: boolean, overshoot: number) {
  const fixed = Math.max(overshoot, 0.01);
  if (orient === 'H') {
    band.resize(10, grows ? 10 : fixed);
    band.layoutSizingHorizontal = 'FILL';
    if (grows) band.layoutSizingVertical = 'FILL';
  } else {
    band.resize(grows ? 10 : fixed, 10);
    band.layoutSizingVertical = 'FILL';
    if (grows) band.layoutSizingHorizontal = 'FILL';
  }
}

// ---------- value formatting ----------

function fmtFrom(frame: FrameNode, px: number): string {
  const dpi = parseFloat(frame.getPluginData(K.dpi) || '72') || 72;
  const unit = frame.getPluginData(K.unit) || 'in';
  const perInch = PER_INCH[unit] !== undefined ? PER_INCH[unit] : 1;
  const scale = parseFloat(frame.getPluginData(K.scale) || '1') || 1;
  const dec = parseInt(frame.getPluginData(K.decimals) || '1', 10);
  const showU = frame.getPluginData(K.showUnit) === '1';
  const v = (((px / dpi) * perInch) / scale).toFixed(dec);
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
  const inline = s.labelStyle === 'inline';
  const root = figma.createFrame();
  root.name = `Dimension (${orient})${inline ? ' - Inline' : ''}${s.flip ? ' - Flip' : ''}`;
  root.fills = [];
  root.clipsContent = false;
  root.itemSpacing = 0;
  root.paddingTop = root.paddingBottom = root.paddingLeft = root.paddingRight = 0;
  root.setPluginData(K.isDim, '1');
  root.setPluginData(K.orient, orient);
  root.setPluginData(K.labelStyle, s.labelStyle);
  root.setPluginData(K.flip, s.flip ? '1' : '0');
  root.setPluginData(K.dpi, String(s.dpi));
  root.setPluginData(K.unit, s.unit);
  root.setPluginData(K.scale, String(s.scale));
  root.setPluginData(K.decimals, String(s.decimals));
  root.setPluginData(K.showUnit, s.showUnit ? '1' : '0');

  const label = figma.createText();
  label.fontName = font;
  label.fontSize = s.fontSize;
  label.fills = [{ type: 'SOLID', color: COLOR }];
  label.textAlignHorizontal = 'CENTER';
  label.setPluginData(K.role, 'label');
  label.characters = fmtFrom(root, LEN); // root pluginData already set

  // Root is a fixed-size auto-layout box the user resizes freely; children Fill it.
  root.layoutMode = orient === 'H' ? 'VERTICAL' : 'HORIZONTAL';
  root.counterAxisAlignItems = 'CENTER';
  root.primaryAxisSizingMode = 'FIXED';
  root.counterAxisSizingMode = 'FIXED';

  if (inline) await assembleInline(root, orient, s.flip, s, label);
  else assembleStandard(root, orient, s.flip, s, label);

  root.x = Math.round(figma.viewport.center.x - root.width / 2);
  root.y = Math.round(figma.viewport.center.y - root.height / 2);
  figma.currentPage.selection = [root];
}

/**
 * Apply the witness gap: padding between the growing inside band and the frame edge on the
 * FEATURE side, so the witness line stops `gap` px short of the feature it points at.
 * Feature side follows orient + flip: H -> bottom (top when flipped); V -> left (right when
 * flipped) — matching the inside (growing) band's position in each variant's child order.
 */
function featurePad(root: FrameNode, orient: 'H' | 'V', flip: boolean, gap: number) {
  if (orient === 'H') {
    if (flip) root.paddingTop = gap;
    else root.paddingBottom = gap;
  } else {
    if (flip) root.paddingRight = gap;
    else root.paddingLeft = gap;
  }
}

/**
 * Standard dimension: the label sits OFFSET from the line (above/right by default). The
 * stack is [Text · Extension Outside · Dim · Extension Inside(grows)]; `flip` reverses it
 * so the label lands on the opposite side (H below, V left) and the label's spill flips
 * to keep it tightened toward the line.
 *
 * The per-child sizing (resize-then-Fill discipline, gotchas #1/#2) is identical whatever
 * the child order, so each child's build+size is a closure keyed by role and run in the
 * order the orientation + flip dictate.
 */
function assembleStandard(root: FrameNode, orient: 'H' | 'V', flip: boolean, s: Settings, label: TextNode) {
  const roundEnds = s.arrowStyle === 'ARROW_LINES';
  const line = dimLine(orient, LEN, s.thickness, s.arrowStyle);
  const outside = extensionBand(orient, s.thickness, roundEnds);
  const inside = extensionBand(orient, s.thickness, roundEnds);

  const textWrap = figma.createFrame();
  textWrap.name = 'Text';
  textWrap.fills = [];
  textWrap.clipsContent = false;
  textWrap.itemSpacing = 0;
  textWrap.layoutMode = 'HORIZONTAL';
  textWrap.setPluginData(K.role, 'text');

  const steps: Record<string, () => void> = {};

  if (orient === 'H') {
    featurePad(root, 'H', flip, s.witnessGap);
    root.resize(LEN, Math.round(s.fontSize * TEXT_TIGHTEN_H) + s.witnessOvershoot + INSIDE + s.witnessGap);

    steps.text = () => {
      // Hug width, fixed SHORT height -> text aligns to the line side and spills toward it.
      textWrap.counterAxisAlignItems = flip ? 'MAX' : 'MIN';
      textWrap.primaryAxisAlignItems = 'CENTER';
      textWrap.appendChild(label);
      root.appendChild(textWrap);
      textWrap.resize(Math.max(textWrap.width, 1), Math.max(Math.round(s.fontSize * TEXT_TIGHTEN_H), 1));
      textWrap.layoutSizingHorizontal = 'HUG'; // last: re-hug width, keep fixed height
    };
    steps.outside = () => {
      root.appendChild(outside);
      outside.resize(Math.max(outside.width, 1), Math.max(s.witnessOvershoot, 0.01));
      outside.layoutSizingHorizontal = 'FILL';
      fillBars(outside, 'H');
    };
    steps.line = () => {
      root.appendChild(line);
      line.layoutSizingHorizontal = 'FILL';
    };
    steps.inside = () => {
      root.appendChild(inside);
      inside.layoutSizingHorizontal = 'FILL';
      inside.layoutSizingVertical = 'FILL'; // grows -> reaches the feature
      fillBars(inside, 'H');
    };
    const order = flip ? ['inside', 'line', 'outside', 'text'] : ['text', 'outside', 'line', 'inside'];
    order.forEach((k) => steps[k]());
  } else {
    featurePad(root, 'V', flip, s.witnessGap);
    root.resize(INSIDE + s.witnessOvershoot + Math.max(label.width, 1) + s.witnessGap, LEN);

    steps.inside = () => {
      root.appendChild(inside);
      inside.layoutSizingHorizontal = 'FILL'; // grows -> reaches the feature
      inside.layoutSizingVertical = 'FILL';
      fillBars(inside, 'V');
    };
    steps.line = () => {
      root.appendChild(line);
      line.layoutSizingVertical = 'FILL';
    };
    steps.outside = () => {
      root.appendChild(outside);
      outside.resize(Math.max(s.witnessOvershoot, 0.01), Math.max(outside.height, 1));
      outside.layoutSizingVertical = 'FILL';
      fillBars(outside, 'V');
    };
    steps.text = () => {
      // Upright, hug height, fixed width NARROWER than the text so it spills toward the line.
      textWrap.counterAxisAlignItems = 'CENTER';
      textWrap.primaryAxisAlignItems = flip ? 'MIN' : 'MAX';
      textWrap.appendChild(label);
      root.appendChild(textWrap);
      textWrap.resize(Math.max(label.width - Math.round(s.fontSize * TEXT_TIGHTEN_V), 1), Math.max(textWrap.height, 1));
      textWrap.layoutSizingVertical = 'HUG'; // last: re-hug height, keep fixed width
    };
    const order = flip ? ['text', 'outside', 'line', 'inside'] : ['inside', 'line', 'outside', 'text'];
    order.forEach((k) => steps[k]());
  }

  // Settle pass: the whole tree now exists, so re-apply Fill to the bands to clear the
  // stale 0-size on their stretch axis (see settleBand). Must be after all appends.
  settleBand(outside, orient, false, s.witnessOvershoot);
  settleBand(inside, orient, true, s.witnessOvershoot);
}

/**
 * Inline dimension: the label BREAKS the line. The middle band is a row/column of
 * [witness ‖ segment -> · Text · <- segment ‖ witness]: two dim-line segments whose OUTER
 * ends carry the arrows (inner ends clean), the label centered between them, and a witness
 * vector at each extremity so the witness line stays continuous straight through the band.
 * Around it, the same fixed outside-overshoot stub and growing inside band as standard.
 * `flip` puts the feature (growing band) on the opposite side.
 */
async function assembleInline(root: FrameNode, orient: 'H' | 'V', flip: boolean, s: Settings, label: TextNode) {
  const roundEnds = s.arrowStyle === 'ARROW_LINES';
  const gap = Math.max(3, Math.round(s.fontSize * 0.35)); // clear space between line ends and text
  const textH = Math.max(label.height, 1);
  const textW = Math.max(label.width, 1);
  // The band's near half already provides part of the overshoot; the stub tops it up so the
  // total overshoot past the line stays ~= witnessOvershoot (consistent with the standard).
  const stub = Math.max(s.witnessOvershoot - (orient === 'H' ? textH : textW) / 2, 1);

  const textWrap = figma.createFrame();
  textWrap.name = 'Text';
  textWrap.fills = [];
  textWrap.clipsContent = false;
  textWrap.itemSpacing = 0;
  textWrap.layoutMode = 'HORIZONTAL';
  textWrap.primaryAxisAlignItems = 'CENTER';
  textWrap.counterAxisAlignItems = 'CENTER';
  textWrap.setPluginData(K.role, 'text');
  textWrap.appendChild(label);

  const band = figma.createFrame();
  band.name = 'Inline';
  band.fills = [];
  band.clipsContent = false;
  band.itemSpacing = 0;
  band.layoutMode = orient === 'H' ? 'HORIZONTAL' : 'VERTICAL';
  band.primaryAxisAlignItems = 'CENTER';
  band.counterAxisAlignItems = 'CENTER';
  band.setPluginData(K.role, 'inline');

  const wA = witnessBar(orient, s.thickness, roundEnds); // crossing witness at the start extremity
  const wB = witnessBar(orient, s.thickness, roundEnds); // ...and the end extremity
  const segA = await inlineSegment(orient, s.thickness, s.arrowStyle, true); // arrow on the outer (start) end
  const segB = await inlineSegment(orient, s.thickness, s.arrowStyle, false); // arrow on the outer (end) end
  band.appendChild(wA);
  band.appendChild(segA);
  band.appendChild(textWrap);
  band.appendChild(segB);
  band.appendChild(wB);

  const outside = extensionBand(orient, s.thickness, roundEnds);
  const inside = extensionBand(orient, s.thickness, roundEnds);

  if (orient === 'H') {
    textWrap.paddingLeft = textWrap.paddingRight = gap;
    featurePad(root, 'H', flip, s.witnessGap);
    root.resize(LEN, stub + textH + INSIDE + s.witnessGap);
  } else {
    textWrap.paddingTop = textWrap.paddingBottom = gap;
    featurePad(root, 'V', flip, s.witnessGap);
    root.resize(stub + textW + INSIDE + s.witnessGap, LEN);
  }

  // Feature (growing inside band) side must match standard: H feature bottom / V feature
  // left when not flipped. The natural order differs by orientation (see assembleStandard).
  const order =
    orient === 'H'
      ? flip ? [inside, band, outside] : [outside, band, inside]
      : flip ? [outside, band, inside] : [inside, band, outside];
  order.forEach((n) => root.appendChild(n));

  if (orient === 'H') {
    outside.resize(Math.max(outside.width, 1), Math.max(stub, 0.01));
    outside.layoutSizingHorizontal = 'FILL';
    fillBars(outside, 'H');

    band.layoutSizingHorizontal = 'FILL';
    band.layoutSizingVertical = 'HUG';
    wA.layoutSizingHorizontal = 'FIXED';
    wA.layoutSizingVertical = 'FILL';
    wB.layoutSizingHorizontal = 'FIXED';
    wB.layoutSizingVertical = 'FILL';
    segA.layoutSizingHorizontal = 'FILL';
    segB.layoutSizingHorizontal = 'FILL';
    textWrap.layoutSizingHorizontal = 'HUG';
    textWrap.layoutSizingVertical = 'HUG';

    inside.layoutSizingHorizontal = 'FILL';
    inside.layoutSizingVertical = 'FILL';
    fillBars(inside, 'H');
  } else {
    outside.resize(Math.max(stub, 0.01), Math.max(outside.height, 1));
    outside.layoutSizingVertical = 'FILL';
    fillBars(outside, 'V');

    band.layoutSizingVertical = 'FILL';
    band.layoutSizingHorizontal = 'HUG';
    wA.layoutSizingVertical = 'FIXED';
    wA.layoutSizingHorizontal = 'FILL';
    wB.layoutSizingVertical = 'FIXED';
    wB.layoutSizingHorizontal = 'FILL';
    segA.layoutSizingVertical = 'FILL';
    segB.layoutSizingVertical = 'FILL';
    textWrap.layoutSizingHorizontal = 'HUG';
    textWrap.layoutSizingVertical = 'HUG';

    inside.layoutSizingHorizontal = 'FILL';
    inside.layoutSizingVertical = 'FILL';
    fillBars(inside, 'V');
  }

  // Settle pass (gotcha #2): clear the stale 0 on each nested band's fill axis after the
  // whole tree exists — the two extension bands and the inline band alike.
  settleBand(outside, orient, false, stub);
  settleBand(inside, orient, true, stub);
  if (orient === 'H') {
    band.resize(10, Math.max(textH, 1));
    band.layoutSizingHorizontal = 'FILL';
    band.layoutSizingVertical = 'HUG';
  } else {
    band.resize(Math.max(textW, 1), 10);
    band.layoutSizingVertical = 'FILL';
    band.layoutSizingHorizontal = 'HUG';
  }
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

// NOTE: under documentAccess: dynamic-page, figma.loadAllPagesAsync() MUST be
// awaited before this handler is registered (not just before it fires), so
// registration is deferred into init() after that await — never at top level.
async function onDocChange(e: DocumentChangeEvent) {
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
}

// ---------- lifecycle ----------

figma.showUI(__html__, { width: 264, height: 600, themeColors: true });

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'create') {
    // The variant grid sends orient + style/flip together; fold them into settings (so they
    // persist and land in the dropped frame's pluginData) before building.
    if (msg.labelStyle === 'standard' || msg.labelStyle === 'inline') settings.labelStyle = msg.labelStyle;
    if (typeof msg.flip === 'boolean') settings.flip = msg.flip;
    await figma.clientStorage.setAsync('settings', settings);
    await buildDimension(msg.orient);
  } else if (msg.type === 'settings') {
    settings = { ...settings, ...msg.settings };
    liveOn = settings.live;
    await figma.clientStorage.setAsync('settings', settings);
    // No loadAllPagesAsync here: init() already awaited it before registering
    // the documentchange handler, so toggling live on just flips the flag.
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
  // Required before registering documentchange under dynamic-page access. Done
  // unconditionally (not just when live is on) so the handler can be registered
  // now; the handler itself early-returns when liveOn is false, so it's cheap.
  await figma.loadAllPagesAsync().catch(() => {});
  figma.on('documentchange', onDocChange);
  await recalcAll(); // refresh any stale labels on reopen
})();
