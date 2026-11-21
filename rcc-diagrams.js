/*
 * RCC Estimator — interactive drawings.
 * Builds SVG views from an engine result's `drawing` object. Every meaningful part carries
 *   data-tip   — tooltip text (hover / tap)
 *   data-hl    — highlight key, linked to spec / check rows in the page
 *   data-layer — rebar | dims | labels, so the page can toggle layers
 * Loads in the browser as window.RCCDiagrams, and in Node via require().
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RCCDiagrams = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const W = 760;
  const f = n => (Math.round(n * 10) / 10);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const bs = b => (b ? `${b.dia} mm Ø @ ${b.spacing} mm c/c` : '—');
  const bshort = b => (b ? `${b.dia}Ø @ ${b.spacing}` : '');
  const ast = b => (b ? `As = ${Math.round(b.ast)} mm²/m` : '');
  const kgm = b => (b ? `${(b.dia * b.dia / 162).toFixed(3)} kg/m per bar` : '');

  // ───── SVG primitives ─────
  function at(o) {
    return Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== false && v !== '')
      .map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
  }
  function meta(m) {
    if (!m) return {};
    const o = {};
    if (m.cls) o.class = m.cls;
    if (m.tip) o['data-tip'] = m.tip;
    if (m.hl) o['data-hl'] = m.hl;
    if (m.layer) o['data-layer'] = m.layer;
    if (m.style) o.style = m.style;
    if (m.anchor) o['text-anchor'] = m.anchor;
    return o;
  }
  const rect = (x, y, w, h, m) => `<rect ${at({ x: f(x), y: f(y), width: f(Math.max(w, 0)), height: f(Math.max(h, 0)), ...meta(m) })}/>`;
  const line = (x1, y1, x2, y2, m) => `<line ${at({ x1: f(x1), y1: f(y1), x2: f(x2), y2: f(y2), ...meta(m) })}/>`;
  const circ = (cx, cy, r, m) => `<circle ${at({ cx: f(cx), cy: f(cy), r: f(r), ...meta(m) })}/>`;
  const path = (d, m) => `<path ${at({ d, ...meta(m) })}/>`;
  const text = (x, y, s, m = {}) => `<text ${at({ x: f(x), y: f(y), ...meta({ layer: 'labels', ...m }) })}>${esc(s)}</text>`;
  const group = (inner, m) => `<g ${at(meta(m))}>${inner}</g>`;
  const P = pts => pts.map((p, i) => (i ? 'L' : 'M') + f(p[0]) + ',' + f(p[1])).join(' ');

  // a visible bar line + a wide invisible hit line carrying the tooltip
  function bar(pts, m, w = 2) {
    const d = P(pts);
    return group(
      path(d, { cls: m.cls || 'rebar', style: `stroke-width:${f(clamp(w, 1.4, 9))}px` }) +
      path(d, { cls: 'hit' }), { tip: m.tip, hl: m.hl, layer: 'rebar' });
  }
  function dots(x0, x1, y, spacingPx, r, m, offset) {
    let every = 1;
    while (spacingPx * every < 2 * r + 2.5) every++;
    let s = '';
    const step = spacingPx * every;
    const start = x0 + (offset != null ? offset : step / 2);
    for (let x = start; x <= x1 + 0.01; x += step) s += circ(x, y, r, { cls: m.cls || 'dot' });
    const tip = m.tip + (every > 1 ? `\n(every ${every}${every === 2 ? 'nd' : every === 3 ? 'rd' : 'th'} bar drawn)` : '');
    return group(s, { tip, hl: m.hl, layer: 'rebar' });
  }
  function dimH(x1, x2, y, label, up = true) {
    return group(
      line(x1, y, x2, y, { cls: 'dim' }) + line(x1, y - 4, x1, y + 4, { cls: 'dim' }) + line(x2, y - 4, x2, y + 4, { cls: 'dim' }) +
      text((x1 + x2) / 2, up ? y - 5 : y + 13, label, { cls: 'dt', anchor: 'middle', layer: 'dims' }), { layer: 'dims' });
  }
  function dimV(x, y1, y2, label, side = 'right') {
    const tx = side === 'right' ? x + 6 : x - 6;
    return group(
      line(x, y1, x, y2, { cls: 'dim' }) + line(x - 4, y1, x + 4, y1, { cls: 'dim' }) + line(x - 4, y2, x + 4, y2, { cls: 'dim' }) +
      text(tx, (y1 + y2) / 2 + 4, label, { cls: 'dt', anchor: side === 'right' ? 'start' : 'end', layer: 'dims' }), { layer: 'dims' });
  }
  function arrowDown(x, y1, y2, m = {}) {
    return group(line(x, y1, x, y2 - 6, { cls: 'load' }) + path(`M${f(x - 4.5)},${f(y2 - 8)} L${f(x + 4.5)},${f(y2 - 8)} L${f(x)},${f(y2)} Z`, { cls: 'load-h' }), m);
  }
  function arrowH(x1, x2, y, m = {}) { // tip at x2
    const d = x2 > x1 ? 1 : -1;
    return group(line(x1, y, x2 - 6 * d, y, { cls: 'load' }) + path(`M${f(x2 - 8 * d)},${f(y - 4.5)} L${f(x2 - 8 * d)},${f(y + 4.5)} L${f(x2)},${f(y)} Z`, { cls: 'load-h' }), m);
  }
  // right-hand callouts with leader lines, de-overlapped
  function callouts(items, xFrom, xLab) {
    const list = items.slice().sort((a, b) => a.y - b.y);
    const longest = Math.max(0, ...list.map(it => String(it.text).length));
    xLab = Math.min(xLab, W - 8 - longest * 7.1); // keep labels inside the canvas
    let last = -1e9;
    for (const it of list) { it.ly = Math.max(it.y, last + 15); last = it.ly; }
    return list.map(it => group(
      path(P([[it.x || xFrom, it.y], [xLab - 26, it.ly], [xLab - 4, it.ly]]), { cls: 'lead' }) +
      text(xLab, it.ly + 4, it.text, { cls: 'lbl' + (it.cls ? ' ' + it.cls : '') }), { hl: it.hl, tip: it.tip, layer: 'labels' })).join('');
  }
  function scaleNote(x, y, ex) {
    return text(x, y, ex > 1.05 ? `Depth exaggerated ×${ex.toFixed(1)} · horizontal to scale` : 'True scale', { cls: 'note', anchor: 'end' });
  }

  const DEFS = `<defs>
    <pattern id="pSoil" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="9" height="9" fill="#dcc9a8"/><line x1="0" y1="0" x2="0" y2="9" stroke="#bfa27a" stroke-width="1.2"/></pattern>
    <pattern id="pGsb" width="12" height="12" patternUnits="userSpaceOnUse"><rect width="12" height="12" fill="#efe6d3"/><circle cx="3" cy="3" r="1.5" fill="#c9b68e"/><circle cx="9" cy="8" r="1.1" fill="#c9b68e"/><circle cx="6" cy="11" r=".8" fill="#c9b68e"/></pattern>
    <pattern id="pWmm" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="#e3dccd"/><path d="M2 2 l3 1 -2 2z M7 6 l2 2 -3 1z" fill="#a8977a"/></pattern>
    <pattern id="pConc" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="#e6eaf0"/><circle cx="4" cy="5" r=".9" fill="#b4bfcc"/><circle cx="12" cy="12" r=".7" fill="#b4bfcc"/><path d="M10 3 l2.4 1 -1.8 1.4z" fill="#c2cbd6"/><path d="M3 12 l1.8 .6 -1 1.2z" fill="#c2cbd6"/></pattern>
    <pattern id="pDlc" width="14" height="14" patternUnits="userSpaceOnUse"><rect width="14" height="14" fill="#d3dae4"/><circle cx="4" cy="4" r="1.2" fill="#a3afbf"/><circle cx="10" cy="10" r="1" fill="#a3afbf"/></pattern>
    <pattern id="pTors" width="7" height="7" patternUnits="userSpaceOnUse"><rect width="7" height="7" fill="rgba(147,51,234,.07)"/><path d="M0 7 L7 0 M0 0 L7 7" stroke="rgba(147,51,234,.55)" stroke-width=".7"/></pattern>
    <pattern id="pDebond" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="#64748b"/><line x1="0" y1="0" x2="0" y2="5" stroke="#cbd5e1" stroke-width="1.6"/></pattern>
  </defs>`;
  const svgWrap = (h, inner, label) =>
    `<svg class="dg-svg" viewBox="0 0 ${W} ${f(h)}" data-w="${W}" data-h="${f(h)}" role="img" aria-label="${esc(label)}">${DEFS}${inner}</svg>`;

  // ───── generic slab section (tank roof, drain cover) ─────
  /*
   * p: { title, clear, wall, D, cover, grade, fill, fillGamma, main, cross, mainOuter, mainHl, crossHl, mainName, crossName,
   *      topMain, topCross, topMainOuter, topMainHl, topCrossHl, topExtent:'full'|'supports', torsionLen,
   *      P, impact, along, q, below:'water'|'drain', wallTip, wallHl }
   */
  function slabSection(p, o) {
    const ML = 40, MR = 210, top0 = 78;
    const total = p.clear + 2 * p.wall;
    const sx = (W - ML - MR) / total;
    const ex = o.ex ? clamp(82 / (p.D * sx), 1, 25) : 1;
    const sy = sx * ex;
    const fillH = (p.fill || 0) * 1000 * sy;
    const slabTop = top0 + fillH, slabBot = slabTop + p.D * sy;
    const wallH = clamp(1100 * sy, 60, 130);
    const xL = ML, xR = ML + total * sx, xi0 = xL + p.wall * sx, xi1 = xR - p.wall * sx;
    let s = '';
    s += text(ML, 22, p.title, { cls: 'ttl' });
    if (fillH > 0) s += rect(xL - 20, top0, total * sx + 40, fillH, { cls: 'soil', tip: `Soil fill ${p.fill} m × ${p.fillGamma} kN/m³ = ${(p.fill * p.fillGamma).toFixed(1)} kPa dead load`, hl: 'fill' });
    // walls / supports
    const wallTip = p.wallTip || `Support wall ${p.wall} mm`;
    s += rect(xL, slabBot, p.wall * sx, wallH, { cls: 'wall', tip: wallTip, hl: p.wallHl || 'wall' });
    s += rect(xi1, slabBot, p.wall * sx, wallH, { cls: 'wall', tip: wallTip, hl: p.wallHl || 'wall' });
    if (p.below === 'water') {
      s += rect(xi0, slabBot + wallH * 0.3, xi1 - xi0, wallH * 0.7, { cls: 'water', tip: 'Water side — humid face: IS 3370 crack-width limit applies to the slab underside' });
      s += line(xi0, slabBot + wallH * 0.3, xi1, slabBot + wallH * 0.3, { cls: 'wl' });
      s += text((xi0 + xi1) / 2, slabBot + wallH * 0.68, 'water', { cls: 'note', anchor: 'middle' });
    } else s += text((xi0 + xi1) / 2, slabBot + wallH * 0.55, p.below === 'drain' ? 'drain' : '', { cls: 'note', anchor: 'middle' });
    // slab
    s += rect(xL, slabTop, total * sx, p.D * sy, { cls: p.precast ? 'conc-pc' : 'conc', tip: `${p.precast ? 'Precast ' : ''}RCC ${p.grade} slab, ${p.D} mm thick\nClear span ${(p.clear / 1000).toFixed(2)} m · cover ${p.cover} mm`, hl: 'slab' });

    // reinforcement — bottom
    const outer = p.mainOuter ? p.main : p.cross, inner = p.mainOuter ? p.cross : p.main;
    const yOut = slabBot - (p.cover + outer.dia / 2) * sy;
    const yIn = slabBot - (p.cover + outer.dia + inner.dia / 2) * sy;
    const yMain = p.mainOuter ? yOut : yIn, yCross = p.mainOuter ? yIn : yOut;
    const bx0 = xL + 30 * sx + 2, bx1 = xR - 30 * sx - 2;
    const hook = Math.min(10, p.D * sy * 0.35);
    const items = [];
    s += bar([[bx0, yMain - hook], [bx0, yMain], [bx1, yMain], [bx1, yMain - hook]],
      { tip: `${p.mainName}: ${bs(p.main)}\n${ast(p.main)} · ${p.steel || 'TMT'}\nRuns in the plane of this section`, hl: p.mainHl }, p.main.dia * sy);
    s += dots(bx0 + 4, bx1 - 4, yCross, p.cross.spacing * sx, clamp(p.cross.dia / 2 * sy, 1.7, 5.5),
      { tip: `${p.crossName}: ${bs(p.cross)}\n${ast(p.cross)}\nSeen end-on in this section`, hl: p.crossHl });
    items.push({ y: yMain, x: bx1, text: `${bshort(p.main)} ${p.mainLabel || 'main'}`, hl: p.mainHl });
    items.push({ y: yCross, x: bx1 - 6, text: `${bshort(p.cross)} ${p.crossLabel || 'dist.'}`, hl: p.crossHl });

    // top reinforcement
    if (p.topMain && p.topCross) {
      const tOut = p.topMainOuter ? p.topMain : p.topCross, tIn = p.topMainOuter ? p.topCross : p.topMain;
      const ytO = slabTop + (p.cover + tOut.dia / 2) * sy;
      const ytI = slabTop + (p.cover + tOut.dia + tIn.dia / 2) * sy;
      const ytMain = p.topMainOuter ? ytO : ytI, ytCross = p.topMainOuter ? ytI : ytO;
      const segs = p.topExtent === 'supports'
        ? [[bx0, xi0 + 0.3 * p.clear * sx], [xi1 - 0.3 * p.clear * sx, bx1]]
        : [[bx0, bx1]];
      for (const [a, b] of segs) {
        s += bar([[a, ytMain + hook], [a, ytMain], [b, ytMain]].concat(p.topExtent === 'supports' ? [] : [[b, ytMain + hook]]),
          { cls: 'rebar-top', tip: `${p.topMainName}: ${bs(p.topMain)}\n${ast(p.topMain)}${p.topExtent === 'supports' ? '\nExtends 0.3 × span from each support' : ''}`, hl: p.topMainHl }, p.topMain.dia * sy);
        s += dots(a + 4, b - 4, ytCross, p.topCross.spacing * sx, clamp(p.topCross.dia / 2 * sy, 1.7, 5.5),
          { cls: 'dot-top', tip: `${p.topCrossName}: ${bs(p.topCross)}\n${ast(p.topCross)}`, hl: p.topCrossHl });
      }
      items.push({ y: ytMain, x: segs[segs.length - 1][1], text: `${bshort(p.topMain)} top`, hl: p.topMainHl, cls: 'lbl-top' });
    }
    if (p.torsionLen) {
      const yT = slabTop + (p.cover + 4) * sy + (p.topMain ? 6 : 0);
      for (const [a, b] of [[bx0, xi0 + p.torsionLen * sx], [xi1 - p.torsionLen * sx, bx1]]) {
        s += bar([[a, yT + hook * 0.8], [a, yT], [b, yT]], { cls: 'rebar-top', tip: `Corner torsion steel (IS 456 D-1.8): ${bs(p.main)} top, both ways\nover ${(p.torsionLen / 1000).toFixed(2)} m from each corner`, hl: 'torsion' }, p.main.dia * sy);
      }
      items.push({ y: yT, x: bx1, text: 'corner torsion (top)', hl: 'torsion', cls: 'lbl-top' });
    }

    // loads
    if (p.P > 0) {
      const xc = (xi0 + xi1) / 2, along = Math.max(p.along || 250, 100);
      const w0 = along * sx, w1 = (along + 2 * (p.fill || 0) * 1000) * sx;
      if (fillH > 0) s += path(P([[xc - w0 / 2, top0], [xc + w0 / 2, top0], [xc + w1 / 2, slabTop], [xc - w1 / 2, slabTop]]) + ' Z',
        { cls: 'disp', tip: `45° load dispersion through ${p.fill} m fill\nContact ${along} mm → ${Math.round(along + 2000 * p.fill)} mm at slab level`, hl: 'load' });
      s += group(circ(xc, top0 - 26, 14, { cls: 'tyre' }) + rect(xc - w0 / 2, top0 - 4, w0, 4, { cls: 'patch' }) + arrowDown(xc, 6, top0 - 40) +
        text(xc + 22, top0 - 34, `${p.P} kN × ${p.impact} impact`, { cls: 'load-t' }),
        { tip: `Wheel load ${p.P} kN × impact ${p.impact} = ${(p.P * p.impact).toFixed(1)} kN\nPlaced at mid-span for moment, near support for shear`, hl: 'load' });
    } else if (p.q > 0) {
      let a = '';
      for (let x = xi0 + 10; x <= xi1 - 10; x += 34) a += arrowDown(x, top0 - 30, top0 - 2);
      s += group(a + line(xi0 + 10, top0 - 30, xi1 - 10, top0 - 30, { cls: 'load' }) + text(xi0 + 10, top0 - 36, `${p.q} kPa live load (UDL)`, { cls: 'load-t' }),
        { tip: `Uniform live load ${p.q} kPa`, hl: 'load' });
    }
    // dims
    s += dimV(xR + 12, slabTop, slabBot, `${p.D}`);
    if (fillH > 0) s += dimV(xR + 12, top0, slabTop, `${p.fill} m`);
    s += dimH(xi0, xi1, slabBot + wallH + 22, `clear span ${(p.clear / 1000).toFixed(2)} m`);
    s += dimH(xL, xi0, slabBot + wallH + 22, `${p.wall}`, false);
    s += text(xR + 12, slabBot + 16, `cover ${p.cover}`, { cls: 'dt', layer: 'dims' });
    s += callouts(items, xR, xR + 70);
    const H = slabBot + wallH + 52;
    s += scaleNote(W - 8, H - 6, ex);
    return { svg: s, h: H };
  }

  // ───── generic true-scale 1 m strip detail ─────
  function strip(p) {
    const ML = 70, MR = 210, top = 60, width = 1000;
    const sc = (W - ML - MR) / width;
    const Dp = p.D * sc, bot = top + Dp, xR = ML + width * sc;
    let s = text(ML, 22, p.title, { cls: 'ttl' });
    s += rect(ML, top, width * sc, Dp, { cls: 'conc', tip: p.slabTip, hl: 'slab' });
    if (p.below) s += rect(ML, bot, width * sc, 40, { cls: p.below, tip: p.belowTip, hl: p.belowHl });
    if (p.fibre) {
      let fs = '';
      for (let i = 0; i < 160; i++) {
        const x = ML + 6 + ((i * 37.3) % (width * sc - 12)), y = top + 5 + ((i * 17.7) % Math.max(Dp - 10, 4)), a = (i * 47) % 180;
        const dx = 4 * Math.cos(a * Math.PI / 180), dy = 4 * Math.sin(a * Math.PI / 180);
        fs += line(x - dx, y - dy, x + dx, y + dy, { cls: 'fibre' });
      }
      s += group(fs, { tip: p.fibreTip, hl: 'mesh', layer: 'rebar' });
    }
    const items = [];
    const layer = (outerB, innerB, face, cls, hlO, hlI, nameO, nameI) => {
      if (!outerB) return;
      const sgn = face === 'bottom' ? -1 : 1, edge = face === 'bottom' ? bot : top;
      const yO = edge + sgn * (p.cover + outerB.dia / 2) * sc;
      const yI = edge + sgn * (p.cover + outerB.dia + (innerB ? innerB.dia / 2 : 0)) * sc;
      if (innerB) {
        s += bar([[ML + 4, yI], [xR - 4, yI]], { cls: cls === 'dot-top' ? 'rebar-top' : 'rebar', tip: `${nameI}: ${bs(innerB)}\n${ast(innerB)} · drawn to true diameter`, hl: hlI }, innerB.dia * sc);
      }
      s += dots(ML, xR, yO, outerB.spacing * sc, outerB.dia / 2 * sc, { cls, tip: `${nameO}: ${bs(outerB)}\n${ast(outerB)} · ${Math.round(1000 / outerB.spacing)} bars per metre`, hl: hlO }, outerB.spacing * sc / 2);
      items.push({ y: yO, x: xR - 4, text: `${bshort(outerB)} ${nameO.toLowerCase().includes('short') ? '(short span)' : ''}`.trim(), hl: hlO, cls: face === 'top' ? 'lbl-top' : '' });
      if (innerB) items.push({ y: yI, x: xR - 4, text: `${bshort(innerB)}`, hl: hlI, cls: face === 'top' ? 'lbl-top' : '' });
      if (face === 'bottom') {
        s += dimV(ML - 14, yO + outerB.dia / 2 * sc, bot, `${p.cover}`, 'left');
        const x1 = ML + outerB.spacing * sc / 2, x2 = x1 + outerB.spacing * sc;
        s += dimH(x1, x2, bot + (p.below ? 58 : 18), `${outerB.spacing} c/c`, false);
      }
    };
    layer(p.bOuter, p.bInner, 'bottom', 'dot', p.hlBO, p.hlBI, p.nameBO, p.nameBI);
    layer(p.tOuter, p.tInner, 'top', 'dot-top', p.hlTO, p.hlTI, p.nameTO, p.nameTI);
    if (p.sawcut) {
      const xc = ML + width / 2 * sc, dep = p.D / 4 * sc;
      s += group(rect(xc - 2, top, 4, dep, { cls: 'saw' }) + rect(xc - 4, top, 8, 10 * sc + 2, { cls: 'seal' }),
        { tip: `Sawn joint: 3–5 mm wide, depth h/4 = ${Math.round(p.D / 4)} mm, cut within 24 h\nSealant in widened top groove`, hl: 'joint' });
      s += line(xc, top + dep, xc, bot, { cls: 'crack' });
    }
    s += dimV(xR + 12, top, bot, `${p.D} mm`);
    s += dimH(ML, xR, top - 14, '1000 mm strip');
    s += callouts(items, xR, xR + 80);
    const H = bot + (p.below ? 84 : 44);
    s += scaleNote(W - 8, H - 6, 1);
    return { svg: s, h: H };
  }

  // ───── layered pavement / floor section helper ─────
  function layerStack(list, x0, x1, y0, sy, xLab) {
    let s = '', y = y0;
    const items = [];
    for (const L of list) {
      const h = Math.max(L.t * sy, L.min || 0);
      const xa = L.x0 != null ? L.x0 : x0, xb = L.x1 != null ? L.x1 : x1;
      s += rect(xa, y, xb - xa, h, { cls: L.cls, tip: L.tip, hl: L.hl });
      items.push({ y: y + h / 2, x: xb - 2, text: L.label, hl: L.hl, cls: L.bold ? 'lbl-b' : '' });
      L.y = y; L.h = h; y += h;
    }
    return { svg: s, bottom: y, items };
  }

  // ═════════════ TANK ═════════════
  function tankCommon(d) {
    const torsionLen = d.torsion ? d.lx * 1000 / 5 : 0;
    return {
      D: d.D, cover: d.cover, grade: d.grade, wall: d.wall, fill: d.fill, fillGamma: d.fillGamma, steel: d.steel,
      P: d.P, impact: d.impact, along: d.along, q: d.q, below: 'water',
      wallTip: `Tank wall ${d.wall} mm — slab bears on wall (${d.edge === 'fixed' ? 'fixed' : 'simply supported'})`,
      topExtent: d.edge === 'fixed' ? 'supports' : 'full', torsionLen,
    };
  }
  function tankA(d, o) {
    return slabSection({
      ...tankCommon(d), title: 'Section A–A · across short span', clear: d.lx * 1000,
      main: d.xb, cross: d.yb, mainOuter: true, mainHl: 'xb', crossHl: 'yb',
      mainName: 'Bottom short-span bars (main)', crossName: d.oneWay ? 'Distribution bars' : 'Bottom long-span bars', mainLabel: 'bottom', crossLabel: d.oneWay ? 'dist.' : 'long',
      topMain: d.xt, topCross: d.yt, topMainOuter: true, topMainHl: 'xt', topCrossHl: 'xt',
      topMainName: d.edge === 'fixed' ? 'Top bars over supports (short span)' : 'Top crack-control mesh (short span)', topCrossName: 'Top bars (long span)',
    }, o);
  }
  function tankB(d, o) {
    return slabSection({
      ...tankCommon(d), title: 'Section B–B · across long span', clear: d.ly * 1000, torsionLen: d.torsion ? d.lx * 1000 / 5 : 0,
      main: d.yb, cross: d.xb, mainOuter: false, mainHl: 'yb', crossHl: 'xb',
      mainName: d.oneWay ? 'Distribution bars' : 'Bottom long-span bars', crossName: 'Bottom short-span bars (main)', mainLabel: d.oneWay ? 'dist.' : 'long', crossLabel: 'main',
      topMain: d.yt, topCross: d.xt, topMainOuter: false, topMainHl: 'xt', topCrossHl: 'xt',
      topMainName: 'Top bars (long span)', topCrossName: 'Top bars (short span)',
    }, o);
  }
  function tankPlan(d) {
    const ML = 70, MR = 70, MT = 56;
    const LX = d.ly * 1000, LY = d.lx * 1000; // long span horizontal
    const tw = d.wall;
    const sc = Math.min((W - ML - MR) / (LX + 2 * tw), 400 / (LY + 2 * tw));
    const ox = ML, oy = MT, ix = ox + tw * sc, iy = oy + tw * sc, iw = LX * sc, ih = LY * sc;
    let s = text(ML, 22, 'Plan · bottom reinforcement (top steel dashed)', { cls: 'ttl' });
    s += rect(ox, oy, (LX + 2 * tw) * sc, (LY + 2 * tw) * sc, { cls: 'wall', tip: `Tank walls ${tw} mm`, hl: 'wall' });
    s += rect(ix, iy, iw, ih, { cls: 'conc-plan', tip: `Slab ${d.D} mm ${d.grade}, clear ${d.ly} × ${d.lx} m`, hl: 'slab' });
    // bottom short-span bars (vertical in plan), spaced along long direction
    const lines = (count, fn) => { let o = ''; for (let i = 0; i < count; i++) o += fn(i); return o; };
    const every = sp => { let e = 1; while (sp * sc * e < 6) e++; return e; };
    const ex = every(d.xb.spacing), ey = every(d.yb.spacing);
    const nX = Math.floor(LX / (d.xb.spacing * ex)), nY = Math.floor(LY / (d.yb.spacing * ey));
    s += group(lines(nX, i => line(ix + (i + 0.5) * d.xb.spacing * ex * sc, iy - tw * sc * 0.6, ix + (i + 0.5) * d.xb.spacing * ex * sc, iy + ih + tw * sc * 0.6, { cls: 'pbar' })),
      { tip: `Bottom short-span bars (main): ${bs(d.xb)}${ex > 1 ? `\n(every ${ex}th bar drawn)` : ''}`, hl: 'xb', layer: 'rebar' });
    s += group(lines(nY, i => line(ix - tw * sc * 0.6, iy + (i + 0.5) * d.yb.spacing * ey * sc, ix + iw + tw * sc * 0.6, iy + (i + 0.5) * d.yb.spacing * ey * sc, { cls: 'pbar2' })),
      { tip: `Bottom long-span bars: ${bs(d.yb)}${ey > 1 ? `\n(every ${ey}th bar drawn)` : ''}`, hl: 'yb', layer: 'rebar' });
    if (d.xt) {
      if (d.edge === 'fixed') {
        const band = 0.3 * LY * sc;
        s += group(rect(ix, iy, iw, band, { cls: 'topband' }) + rect(ix, iy + ih - band, iw, band, { cls: 'topband' }) +
          rect(ix, iy, 0.3 * LY * sc, ih, { cls: 'topband' }) + rect(ix + iw - 0.3 * LY * sc, iy, 0.3 * LY * sc, ih, { cls: 'topband' }),
          { tip: `Top bars over supports: ${bs(d.xt)} (short) / ${bs(d.yt)} (long)\nBand 0.3 × short span from each support`, hl: 'xt', layer: 'rebar' });
      } else {
        s += group(rect(ix + 3, iy + 3, iw - 6, ih - 6, { cls: 'topmesh' }), { tip: `Top crack-control mesh: ${bs(d.xt)} / ${bs(d.yt)} (IS 3370, slab ≥ 200 mm)`, hl: 'xt', layer: 'rebar' });
      }
    }
    if (d.torsion) {
      const z = LY / 5 * sc;
      for (const [x, y] of [[ix, iy], [ix + iw - z, iy], [ix, iy + ih - z], [ix + iw - z, iy + ih - z]])
        s += rect(x, y, z, z, { cls: 'torsion', tip: `Corner torsion steel: ${bs(d.xb)} top & bottom, both ways\nover ${(d.lx / 5).toFixed(2)} × ${(d.lx / 5).toFixed(2)} m (IS 456 D-1.8)`, hl: 'torsion', layer: 'rebar' });
    }
    if (d.manhole > 0) {
      const m = d.manhole * 1000 * sc, mx = ix + iw * 0.22, my = iy + ih / 2 - m / 2;
      const phi = Math.max(d.xb.dia, 12), ext = 50 * phi * sc;
      s += rect(mx, my, m, m, { cls: 'opening', tip: `Manhole opening ${d.manhole} × ${d.manhole} m`, hl: 'trim' });
      let t = '';
      for (const off of [-6, -10]) {
        t += line(mx - ext, my + off, mx + m + ext, my + off, { cls: 'trim' }) + line(mx - ext, my + m - off, mx + m + ext, my + m - off, { cls: 'trim' });
        t += line(mx + off, my - ext, mx + off, my + m + ext, { cls: 'trim' }) + line(mx + m - off, my - ext, mx + m - off, my + m + ext, { cls: 'trim' });
      }
      s += group(t, { tip: `Trimmer bars: 2 × ${phi} mm each side, each layer\nextend 50Ø = ${50 * phi} mm beyond opening`, hl: 'trim', layer: 'rebar' });
      s += text(mx + m / 2, my + m / 2 + 4, 'MH', { cls: 'note', anchor: 'middle' });
    }
    s += dimH(ix, ix + iw, oy - 10, `${d.ly} m (long span)`);
    s += dimV(ox - 14, iy, iy + ih, `${d.lx} m`, 'left');
    const H = oy + (LY + 2 * tw) * sc + 40;
    s += text(ML, H - 10, 'solid red: bottom bars · dashed violet: top steel · hatched: corner torsion zones', { cls: 'note' });
    return { svg: s, h: H };
  }
  function tankStrip(d) {
    return strip({
      title: 'Bar detail · 1 m strip cut parallel to long span (true scale)', D: d.D, cover: d.cover, below: 'water', belowTip: 'Water side', belowHl: 'slab',
      slabTip: `RCC ${d.grade}, ${d.D} mm · nominal cover ${d.cover} mm (IS 3370)`,
      bOuter: d.xb, bInner: d.yb, hlBO: 'xb', hlBI: 'yb', nameBO: 'Bottom short-span bars', nameBI: 'Bottom long-span bars',
      tOuter: d.xt, tInner: d.yt, hlTO: 'xt', hlTI: 'xt', nameTO: 'Top short-span bars', nameTI: 'Top long-span bars',
    });
  }

  // ═════════════ DRAIN ═════════════
  function drainSection(d) {
    const soilM = 450, totalW = d.B * 1000 + 2 * d.tw + 2 * soilM;
    const coverD = d.cov ? d.cov.D : 0;
    const totalH = coverD + d.H * 1000 + d.tb + 75 + 180;
    const ML = 80, MR = 200, MT = 64;
    const sc = Math.min((W - ML - MR) / totalW, 430 / totalH);
    const x0 = ML + soilM * sc, xi0 = x0 + d.tw * sc, xi1 = xi0 + d.B * 1000 * sc, x1 = xi1 + d.tw * sc;
    const yTop = MT + coverD * sc, yBt = yTop + d.H * 1000 * sc, yBb = yBt + d.tb * sc, yP = yBb + 75 * sc;
    const sW = totalW * sc;
    let s = text(ML, 22, 'Cross-section · true scale', { cls: 'ttl' });
    s += rect(ML, yTop, sW, yP - yTop + 180 * sc, { cls: 'soil', tip: `Backfill: γ = ${d.gamma} kN/m³, K₀ = ${d.K0.toFixed(3)}`, hl: 'soil' });
    s += rect(x0 - 75 * sc - (d.toe || 0) * sc, yBb, x1 - x0 + 150 * sc + 2 * (d.toe || 0) * sc, 75 * sc, { cls: 'pcc', tip: `PCC M10 levelling bed 75 mm\nBearing pressure ${d.qGross.toFixed(1)} kPa ≤ SBC ${d.sbc} kPa`, hl: 'pcc' });
    const wtip = `RCC ${d.grade} wall ${d.tw} mm · cantilever from base\nService moment at base ${d.MsSoil.toFixed(2)} kNm/m (earth + surcharge)`;
    s += rect(x0, yTop, d.tw * sc, d.H * 1000 * sc, { cls: 'conc-flat', tip: wtip, hl: 'wall' });
    s += rect(xi1, yTop, d.tw * sc, d.H * 1000 * sc, { cls: 'conc-flat', tip: wtip, hl: 'wall' });
    const toe = (d.toe || 0) * sc;
    s += rect(x0 - toe, yBt, x1 - x0 + 2 * toe, d.tb * sc, { cls: 'conc-flat', tip: `RCC ${d.grade} base slab ${d.tb} mm${d.toe ? `, toe ${d.toe} mm each side` : ''}`, hl: 'bot' });
    s += path(P([[x0, yTop], [x0, yBb], [x1, yBb], [x1, yTop], [xi1, yTop], [xi1, yBt], [xi0, yBt], [xi0, yTop]]) + ' Z', { cls: 'outline' });
    s += rect(xi0, yTop, xi1 - xi0, d.H * 1000 * sc, { cls: 'void' });
    const wl = yBt - d.H * 1000 * sc * 0.75;
    s += rect(xi0, wl, xi1 - xi0, yBt - wl, { cls: 'water', tip: `Drain running full — governs inner-face steel (${d.MsW.toFixed(2)} kNm/m)`, hl: 'inner' });
    s += line(xi0, wl, xi1, wl, { cls: 'wl' });
    if (d.cov) {
      s += rect(xi0 - 150 * sc, MT, d.B * 1000 * sc + 300 * sc, coverD * sc, { cls: 'conc-pc', tip: `Precast cover slab ${d.cov.D} mm ${d.cov.grade}\n${d.unitWidth} m wide units · main ${bs(d.cov.xb)}`, hl: 'cover' });
      const cy = MT + coverD * sc - (d.cov.cover + d.cov.xb.dia / 2) * sc;
      s += bar([[xi0 - 120 * sc, cy], [xi1 + 120 * sc, cy]], { tip: `Cover slab main bars: ${bs(d.cov.xb)}`, hl: 'cover' }, d.cov.xb.dia * sc);
      s += dots(xi0 - 115 * sc, xi1 + 115 * sc, cy - (d.cov.xb.dia / 2 + d.cov.yb.dia / 2) * sc, d.cov.yb.spacing * sc, clamp(d.cov.yb.dia / 2 * sc, 1.5, 5), { tip: `Cover slab distribution: ${bs(d.cov.yb)}`, hl: 'cover' });
      if (d.P > 0) s += group(circ((xi0 + xi1) / 2, MT - 24, 13, { cls: 'tyre' }) + arrowDown((xi0 + xi1) / 2, 4, MT - 38) + text((xi0 + xi1) / 2 + 20, MT - 30, `${d.P} kN × ${d.impact}`, { cls: 'load-t' }),
        { tip: `Wheel ${d.P} kN × impact ${d.impact} on one cover unit`, hl: 'cover' });
    }
    if (d.surch > 0) {
      let a = '';
      for (const xs of [ML + 20, ML + soilM * sc * 0.55, x1 + soilM * sc * 0.4, x1 + soilM * sc * 0.85]) a += arrowDown(xs, yTop - 30, yTop - 1);
      s += group(a + text(ML + 4, yTop - 36, `surcharge ${d.surch.toFixed(1)} kPa`, { cls: 'load-t' }), { tip: `Surcharge ${d.surch.toFixed(1)} kPa beside drain`, hl: 'soil' });
    }
    // bars (true diameters)
    const cs = d.cover * sc, cb = d.coverBase * sc;
    const items = [];
    for (const side of [0, 1]) {
      const mir = x => side ? (x0 + x1) - x : x;
      const xs = x0 + cs + d.soil.dia / 2 * sc, xin = xi0 - cs - d.inner.dia / 2 * sc;
      const yBotBar = yBb - cb - d.bot.dia / 2 * sc;
      s += bar([[mir(xs), yTop + cs], [mir(xs), yBotBar], [mir(xs + 50 * d.soil.dia * sc), yBotBar]],
        { tip: `Wall vertical, soil face: ${bs(d.soil)}\n${ast(d.soil)} · tension face for earth pressure\nL-bar lapped into base bottom`, hl: 'soil' }, d.soil.dia * sc);
      s += bar([[mir(xin), yTop + cs], [mir(xin), yBb - cb - d.bot.dia * sc - 6], [mir(xin - 6), yBb - cb - d.bot.dia * sc - 6]],
        { tip: `Wall vertical, inner face: ${bs(d.inner)}\n${ast(d.inner)} · drain-full case`, hl: 'inner' }, d.inner.dia * sc);
      const r = clamp(d.horiz.dia / 2 * sc, 1.3, 4);
      let hz = '';
      const step = Math.max(d.horiz.spacing * sc, 2 * r + 2.5);
      for (let y = yTop + cs + 10; y < yBt - 4; y += step) {
        hz += circ(mir(xs + (d.soil.dia / 2 + d.horiz.dia / 2) * sc), y, r, { cls: 'dot' });
        hz += circ(mir(xin - (d.inner.dia / 2 + d.horiz.dia / 2) * sc), y, r, { cls: 'dot' });
      }
      s += group(hz, { tip: `Wall horizontal bars, each face: ${bs(d.horiz)}`, hl: 'horiz', layer: 'rebar' });
      if (side) items.push({ y: yTop + (yBt - yTop) * 0.35, x: mir(xs), text: `${bshort(d.soil)} soil face`, hl: 'soil' },
        { y: yTop + (yBt - yTop) * 0.55, x: mir(xin), text: `${bshort(d.inner)} inner face`, hl: 'inner' },
        { y: yTop + (yBt - yTop) * 0.75, x: mir(xin) + 6, text: `${bshort(d.horiz)} horiz.`, hl: 'horiz' });
    }
    const yb = yBb - cb - d.bot.dia / 2 * sc, yt = yBt + cs + d.top.dia / 2 * sc;
    s += bar([[x0 + cs, yb], [x1 - cs, yb]], { tip: `Base bottom (transverse): ${bs(d.bot)}\nResists wall fixing moment`, hl: 'bot' }, d.bot.dia * sc);
    s += bar([[x0 + cs, yt], [x1 - cs, yt]], { tip: `Base top (transverse): ${bs(d.top)}\nSoil reaction / water pressure`, hl: 'top' }, d.top.dia * sc);
    s += dots(x0 + cs + 8, x1 - cs - 8, yb - (d.bot.dia / 2 + d.dist.dia / 2) * sc, d.dist.spacing * sc, clamp(d.dist.dia / 2 * sc, 1.3, 4), { tip: `Base longitudinal bars, each face: ${bs(d.dist)}`, hl: 'dist' });
    s += dots(x0 + cs + 8, x1 - cs - 8, yt + (d.top.dia / 2 + d.dist.dia / 2) * sc, d.dist.spacing * sc, clamp(d.dist.dia / 2 * sc, 1.3, 4), { tip: `Base longitudinal bars, each face: ${bs(d.dist)}`, hl: 'dist' });
    items.push({ y: yb, x: x1 - cs, text: `${bshort(d.bot)} base bottom`, hl: 'bot' }, { y: yt, x: x1 - cs, text: `${bshort(d.top)} base top`, hl: 'top' });
    if (d.cov) items.push({ y: MT + coverD * sc / 2, x: xi1 + 100 * sc, text: `cover ${d.cov.D} · ${bshort(d.cov.xb)}`, hl: 'cover' });
    // dims (left)
    s += dimV(ML - 16, yTop, yBt, `${d.H} m`, 'left');
    s += dimV(ML - 16, yBt, yBb, `${d.tb}`, 'left');
    if (d.cov) s += dimV(ML - 16, MT, yTop, `${d.cov.D}`, 'left');
    s += dimH(xi0, xi1, yP + 22, `${d.B} m`, false);
    s += dimH(x0, xi0, yP + 22, `${d.tw}`, false);
    s += callouts(items, x1, ML + sW + 64);
    const H = yP + 180 * sc + 30;
    s += scaleNote(W - 8, H - 4, 1);
    return { svg: s, h: Math.max(H, yP + 50) };
  }
  function drainPressure(d) {
    const MT = 60, Hpx = 300, sH = Hpx / (d.Hw * 1000);
    const wx = 330, tw = Math.max(d.tw * sH, 12);
    const pS = d.K0 * d.gamma * d.Hw, pQ = d.K0 * d.surch, pW = 9.81 * d.Hw;
    const kp = 220 / Math.max(pS + pQ, pW, 1);
    const yB = MT + Hpx;
    let s = text(40, 22, 'Earth & water pressure on wall (per metre run)', { cls: 'ttl' });
    s += rect(wx, MT, tw, Hpx, { cls: 'conc-flat', tip: `Wall ${d.tw} mm, height to base ${d.Hw.toFixed(2)} m`, hl: 'wall' });
    s += rect(wx - 140, yB, tw + 380, 22, { cls: 'conc-flat', tip: 'Base slab — wall is fixed here (cantilever)', hl: 'bot' });
    const xf = wx + tw;
    // soil side (right): surcharge rectangle + triangle
    if (pQ > 0) s += rect(xf, MT, pQ * kp, Hpx, { cls: 'press-q', tip: `Surcharge pressure K₀·q = ${d.K0.toFixed(2)} × ${d.surch.toFixed(1)} = ${pQ.toFixed(1)} kPa (uniform)\nResultant ${(pQ * d.Hw).toFixed(2)} kN/m at mid-height`, hl: 'soil' });
    s += path(P([[xf + pQ * kp, MT], [xf + (pQ + pS) * kp, yB], [xf + pQ * kp, yB]]) + ' Z',
      { cls: 'press-s', tip: `Earth pressure K₀·γ·H = ${d.K0.toFixed(2)} × ${d.gamma} × ${d.Hw.toFixed(2)} = ${pS.toFixed(1)} kPa at base\nResultant ${(0.5 * pS * d.Hw).toFixed(2)} kN/m at H/3`, hl: 'soil' });
    let ar = '';
    for (let i = 1; i <= 6; i++) { const y = MT + Hpx * i / 7; const pw = pQ + pS * (i / 7); ar += arrowH(xf + pw * kp - 2, xf + 2, y); }
    s += group(ar, { layer: 'labels' });
    s += text(xf + 8, yB + 40, `K₀γH = ${pS.toFixed(1)} kPa${pQ > 0 ? ` + K₀q = ${pQ.toFixed(1)} kPa` : ''}`, { cls: 'lbl' });
    // water side (left)
    s += path(P([[wx, MT], [wx - pW * kp, yB], [wx, yB]]) + ' Z', { cls: 'press-w', tip: `Water pressure, drain full: γw·H = ${pW.toFixed(1)} kPa at base\nService moment ${d.MsW.toFixed(2)} kNm/m (inner face)`, hl: 'inner' });
    s += text(wx - 8, yB + 40, `γwH = ${pW.toFixed(1)} kPa (drain full)`, { cls: 'lbl', anchor: 'end' });
    s += text(wx - 10, MT + 16, 'drain side', { cls: 'note', anchor: 'end' });
    s += text(xf + 10, MT + 16, 'soil side', { cls: 'note' });
    s += group(text(W - 20, MT + 60, `M (soil) = ${d.MsSoil.toFixed(2)} kNm/m`, { cls: 'lbl-b', anchor: 'end' }) +
      text(W - 20, MT + 80, `Mu = 1.5 M = ${(1.5 * d.MsSoil).toFixed(2)} kNm/m`, { cls: 'lbl', anchor: 'end' }) +
      text(W - 20, MT + 104, `M (water) = ${d.MsW.toFixed(2)} kNm/m`, { cls: 'lbl', anchor: 'end' }),
      { tip: 'Moments at the wall base — design the soil-face and inner-face vertical steel', hl: 'soil' });
    s += dimV(wx - 160, MT, yB, `H = ${d.Hw.toFixed(2)} m`, 'left');
    return { svg: s, h: yB + 64 };
  }
  function drainCover(d, o) {
    return slabSection({
      title: `Cover slab · section across span (unit ${d.unitWidth} m wide)`, clear: d.B * 1000, wall: Math.min(d.tw, 150), D: d.cov.D, cover: d.cov.cover,
      grade: d.cov.grade, fill: 0, steel: d.steel, precast: true, P: d.P, impact: d.impact, along: d.along, q: 0, below: 'drain',
      wallTip: `Bearing on drain wall (${d.tw} mm wall)`, wallHl: 'wall',
      main: d.cov.xb, cross: d.cov.yb, mainOuter: true, mainHl: 'cover', crossHl: 'cover', mainName: 'Cover slab main bars', crossName: 'Cover slab distribution bars', mainLabel: 'main', crossLabel: 'dist.',
    }, o);
  }

  // ═════════════ ROAD ═════════════
  function roadLayers(d, x0, x1, sy, opts = {}) {
    const list = [{ cls: 'conc', t: d.h, label: `PQC ${d.h} mm ${d.grade}`, bold: true, hl: 'pqc', tip: `Pavement quality concrete ${d.h} mm ${d.grade}\nFlexural strength 0.7√fck · ${d.kind}` }];
    if (d.dlc) list.push({ cls: 'dlc', t: d.dlc, label: `DLC ${d.dlc} mm`, hl: 'subbase', tip: `Dry lean concrete ${d.dlc} mm (7-day ≥ 7 MPa)`, x0: opts.dlc0, x1: opts.dlc1 });
    list.push({ cls: 'gsb', t: d.gsb, label: `GSB ${d.gsb} mm`, hl: 'subbase', tip: `Granular sub-base ${d.gsb} mm — drainage layer\nEffective k on top of sub-base ≈ ${Math.round(d.k)} MPa/m`, x0: opts.gsb0, x1: opts.gsb1 });
    list.push({ cls: 'soil', t: 500, min: 26, label: `Subgrade CBR ${d.cbr}%`, hl: 'subgrade', tip: `Subgrade: soaked CBR ${d.cbr}%\nTop 500 mm compacted to ≥ 97% MDD (IS 2720-8)`, x0: opts.sg0, x1: opts.sg1 });
    return list;
  }
  function roadCross(d, o) {
    const ML = 30, MR = 210, sh = 800;
    const widthMM = d.roadWidth * 1000 + 2 * sh;
    const sx = (W - ML - MR) / widthMM;
    const ex = o.ex ? clamp(75 / (d.h * sx), 1, 40) : 1, sy = sx * ex;
    const xs = ML + sh * sx, xe = xs + d.roadWidth * 1000 * sx, y0 = 92;
    const list = roadLayers(d, xs, xe, sy, { dlc0: xs - 300 * sx, dlc1: xe + 300 * sx, gsb0: xs - 600 * sx, gsb1: xe + 600 * sx, sg0: ML, sg1: ML + widthMM * sx });
    let s = text(ML, 22, 'Cross-section · across carriageway', { cls: 'ttl' });
    const pqcH = d.h * sy + (d.dlc ? d.dlc * sy : 0);
    s += rect(ML, y0, xs - ML - (d.dlc ? 300 * sx : 0), pqcH, { cls: 'soil', tip: 'Earthen shoulder', hl: 'subgrade' });
    s += rect(xe + (d.dlc ? 300 * sx : 0), y0, ML + widthMM * sx - xe - (d.dlc ? 300 * sx : 0), pqcH, { cls: 'soil', tip: 'Earthen shoulder', hl: 'subgrade' });
    const L = layerStack(list, xs, xe, y0, sy);
    s += L.svg;
    const pq = list[0];
    s += line(xs, pq.y + pq.h, xe, pq.y + pq.h, { cls: 'mem', tip: '125 µm polythene separation membrane', hl: 'membrane' });
    for (let i = 1; i < d.nL; i++) {
      const xj = xs + i * d.laneWidth * 1000 * sx;
      s += group(line(xj, pq.y, xj, pq.y + pq.h / 3, { cls: 'saw' }) + line(xj, pq.y + pq.h / 3, xj, pq.y + pq.h, { cls: 'crack' }),
        { tip: 'Longitudinal joint: sawn to h/3, tied (no movement)', hl: 'joint' });
      if (d.tie) s += bar([[xj - d.tie.len / 2 * sx, pq.y + pq.h / 2], [xj + d.tie.len / 2 * sx, pq.y + pq.h / 2]],
        { cls: 'tie', tip: `Tie bar: ${d.tie.dia} mm TMT × ${d.tie.len} mm @ ${d.tie.spacing} mm\nAt mid-depth across longitudinal joint`, hl: 'tie' }, Math.max(d.tie.dia * sy, 3));
    }
    if (d.mesh && d.meshBars) {
      for (let i = 0; i < d.nL; i++) {
        const a = xs + i * d.laneWidth * 1000 * sx + 50 * sx + 3, b = xs + (i + 1) * d.laneWidth * 1000 * sx - 50 * sx - 3;
        s += bar([[a, pq.y + pq.h / 3], [b, pq.y + pq.h / 3]], { cls: 'rebar mesh', tip: `JRCP mesh (upper third): ${bs(d.meshBars.L)} longitudinal, ${bs(d.meshBars.T)} transverse`, hl: 'mesh' }, 2);
      }
    }
    for (let i = 0; i < d.nL; i++) {
      const xc = xs + (i + 0.5) * d.laneWidth * 1000 * sx;
      s += text(xc, y0 - 48, `Lane ${i + 1} · ${d.laneWidth} m`, { cls: 'note', anchor: 'middle' });
    }
    // heaviest axle at the free edge of lane 1
    const w1 = xs + 300 * sx, w2 = w1 + 1800 * sx;
    s += group(circ(w1, y0 - 16, 11, { cls: 'tyre' }) + circ(w2, y0 - 16, 11, { cls: 'tyre' }) + line(w1, y0 - 16, w2, y0 - 16, { cls: 'axle' }) +
      text(w2 + 16, y0 - 12, `${d.axle} kN axle at free edge`, { cls: 'load-t' }),
      { tip: `Heaviest axle ${d.axle} kN (two wheels of ${d.axle / 2} kN) at the free edge\nEdge loading governs (Westergaard)`, hl: 'pqc' });
    s += callouts(L.items.map(it => ({ ...it, x: ML + widthMM * sx - 4 })), ML + widthMM * sx, ML + widthMM * sx + 50);
    s += dimH(xs, xe, L.bottom + 18, `${d.roadWidth} m carriageway`, false);
    const H = L.bottom + 46;
    s += scaleNote(W - 8, H - 4, ex);
    return { svg: s, h: H };
  }
  function roadLong(d, o) {
    const ML = 30, MR = 210, panels = 3, Jmm = d.joint * 1000, Lmm = panels * Jmm;
    const sx = (W - ML - MR) / Lmm;
    const ex = o.ex ? clamp(75 / (d.h * sx), 1, 60) : 1, sy = sx * ex;
    const x0 = ML, x1 = ML + Lmm * sx, y0 = 64;
    const list = roadLayers(d, x0, x1, sy);
    const L = layerStack(list, x0, x1, y0, sy);
    let s = text(ML, 22, `Longitudinal section · ${d.kind}, joints @ ${d.joint} m`, { cls: 'ttl' }) + L.svg;
    const pq = list[0];
    s += line(x0, pq.y + pq.h, x1, pq.y + pq.h, { cls: 'mem', tip: '125 µm polythene separation membrane', hl: 'membrane' });
    for (let i = 1; i < panels; i++) {
      const xj = x0 + i * Jmm * sx;
      s += group(line(xj, pq.y, xj, pq.y + pq.h / 4, { cls: 'saw' }) + line(xj, pq.y + pq.h / 4, xj, pq.y + pq.h, { cls: 'crack' }),
        { tip: `Transverse contraction joint every ${d.joint} m\nSawn to h/4 within 24 h, sealed`, hl: 'joint' });
      if (d.dw) {
        const len = d.dw.len * sx, th = Math.max(d.dw.dia * sy, 3.5), ym = pq.y + pq.h / 2;
        s += group(rect(xj - len / 2, ym - th / 2, len, th, { cls: 'dowel' }) + rect(xj, ym - th / 2, len / 2, th, { cls: 'debond' }),
          { tip: `Dowel bar: ${d.dw.dia} mm plain MS × ${d.dw.len} mm @ ${d.dw.spacing} mm\nHalf debonded so the joint can open`, hl: 'dowel', layer: 'rebar' });
      }
    }
    if (d.mesh && d.meshBars) {
      for (let i = 0; i < panels; i++) {
        const a = x0 + i * Jmm * sx + 50 * sx + 3, b = x0 + (i + 1) * Jmm * sx - 50 * sx - 3;
        s += bar([[a, pq.y + pq.h / 3], [b, pq.y + pq.h / 3]], { cls: 'rebar mesh', tip: `JRCP mesh: ${bs(d.meshBars.L)} longitudinal (stops 50 mm short of joints)`, hl: 'mesh' }, 2);
      }
    }
    s += path(`M${f(x0)},${f(y0 - 4)} l-5,8 l10,6 l-5,8`, { cls: 'brk' }) + path(`M${f(x1)},${f(y0 - 4)} l-5,8 l10,6 l-5,8`, { cls: 'brk' });
    s += callouts(L.items.map(it => ({ ...it, x: x1 - 4 })), x1, x1 + 50);
    for (let i = 0; i < panels; i++) s += dimH(x0 + i * Jmm * sx, x0 + (i + 1) * Jmm * sx, L.bottom + 18, `${d.joint} m`, false);
    s += text((x0 + x1) / 2, y0 - 26, 'traffic →', { cls: 'note', anchor: 'middle' });
    const H = L.bottom + 46;
    s += scaleNote(W - 8, H - 4, ex);
    return { svg: s, h: H };
  }
  function roadJoint(d) {
    const ML = 50, MR = 210, win = 1000, sc = (W - ML - MR) / win;
    const y0 = 60, hp = d.h * sc, xR = ML + win * sc, xc = ML + win / 2 * sc;
    let s = text(ML, 22, 'Transverse joint detail · true scale', { cls: 'ttl' });
    s += rect(ML, y0, win * sc, hp, { cls: 'conc', tip: `PQC ${d.h} mm ${d.grade}`, hl: 'pqc' });
    let y = y0 + hp;
    if (d.dlc) { s += rect(ML, y, win * sc, d.dlc * sc, { cls: 'dlc', tip: `DLC ${d.dlc} mm`, hl: 'subbase' }); y += d.dlc * sc; }
    const g = Math.min(d.gsb, 120) * sc;
    s += rect(ML, y, win * sc, g, { cls: 'gsb', tip: `GSB ${d.gsb} mm (part shown)`, hl: 'subbase' });
    s += line(ML, y0 + hp, xR, y0 + hp, { cls: 'mem', tip: 'Separation membrane', hl: 'membrane' });
    const dep = d.h / 4 * sc;
    s += group(rect(xc - 2.5 * sc - 1, y0, 5 * sc + 2, dep, { cls: 'saw-fill' }) + rect(xc - 5 * sc - 1, y0, 10 * sc + 2, 25 * sc, { cls: 'seal' }),
      { tip: `Saw cut 3–5 mm wide × h/4 = ${Math.round(d.h / 4)} mm deep\nSealing groove 10 × 25 mm with polysulphide / PU sealant`, hl: 'joint' });
    s += path(`M${f(xc)},${f(y0 + dep)} l3,${f(hp * 0.12)} l-4,${f(hp * 0.14)} l3,${f(hp * 0.16)} l-3,${f(hp * 0.12)} l2,${f(hp - dep - hp * 0.54)}`, { cls: 'crack', tip: 'Induced crack below saw cut', hl: 'joint' });
    const items = [{ y: y0 + 12, x: xc + 6, text: `saw cut ${Math.round(d.h / 4)} mm`, hl: 'joint' }];
    if (d.dw) {
      const len = d.dw.len * sc, th = d.dw.dia * sc, ym = y0 + hp / 2;
      s += group(rect(xc - len / 2, ym - th / 2, len, th, { cls: 'dowel' }) + rect(xc, ym - th / 2, len / 2, th, { cls: 'debond' }),
        { tip: `Dowel: ${d.dw.dia} mm plain mild steel × ${d.dw.len} mm @ ${d.dw.spacing} mm c/c\nRight half debonded (bitumen/PVC sleeve) · at mid-depth`, hl: 'dowel', layer: 'rebar' });
      items.push({ y: ym, x: xc + len / 2, text: `${d.dw.dia} Ø × ${d.dw.len} dowel`, hl: 'dowel' });
      s += dimH(xc - len / 2, xc + len / 2, y0 + hp + (d.dlc ? d.dlc * sc : 0) + g + 18, `${d.dw.len} mm`, false);
    } else {
      items.push({ y: y0 + hp / 2, x: xc + 6, text: 'no dowels: aggregate interlock (h < 200)', hl: 'joint' });
    }
    if (d.mesh && d.meshBars) {
      const ym = y0 + hp / 3;
      s += bar([[ML + 4, ym], [xc - 50 * sc, ym]], { cls: 'rebar', tip: `JRCP mesh ${bs(d.meshBars.L)} — stops 50 mm short of joint`, hl: 'mesh' }, d.meshBars.L.dia * sc);
      s += bar([[xc + 50 * sc, ym], [xR - 4, ym]], { cls: 'rebar', tip: `JRCP mesh ${bs(d.meshBars.L)}`, hl: 'mesh' }, d.meshBars.L.dia * sc);
      items.push({ y: ym, x: xR - 6, text: `mesh ${bshort(d.meshBars.L)}`, hl: 'mesh' });
    }
    s += dimV(xR + 12, y0, y0 + hp, `${d.h} mm`);
    s += callouts(items, xR, xR + 80);
    const H = y0 + hp + (d.dlc ? d.dlc * sc : 0) + g + 44;
    s += scaleNote(W - 8, H - 4, 1);
    return { svg: s, h: H };
  }
  function roadPlan(d) {
    const ML = 40, MR = 40, MT = 56, panels = 3, Lmm = panels * d.joint * 1000, Wmm = d.roadWidth * 1000;
    const sc = Math.min((W - ML - MR) / Lmm, 260 / Wmm);
    const x0 = ML, y0 = MT, w = Lmm * sc, h = Wmm * sc;
    let s = text(ML, 22, `Plan · ${panels} panels × ${d.nL} lane${d.nL > 1 ? 's' : ''}`, { cls: 'ttl' });
    s += rect(x0, y0, w, h, { cls: 'conc-plan', tip: `PQC ${d.h} mm ${d.grade} · panels ${d.joint} × ${d.laneWidth} m`, hl: 'pqc' });
    if (d.mesh) s += rect(x0 + 2, y0 + 2, w - 4, h - 4, { cls: 'topmesh', tip: d.meshBars ? `JRCP mesh ${bs(d.meshBars.L)} / ${bs(d.meshBars.T)}` : 'Mesh', hl: 'mesh', layer: 'rebar' });
    let jt = '';
    for (let i = 1; i < panels; i++) jt += line(x0 + i * d.joint * 1000 * sc, y0, x0 + i * d.joint * 1000 * sc, y0 + h, { cls: 'joint-l' });
    s += group(jt, { tip: `Transverse contraction joints @ ${d.joint} m`, hl: 'joint' });
    let lj = '';
    for (let i = 1; i < d.nL; i++) lj += line(x0, y0 + i * d.laneWidth * 1000 * sc, x0 + w, y0 + i * d.laneWidth * 1000 * sc, { cls: 'joint-l' });
    if (lj) s += group(lj, { tip: 'Longitudinal (tied) joint between lanes', hl: 'joint' });
    if (d.dw) {
      let e = 1; while (d.dw.spacing * sc * e < 5) e++;
      let dw = '';
      for (let i = 1; i < panels; i++) {
        const xj = x0 + i * d.joint * 1000 * sc;
        for (let y = 150; y < Wmm; y += d.dw.spacing * e) dw += line(xj - d.dw.len / 2 * sc, y0 + y * sc, xj + d.dw.len / 2 * sc, y0 + y * sc, { cls: 'dowel-l' });
      }
      s += group(dw, { tip: `Dowels ${bs({ dia: d.dw.dia, spacing: d.dw.spacing })} across transverse joints, parallel to traffic${e > 1 ? `\n(every ${e}th drawn)` : ''}`, hl: 'dowel', layer: 'rebar' });
    }
    if (d.tie) {
      let e = 1; while (d.tie.spacing * sc * e < 5) e++;
      let t = '';
      for (let i = 1; i < d.nL; i++) {
        const yj = y0 + i * d.laneWidth * 1000 * sc;
        for (let x = d.tie.spacing / 2; x < Lmm; x += d.tie.spacing * e) t += line(x0 + x * sc, yj - d.tie.len / 2 * sc, x0 + x * sc, yj + d.tie.len / 2 * sc, { cls: 'tie-l' });
      }
      s += group(t, { tip: `Tie bars ${d.tie.dia} mm TMT × ${d.tie.len} @ ${d.tie.spacing} across longitudinal joint${e > 1 ? `\n(every ${e}th drawn)` : ''}`, hl: 'tie', layer: 'rebar' });
    }
    s += dimH(x0, x0 + d.joint * 1000 * sc, y0 - 10, `${d.joint} m`);
    s += dimV(x0 + w + 12, y0, y0 + h, `${d.roadWidth} m`);
    s += text(x0 + w / 2, y0 + h + 22, 'traffic →', { cls: 'note', anchor: 'middle' });
    return { svg: s, h: y0 + h + 40 };
  }

  // ═════════════ FLOOR ═════════════
  function floorLayers(d) {
    const reinf = d.opt.type === 'mesh' ? `TMT mesh ${d.opt.dia} @ ${d.opt.spacing}` : d.opt.type === 'fibre' ? `fibre ${d.opt.dose} kg/m³` : `fibre ${d.opt.dose} kg/m³ + mesh`;
    const list = [{ cls: 'conc', t: d.h, label: `Slab ${d.h} mm ${d.grade}`, bold: true, hl: 'slab', tip: `Ground-bearing slab ${d.h} mm ${d.grade}\n${reinf}` }];
    if (d.dlc) list.push({ cls: 'dlc', t: d.dlc, label: `DLC ${d.dlc} mm`, hl: 'subbase', tip: `Dry lean concrete ${d.dlc} mm` });
    if (d.wmm) list.push({ cls: 'wmm', t: d.wmm, label: `WMM ${d.wmm} mm`, hl: 'subbase', tip: `Wet mix macadam ${d.wmm} mm` });
    list.push({ cls: 'gsb', t: d.gsb, label: `GSB ${d.gsb} mm`, hl: 'subbase', tip: `Granular sub-base ${d.gsb} mm · effective k ≈ ${Math.round(d.k)} MPa/m` });
    list.push({ cls: 'soil', t: 400, min: 24, label: 'Subgrade ≥ 97% MDD', hl: 'subgrade', tip: 'Subgrade: top 500 mm ≥ 97% MDD; verify k by plate-load test (IS 1888)' });
    return list;
  }
  function floorSection(d, o) {
    const ML = 30, MR = 200, Lmm = 2 * d.S * 1000;
    const sx = (W - ML - MR) / Lmm;
    const ex = o.ex ? clamp(80 / (d.h * sx), 1, 40) : 1, sy = sx * ex;
    const x0 = ML, x1 = ML + Lmm * sx, y0 = 110;
    const list = floorLayers(d);
    const L = layerStack(list, x0, x1, y0, sy);
    let s = text(ML, 22, `Section · two ${d.S} m panels`, { cls: 'ttl' }) + L.svg;
    const sl = list[0];
    if (d.membrane) s += line(x0, sl.y + sl.h, x1, sl.y + sl.h, { cls: 'mem', tip: 'Slip membrane 2 × 125 µm polythene — reduces restraint', hl: 'subbase' });
    if (d.opt.type !== 'fibre') {
      const yb = sl.y + sl.h - 40 * sy - d.opt.dia / 2 * sy;
      s += bar([[x0 + 4, yb], [x1 - 4, yb]], { tip: `Bottom mesh: ${d.opt.dia} mm @ ${d.opt.spacing} both ways, 40 mm cover\nProvides sagging capacity Mp (TR34)`, hl: 'mesh' }, Math.max(d.opt.dia * sy, 2));
    }
    if (d.topMesh) {
      const yt = sl.y + 40 * sy;
      s += bar([[x0 + 4, yt], [x1 - 4, yt]], { cls: 'rebar-top', tip: 'Top crack-control mesh 8 mm @ 200 both ways', hl: 'topmesh' }, Math.max(8 * sy, 1.6));
    }
    if (d.opt.type !== 'mesh') {
      let fs = '';
      for (let i = 0; i < 140; i++) { const x = x0 + 6 + ((i * 41.7) % (x1 - x0 - 12)), y = sl.y + 4 + ((i * 13.3) % Math.max(sl.h - 8, 4)); fs += line(x, y, x + 4, y + 1.5, { cls: 'fibre' }); }
      s += group(fs, { tip: `Steel fibre ${d.opt.dose} kg/m³ (hooked-end)`, hl: 'mesh', layer: 'rebar' });
    }
    const xj = x0 + d.S * 1000 * sx;
    s += group(line(xj, sl.y, xj, sl.y + sl.h / 4, { cls: 'saw' }) + line(xj, sl.y + sl.h / 4, xj, sl.y + sl.h, { cls: 'crack' }),
      { tip: `Sawn joint @ ${d.S} m grid, depth h/4 = ${Math.round(d.h / 4)} mm`, hl: 'joint' });
    // loads
    if (d.post) {
      const px = x0 + d.S * 1000 * sx * 0.35, pw = Math.max(d.plate * sx, 10), gap = Math.max(d.x * sx, 14);
      let r = '';
      for (const xx of [px, px + gap + pw]) r += rect(xx, sl.y - 4, pw, 4, { cls: 'plate' }) + rect(xx + pw / 2 - 3, sl.y - 70, 6, 66, { cls: 'upright' });
      r += arrowDown(px + pw / 2, 30, sl.y - 74) + arrowDown(px + gap + pw * 1.5, 30, sl.y - 74);
      r += text(px + gap + pw * 2 + 10, 44, `${d.postLoad} kN per post`, { cls: 'load-t' });
      s += group(r, { tip: `Back-to-back rack posts ${d.postLoad} kN each\nBaseplate ${d.plate} × ${d.plate} mm, ${d.x} mm apart`, hl: 'rack' });
    } else {
      s += group(rect(x0 + 30, sl.y - 50, d.S * 1000 * sx * 0.6, 50, { cls: 'stack' }) + text(x0 + 36, sl.y - 58, `${d.udl} kPa block stacking`, { cls: 'load-t' }),
        { tip: `Storage UDL ${d.udl} kPa (e.g. cement bags)`, hl: 'slab' });
    }
    if (d.wheel > 0) {
      const wx = xj + 14;
      s += group(circ(wx, sl.y - 16, 16, { cls: 'tyre' }) + arrowDown(wx, 46, sl.y - 34) + text(wx + 22, 60, `${d.wheel} kN MHE wheel (${d.tyre})`, { cls: 'load-t' }),
        { tip: `Forklift / MHE wheel ${d.wheel} kN, ${d.tyre} tyre\nChecked internal and crossing the sawn joint`, hl: 'mhe' });
    }
    s += callouts(L.items.map(it => ({ ...it, x: x1 - 4 })), x1, x1 + 50);
    s += dimH(x0, xj, L.bottom + 18, `${d.S} m`, false) + dimH(xj, x1, L.bottom + 18, `${d.S} m`, false);
    const H = L.bottom + 46;
    s += scaleNote(W - 8, H - 4, ex);
    return { svg: s, h: H };
  }
  function floorStrip(d) {
    const mesh = d.opt.type !== 'fibre' ? { dia: d.opt.dia, spacing: d.opt.spacing, ast: Math.PI * d.opt.dia ** 2 / 4 * 1000 / d.opt.spacing } : null;
    const top = d.topMesh ? { dia: 8, spacing: 200, ast: Math.PI * 64 / 4 * 1000 / 200 } : null;
    return strip({
      title: 'Detail · 1 m strip at a sawn joint (true scale)', D: d.h, cover: 40, below: 'gsb', belowTip: 'Sub-base', belowHl: 'subbase',
      slabTip: `Slab ${d.h} mm ${d.grade}`, fibre: d.opt.type !== 'mesh', fibreTip: d.opt.dose ? `Steel fibre ${d.opt.dose} kg/m³` : '', sawcut: true,
      bOuter: mesh, bInner: mesh, hlBO: 'mesh', hlBI: 'mesh', nameBO: 'Bottom mesh (transverse)', nameBI: 'Bottom mesh (longitudinal)',
      tOuter: top, tInner: top, hlTO: 'topmesh', hlTI: 'topmesh', nameTO: 'Top mesh', nameTI: 'Top mesh',
    });
  }
  function floorPlan(d) {
    const PW = 36, PH = 24, ps = Math.min((W - 80) / PW, 320 / PH), px = 40, py = 50;
    let s = text(px, 22, 'Plan · typical 36 × 24 m bay', { cls: 'ttl' });
    s += rect(px, py, PW * ps, PH * ps, { cls: 'conc-plan', tip: `Slab ${d.h} mm ${d.grade}`, hl: 'slab' });
    if (d.post) {
      const depth = 1.1, b2b = 0.3, pair = 2 * depth + b2b, aisle = Math.max(d.aisle, 1.5);
      let r = '';
      for (let y = 0.6; y + pair <= PH - 0.4; y += pair + aisle) {
        r += rect(px + 1.5 * ps, py + y * ps, (PW - 3) * ps, depth * ps, { cls: 'rack' }) + rect(px + 1.5 * ps, py + (y + depth + b2b) * ps, (PW - 3) * ps, depth * ps, { cls: 'rack' });
      }
      s += group(r, { tip: `Back-to-back racking, aisles ${aisle} m\nPosts ${d.postLoad} kN — keep ≥ 300 mm off sawn-joint intersections`, hl: 'rack' });
    } else {
      let r = '';
      for (let gx = 1.5; gx + 4 <= PW - 1; gx += 5.5) for (let gy = 1.5; gy + 3 <= PH - 1; gy += 5) r += rect(px + gx * ps, py + gy * ps, 4 * ps, 3 * ps, { cls: 'stack' });
      s += group(r, { tip: `Block stacks, ${d.udl} kPa`, hl: 'slab' });
    }
    let g = '';
    for (let x = d.S; x < PW - 0.01; x += d.S) g += line(px + x * ps, py, px + x * ps, py + PH * ps, { cls: 'grid-l' });
    for (let y = d.S; y < PH - 0.01; y += d.S) g += line(px, py + y * ps, px + PW * ps, py + y * ps, { cls: 'grid-l' });
    s += group(g, { tip: `Sawn joints on a ${d.S} m grid (≤ 30 h, ≤ 6 m)`, hl: 'joint' });
    s += rect(px, py, PW * ps, PH * ps, { cls: 'arm', tip: 'Armoured free-movement joints with plate dowels at bay edges (≈ 36 m)', hl: 'joint' });
    s += dimH(px, px + d.S * ps, py - 10, `${d.S} m`);
    const H = py + PH * ps + 44;
    s += text(px, H - 14, `dashed: sawn joints @ ${d.S} m · solid: armoured joints · ${d.post ? 'violet: racking' : 'grey: stacks'}`, { cls: 'note' });
    return { svg: s, h: H };
  }

  // ───── registry ─────
  const VIEWS = {
    tank: d => [
      { id: 'a', label: 'Section A–A', ex: true, fn: tankA },
      { id: 'b', label: 'Section B–B', ex: true, fn: tankB },
      { id: 'plan', label: 'Plan', fn: tankPlan },
      { id: 'detail', label: 'Bar detail', fn: tankStrip },
    ],
    drain: d => [
      { id: 'section', label: 'Cross-section', fn: drainSection },
      { id: 'pressure', label: 'Pressure diagram', fn: drainPressure },
      ...(d.cov ? [{ id: 'cover', label: 'Cover slab', ex: true, fn: drainCover }] : []),
    ],
    road: d => [
      { id: 'cross', label: 'Cross-section', ex: true, fn: roadCross },
      { id: 'long', label: 'Longitudinal', ex: true, fn: roadLong },
      { id: 'joint', label: 'Joint detail', fn: roadJoint },
      { id: 'plan', label: 'Plan', fn: roadPlan },
    ],
    floor: d => [
      { id: 'section', label: 'Section', ex: true, fn: floorSection },
      { id: 'detail', label: 'Joint detail', fn: floorStrip },
      { id: 'plan', label: 'Plan', fn: floorPlan },
    ],
  };
  const LEGEND = {
    tank: [['conc', 'Concrete'], ['soil', 'Fill'], ['water', 'Water'], ['sw-rebar', 'Bottom bars'], ['sw-top', 'Top bars'], ['sw-load', 'Load']],
    drain: [['conc', 'Concrete'], ['pcc', 'PCC'], ['soil', 'Soil'], ['water', 'Water'], ['sw-rebar', 'TMT bars'], ['sw-load', 'Load / pressure']],
    road: [['conc', 'PQC'], ['dlc', 'DLC'], ['gsb', 'GSB'], ['soil', 'Subgrade'], ['dowel', 'Dowel (MS)'], ['sw-tie', 'Tie bar (TMT)'], ['sw-rebar', 'Mesh']],
    floor: [['conc', 'Slab'], ['gsb', 'Sub-base'], ['soil', 'Subgrade'], ['sw-rebar', 'Bottom mesh'], ['sw-top', 'Top mesh'], ['rack', 'Racking'], ['sw-load', 'Load']],
  };

  function views(d) { return (VIEWS[d.type] || (() => []))(d).map(({ id, label, ex }) => ({ id, label, exaggerable: !!ex })); }
  function render(d, viewId, opts = {}) {
    const list = (VIEWS[d.type] || (() => []))(d);
    const v = list.find(x => x.id === viewId) || list[0];
    if (!v) return '';
    const r = v.fn(d, { ex: opts.ex !== false });
    return svgWrap(r.h, r.svg, v.label);
  }
  function legend(d) { return (LEGEND[d.type] || []).map(([cls, label]) => ({ cls, label })); }
  return { views, render, legend, W };
});
