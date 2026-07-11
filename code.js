"use strict";
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
    dpi: `${NS}:dpi`,
    unit: `${NS}:unit`,
    scale: `${NS}:scale`,
    decimals: `${NS}:decimals`,
    showUnit: `${NS}:showUnit`,
    role: `${NS}:role`,
};
const FONT = { family: 'Inter', style: 'Regular' };
const COLOR = { r: 0.11, g: 0.11, b: 0.12 };
// Unit magnitude per inch. Canvas inches = pixels / dpi (Figma baseline dpi = 72),
// so value = (pixels / dpi) * PER_INCH[unit] / scale.
const PER_INCH = {
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
const LEN = 240; // default measured span (the value tracks this)
const INSIDE = 40; // default inside-extension reach (grows on resize)
const PAD_BOTTOM = 4; // H: bottom padding under the inside band (matches reference)
const DEFAULTS = {
    thickness: 1.5,
    arrowStyle: 'ARROW_EQUILATERAL',
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
let settings = { ...DEFAULTS };
let liveOn = false;
let suppress = false; // guards the documentchange feedback loop
let availableFonts = []; // cached from listAvailableFontsAsync()
// ---------- geometry helpers ----------
/**
 * The dimension line: a two-point OPEN path, so both ends are open and receive
 * the arrow stroke cap. Length is provisional — as an auto-layout child with
 * layoutAlign STRETCH, Figma stretches it along the measured axis, moving the
 * far endpoint so the cap always sits at the true extremity.
 */
function dimLine(orient, length, thickness, style) {
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
function witnessBar(orient, thickness, roundEnds) {
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
 * An extension band: an auto-layout frame holding two witness vectors pushed to the
 * two ends (SPACE_BETWEEN). Used for both the outside overshoot stubs and the inside
 * witness lines.
 *   orient 'H' -> horizontal band, vertical bars at each end.
 *   orient 'V' -> vertical band, horizontal bars at top/bottom.
 * Bars are appended here; their FILL sizing is applied by fillBars() AFTER the band
 * itself has been parented and sized (Fill/Hug/Fixed must resolve outermost-first).
 */
function extensionBand(orient, thickness, roundEnds) {
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
function fillBars(band, orient) {
    for (const bar of band.children) {
        if (orient === 'H') {
            bar.layoutSizingHorizontal = 'FIXED'; // 0-width path
            bar.layoutSizingVertical = 'FILL';
        }
        else {
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
function settleBand(band, orient, grows, overshoot) {
    const fixed = Math.max(overshoot, 0.01);
    if (orient === 'H') {
        band.resize(10, grows ? 10 : fixed);
        band.layoutSizingHorizontal = 'FILL';
        if (grows)
            band.layoutSizingVertical = 'FILL';
    }
    else {
        band.resize(grows ? 10 : fixed, 10);
        band.layoutSizingVertical = 'FILL';
        if (grows)
            band.layoutSizingHorizontal = 'FILL';
    }
}
// ---------- value formatting ----------
function fmtFrom(frame, px) {
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
function resolveFont(family) {
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
async function buildDimension(orient) {
    const s = settings;
    if (!availableFonts.length)
        availableFonts = await figma.listAvailableFontsAsync();
    let font = resolveFont(s.fontFamily);
    try {
        await figma.loadFontAsync(font);
    }
    catch (e) {
        font = FONT; // family vanished / not loadable -> fall back to Inter
        await figma.loadFontAsync(FONT);
    }
    const root = figma.createFrame();
    root.name = `Dimension (${orient})`;
    root.fills = [];
    root.clipsContent = false;
    root.itemSpacing = 0;
    root.paddingTop = root.paddingBottom = root.paddingLeft = root.paddingRight = 0;
    root.setPluginData(K.isDim, '1');
    root.setPluginData(K.orient, orient);
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
    const textWrap = figma.createFrame();
    textWrap.name = 'Text';
    textWrap.fills = [];
    textWrap.clipsContent = false;
    textWrap.itemSpacing = 0;
    textWrap.layoutMode = 'HORIZONTAL';
    textWrap.setPluginData(K.role, 'text');
    // Line-arrow style gets rounded extension-line ends to match Figma's native look.
    const roundEnds = s.arrowStyle === 'ARROW_LINES';
    const line = dimLine(orient, LEN, s.thickness, s.arrowStyle);
    const outside = extensionBand(orient, s.thickness, roundEnds);
    const inside = extensionBand(orient, s.thickness, roundEnds);
    // Root is a fixed-size auto-layout box the user resizes freely; children Fill it.
    root.layoutMode = orient === 'H' ? 'VERTICAL' : 'HORIZONTAL';
    root.counterAxisAlignItems = 'CENTER';
    root.primaryAxisSizingMode = 'FIXED';
    root.counterAxisSizingMode = 'FIXED';
    // IMPORTANT: resize() forces BOTH axes back to Fixed sizing, so any Fill/Hug must
    // be applied AFTER the last resize() on a node — otherwise it's silently clobbered
    // (which pinned the extension bands to 0px). Order below is always resize-then-Fill.
    if (orient === 'H') {
        root.paddingBottom = PAD_BOTTOM;
        root.resize(LEN, Math.round(s.fontSize * TEXT_TIGHTEN_H) + s.witnessOvershoot + INSIDE + PAD_BOTTOM);
        // Text wrapper: hug width, fixed SHORT height -> text top-aligns and spills down.
        textWrap.counterAxisAlignItems = 'MIN';
        textWrap.primaryAxisAlignItems = 'CENTER';
        textWrap.appendChild(label);
        root.appendChild(textWrap);
        textWrap.resize(Math.max(textWrap.width, 1), Math.max(Math.round(s.fontSize * TEXT_TIGHTEN_H), 1));
        textWrap.layoutSizingHorizontal = 'HUG'; // last: re-hug width, keep fixed height
        root.appendChild(outside);
        outside.resize(Math.max(outside.width, 1), Math.max(s.witnessOvershoot, 0.01));
        outside.layoutSizingHorizontal = 'FILL'; // last: fill width, keep fixed height
        fillBars(outside, 'H');
        root.appendChild(line);
        line.layoutSizingHorizontal = 'FILL';
        root.appendChild(inside);
        inside.layoutSizingHorizontal = 'FILL';
        inside.layoutSizingVertical = 'FILL'; // grows -> reaches the feature
        fillBars(inside, 'H');
    }
    else {
        root.resize(INSIDE + s.witnessOvershoot + Math.max(label.width, 1), LEN);
        root.appendChild(inside);
        inside.layoutSizingHorizontal = 'FILL'; // grows -> reaches the feature
        inside.layoutSizingVertical = 'FILL';
        fillBars(inside, 'V');
        root.appendChild(line);
        line.layoutSizingVertical = 'FILL';
        root.appendChild(outside);
        outside.resize(Math.max(s.witnessOvershoot, 0.01), Math.max(outside.height, 1));
        outside.layoutSizingVertical = 'FILL'; // last: fill height, keep fixed width
        fillBars(outside, 'V');
        // Text wrapper: upright, hug height, fixed width NARROWER than the text and
        // right-aligned, so the text spills left toward the line.
        textWrap.counterAxisAlignItems = 'CENTER';
        textWrap.primaryAxisAlignItems = 'MAX';
        textWrap.appendChild(label);
        root.appendChild(textWrap);
        textWrap.resize(Math.max(label.width - Math.round(s.fontSize * TEXT_TIGHTEN_V), 1), Math.max(textWrap.height, 1));
        textWrap.layoutSizingVertical = 'HUG'; // last: re-hug height, keep fixed width
    }
    // Settle pass: the whole tree now exists, so re-apply Fill to the bands to clear the
    // stale 0-size on their stretch axis (see settleBand). Must be after all appends.
    settleBand(outside, orient, false, s.witnessOvershoot);
    settleBand(inside, orient, true, s.witnessOvershoot);
    root.x = Math.round(figma.viewport.center.x - root.width / 2);
    root.y = Math.round(figma.viewport.center.y - root.height / 2);
    figma.currentPage.selection = [root];
}
// ---------- recompute ----------
async function recalcLabel(frame) {
    if (frame.getPluginData(K.isDim) !== '1')
        return;
    const label = frame.findOne((n) => n.getPluginData(K.role) === 'label');
    if (!label)
        return;
    const orient = frame.getPluginData(K.orient);
    const span = orient === 'V' ? frame.height : frame.width;
    const next = fmtFrom(frame, span);
    if (label.characters === next)
        return; // diff guard: no needless writes / loops
    await figma.loadFontAsync(label.fontName);
    suppress = true;
    label.characters = next;
    suppress = false;
}
async function recalcAll() {
    const dims = figma.currentPage.findAll((n) => n.getPluginData(K.isDim) === '1');
    for (const d of dims)
        await recalcLabel(d);
}
// ---------- live mode ----------
// NOTE: under documentAccess: dynamic-page, figma.loadAllPagesAsync() MUST be
// awaited before this handler is registered (not just before it fires), so
// registration is deferred into init() after that await — never at top level.
async function onDocChange(e) {
    if (!liveOn || suppress)
        return;
    const seen = new Set();
    for (const c of e.documentChanges) {
        if (c.type !== 'PROPERTY_CHANGE')
            continue;
        if (!(c.properties.includes('width') || c.properties.includes('height')))
            continue;
        const n = c.node;
        if (!n || n.removed)
            continue;
        if (n.getPluginData && n.getPluginData(K.isDim) === '1' && !seen.has(n.id)) {
            seen.add(n.id);
            await recalcLabel(n);
        }
    }
}
// ---------- lifecycle ----------
figma.showUI(__html__, { width: 264, height: 600, themeColors: true });
figma.ui.onmessage = async (msg) => {
    if (msg.type === 'create') {
        await buildDimension(msg.orient);
    }
    else if (msg.type === 'settings') {
        settings = { ...settings, ...msg.settings };
        liveOn = settings.live;
        await figma.clientStorage.setAsync('settings', settings);
        // No loadAllPagesAsync here: init() already awaited it before registering
        // the documentchange handler, so toggling live on just flips the flag.
    }
    else if (msg.type === 'recalc') {
        await recalcAll();
    }
};
(async function init() {
    const saved = (await figma.clientStorage.getAsync('settings'));
    if (saved)
        settings = { ...DEFAULTS, ...saved };
    liveOn = settings.live;
    availableFonts = await figma.listAvailableFontsAsync();
    const families = Array.from(new Set(availableFonts.map((f) => f.fontName.family))).sort();
    figma.ui.postMessage({ type: 'init', settings, fonts: families });
    // Required before registering documentchange under dynamic-page access. Done
    // unconditionally (not just when live is on) so the handler can be registered
    // now; the handler itself early-returns when liveOn is false, so it's cheap.
    await figma.loadAllPagesAsync().catch(() => { });
    figma.on('documentchange', onDocChange);
    await recalcAll(); // refresh any stale labels on reopen
})();
