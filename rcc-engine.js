/*
 * RCC Estimator engine — pure calculation functions, no DOM.
 *
 * Covers: slab over water tank (IS 456 + IS 3370), RCC drain (IS 456),
 * internal rigid road (IRC 58 / IRC SP:62, Westergaard + Bradbury),
 * warehouse ground-bearing floor (Concrete Society TR34, yield-line).
 *
 * Every design function runs a cost optimiser over thickness × concrete
 * grade × reinforcement and returns the cheapest arrangement that passes
 * all checks, plus the best alternative per grade / reinforcement type.
 *
 * Units inside the engine: kN, m, kPa (kN/m²), kNm/m for loads/moments;
 * N, mm, MPa for section checks. Preliminary estimation only — final
 * design to be verified by a licensed structural engineer.
 *
 * Loads in the browser as window.RCC, and in Node via require().
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RCC = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ───────────────────────────── helpers ─────────────────────────────
  function interp(xs, ys, x) {
    const n = xs.length;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    for (let i = 1; i < n; i++) {
      if (x <= xs[i]) {
        const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
        return ys[i - 1] + t * (ys[i] - ys[i - 1]);
      }
    }
    return ys[n - 1];
  }
  const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;
  const range = (a, b, step) => { const r = []; for (let v = a; v <= b + 1e-9; v += step) r.push(round(v, 6)); return r; };

  function check(name, demand, capacity, unit, ref, opts = {}) {
    const util = capacity > 0 ? demand / capacity : (demand > 0 ? Infinity : 0);
    return {
      name, demand: round(demand, 3), capacity: round(capacity, 3), unit, ref,
      util: round(util, 3), pass: util <= 1 + 1e-9, note: opts.note || '',
    };
  }

  // ───────────────────────────── materials ─────────────────────────────
  const GRADE_LIST = ['M20', 'M25', 'M30', 'M35', 'M40'];
  const fckOf = g => Number(String(g).replace('M', ''));

  // IS 1786 TMT grades. xu,max/d per IS 456 Cl 38.1 note: 700/(1100+0.87fy)
  const STEELS = {
    Fe415: { fy: 415, label: 'Fe 415' },
    Fe500: { fy: 500, label: 'Fe 500' },
    Fe500D: { fy: 500, label: 'Fe 500D' },
    Fe550D: { fy: 550, label: 'Fe 550D' },
  };
  const xuMaxRatio = fy => 700 / (1100 + 0.87 * fy);

  // IS 456 Table 3 / 5 / 16 — exposure → minimum RCC grade and nominal cover
  const EXPOSURE = {
    mild: { label: 'Mild', minGrade: 'M20', cover: 20 },
    moderate: { label: 'Moderate', minGrade: 'M25', cover: 30 },
    severe: { label: 'Severe', minGrade: 'M30', cover: 45 },
    verysevere: { label: 'Very severe', minGrade: 'M35', cover: 50 },
    extreme: { label: 'Extreme', minGrade: 'M40', cover: 75 },
  };

  // Permissible bending compressive stress (working stress) for modular ratio, IS 456 Annex B
  const SIGMA_CBC = { 20: 7, 25: 8.5, 30: 10, 35: 11.5, 40: 13 };

  const BAR_DIAS = [8, 10, 12, 16, 20, 25];
  const SPACINGS = [300, 275, 250, 225, 200, 175, 150, 125, 100]; // ≥ 100 mm for concreting
  const barArea = d => Math.PI * d * d / 4;
  const barKgPerM = d => d * d / 162;
  const astPerM = (d, s) => barArea(d) * 1000 / s;
  const kgPerM2 = ast => ast * 7.85e-3; // Ast in mm²/m, one direction → kg per m² of slab
  const barStr = b => b ? `${b.dia} mm @ ${b.spacing} c/c` : '—';

  const DEFAULT_RATES = {
    M20: 6000, M25: 6400, M30: 6800, M35: 7200, M40: 7600, // ₹/m³ RMC placed, compacted, finished
    steel: 72,          // ₹/kg TMT cut, bent and fixed
    msDowel: 80,        // ₹/kg plain MS dowel bars incl. sleeves/caps
    fibre: 120,         // ₹/kg steel fibre
    formwork: 480,      // ₹/m²
    gsb: 1500, wmm: 2000, dlc: 4800, pcc: 5200, // ₹/m³ compacted / placed
    subgrade: 60,       // ₹/m² subgrade preparation & compaction
    excavation: 350,    // ₹/m³
    sawcut: 220,        // ₹/m sawn joint incl. sealant
    armouredJoint: 4500,// ₹/m armoured free-movement joint
    membrane: 45,       // ₹/m² double-layer polythene slip membrane
    hardener: 150,      // ₹/m² dry-shake surface hardener
    lapPct: 8,          // % extra steel for laps, chairs and wastage
  };
  const RATE_LABELS = {
    M20: 'Concrete M20 (₹/m³)', M25: 'Concrete M25 (₹/m³)', M30: 'Concrete M30 (₹/m³)',
    M35: 'Concrete M35 (₹/m³)', M40: 'Concrete M40 (₹/m³)', steel: 'TMT steel fixed (₹/kg)',
    msDowel: 'MS dowel bars (₹/kg)', fibre: 'Steel fibre (₹/kg)', formwork: 'Formwork (₹/m²)',
    gsb: 'GSB (₹/m³)', wmm: 'WMM (₹/m³)', dlc: 'DLC (₹/m³)', pcc: 'PCC M10 (₹/m³)',
    subgrade: 'Subgrade prep (₹/m²)', excavation: 'Excavation (₹/m³)', sawcut: 'Sawn joint + sealant (₹/m)',
    armouredJoint: 'Armoured joint (₹/m)', membrane: 'Slip membrane (₹/m²)', hardener: 'Surface hardener (₹/m²)',
    lapPct: 'Laps & wastage (%)',
  };

  // ─────────────────────── IS 456 section design ───────────────────────
  function muLimit(fck, fy, b, d) { // N·mm
    const xu = xuMaxRatio(fy) * d;
    return 0.36 * fck * b * xu * (d - 0.42 * xu);
  }
  function astRequired(Mu, fck, fy, b, d) { // Mu N·mm → mm² (IS 456 Annex G)
    if (Mu <= 0) return 0;
    const r = 4.6 * Mu / (fck * b * d * d);
    if (r >= 1) return Infinity;
    return 0.5 * fck / fy * (1 - Math.sqrt(1 - r)) * b * d;
  }
  function muCapacity(ast, fck, fy, b, d) {
    const xu = 0.87 * fy * ast / (0.36 * fck * b);
    if (xu > xuMaxRatio(fy) * d) return muLimit(fck, fy, b, d);
    return 0.87 * fy * ast * d * (1 - ast * fy / (b * d * fck)); // IS 456 Annex G-1.1(b)
  }

  // IS 456 Table 19 design shear strength τc (MPa)
  const TC_PT = [0.15, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0];
  const TC = {
    20: [0.28, 0.36, 0.48, 0.56, 0.62, 0.67, 0.72, 0.75, 0.79, 0.81, 0.82, 0.82, 0.82],
    25: [0.29, 0.36, 0.49, 0.57, 0.64, 0.70, 0.74, 0.78, 0.82, 0.85, 0.88, 0.90, 0.92],
    30: [0.29, 0.37, 0.50, 0.59, 0.66, 0.71, 0.76, 0.80, 0.84, 0.88, 0.91, 0.94, 0.96],
    35: [0.29, 0.37, 0.50, 0.59, 0.67, 0.73, 0.78, 0.82, 0.86, 0.90, 0.93, 0.96, 0.99],
    40: [0.30, 0.38, 0.51, 0.60, 0.68, 0.74, 0.79, 0.84, 0.88, 0.92, 0.95, 0.98, 1.01],
  };
  const TC_MAX = { 20: 2.8, 25: 3.1, 30: 3.5, 35: 3.7, 40: 4.0 };
  function tauC(pt, fck) {
    const g = [20, 25, 30, 35, 40];
    const f = Math.min(Math.max(fck, 20), 40);
    let lo = 20; for (const x of g) if (x <= f) lo = x;
    const hi = g.find(x => x >= f);
    const tlo = interp(TC_PT, TC[lo], pt);
    if (lo === hi) return tlo;
    return tlo + (interp(TC_PT, TC[hi], pt) - tlo) * (f - lo) / (hi - lo);
  }
  const slabShearK = D => interp([150, 175, 200, 225, 250, 275, 300], [1.3, 1.25, 1.2, 1.15, 1.1, 1.05, 1.0], D);

  // IS 456 Annex F crack width, with IS 3370-2 Annex B tension stiffening
  function crackWidth({ Ms, b = 1000, D, d, ast, dia, spacing, cover, fck }) {
    if (Ms <= 0 || ast <= 0) return { w: 0, fs: 0, x: 0 };
    const m = 280 / (3 * (SIGMA_CBC[fck] || fck / 3));
    const Es = 2e5;
    const A = b / 2, B = m * ast, C = -m * ast * d;
    const x = (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A);
    const z = d - x / 3;
    const fs = Ms / (ast * z);
    const eps1 = fs / Es * (D - x) / (d - x);
    const eps2 = b * (D - x) * (D - x) / (3 * Es * ast * (d - x));
    const em = Math.max(eps1 - eps2, 0);
    const acr = Math.sqrt((spacing / 2) ** 2 + (cover + dia / 2) ** 2) - dia / 2;
    const w = 3 * acr * em / (1 + 2 * (acr - cover) / (D - x));
    return { w, fs, x };
  }

  // IS 456 Fig 4 tension modification factor (curve-fit), clamped to 2.0
  function ktFactor(fs, ptPct) {
    const den = 0.225 + 0.00322 * fs - 0.625 * Math.log10(1 / Math.max(ptPct, 0.1));
    if (den <= 0.5) return 2.0;
    return Math.min(1 / den, 2.0);
  }

  /*
   * Pick the lightest bar arrangement for a 1 m strip.
   * opts: Mu, Ms (N·mm/m), D, dEff(dia)→d, fck, fy, cover, astMin, maxSpacing(d), crackLimit, dias
   */
  function chooseBars(o) {
    let best = null, reason = 'no bar arrangement fits';
    for (const dia of (o.dias || BAR_DIAS)) {
      const d = o.dEff(dia);
      if (d <= 0) continue;
      if (o.Mu > muLimit(o.fck, o.fy, 1000, d)) { reason = 'moment exceeds Mu,lim — needs more depth'; continue; }
      const req = Math.max(astRequired(o.Mu, o.fck, o.fy, 1000, d), o.astMin || 0);
      const smax = o.maxSpacing ? o.maxSpacing(d) : 300;
      for (const s of SPACINGS) {
        if (s > smax) continue;
        const ast = astPerM(dia, s);
        if (ast < req) continue;
        let cw = null;
        if (o.crackLimit && o.Ms > 0) {
          cw = crackWidth({ Ms: o.Ms, D: o.D, d, ast, dia, spacing: s, cover: o.cover, fck: o.fck });
          if (cw.w > o.crackLimit) { reason = 'crack width governs'; continue; }
        }
        const cand = { dia, spacing: s, ast, astReq: req, d, MuR: muCapacity(ast, o.fck, o.fy, 1000, d), crack: cw ? cw.w : null };
        if (!best || cand.ast < best.ast - 1e-6 || (Math.abs(cand.ast - best.ast) < 1e-6 && cand.spacing > best.spacing)) best = cand;
        break; // largest admissible spacing for this dia found
      }
    }
    return best || { fail: true, reason };
  }

  // ─────────────── IS 456 Annex D two-way slab coefficients ───────────────
  const R27 = [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.75, 2.0, 2.5, 3.0];
  const T27X = [0.062, 0.074, 0.084, 0.093, 0.099, 0.104, 0.113, 0.118, 0.122, 0.124];
  const T27Y = [0.062, 0.061, 0.059, 0.055, 0.051, 0.046, 0.037, 0.029, 0.020, 0.014];
  const R26 = [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.75, 2.0];
  const C9X = [0.056, 0.064, 0.072, 0.079, 0.085, 0.089, 0.100, 0.107]; // four edges discontinuous
  const C1XN = [0.032, 0.037, 0.043, 0.047, 0.051, 0.053, 0.060, 0.065]; // interior panel
  const C1XP = [0.024, 0.028, 0.032, 0.036, 0.039, 0.041, 0.045, 0.049];

  // IS 456 Cl 24.3.2 effective width coefficient k vs L'/L
  const KR = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const KSS = [0.4, 0.8, 1.16, 1.48, 1.72, 1.96, 2.12, 2.24, 2.36, 2.48];
  const KCONT = [0.4, 0.8, 1.16, 1.44, 1.68, 1.84, 1.96, 2.08, 2.16, 2.24];

  const EDGE_CONDITIONS = {
    ss: 'Simply supported, corners free to lift (Table 27)',
    ssr: 'Simply supported, corners held down (Table 26, case 9)',
    fixed: 'Fixed / continuous on all edges (Table 26, case 1)',
  };

  // Live-load presets for slabs (tank roof, drain cover). Wheel: P kN, contact a×b mm, pair spacing m.
  const SLAB_LOAD_PRESETS = {
    pedestrian: { label: 'Pedestrian / landscaped (5 kPa)', q: 5, P: 0, a: 0, b: 0, s: 0, impact: 1.0 },
    car: { label: 'Cars & light vehicles (IS 875: 2.5 kPa or 9 kN)', q: 2.5, P: 9, a: 200, b: 200, s: 0, impact: 1.0 },
    truck: { label: 'Truck — IRC Class A wheel (57 kN)', q: 0, P: 57, a: 500, b: 250, s: 1.8, impact: 1.25 },
    fire: { label: 'Fire tender (NBC 45 t, 80 kN dual wheel)', q: 0, P: 80, a: 500, b: 250, s: 1.9, impact: 1.25 },
    r70: { label: 'IRC 70R wheeled (100 kN wheel, approx.)', q: 0, P: 100, a: 360, b: 265, s: 1.93, impact: 1.25 },
    forklift: { label: 'Forklift 3 t (40 kN wheel, solid tyre)', q: 0, P: 40, a: 140, b: 140, s: 0.9, impact: 1.4 },
    custom: { label: 'Custom', custom: true },
  };

  // ─────────────────────── generic slab panel ───────────────────────
  /*
   * p: { lx, ly (clear, m), support (mm), edge, extraDL (kPa), q (kPa), wheel {P,a,b,s,impact},
   *      fill (m), waterRetaining, oneWay, widthPerp (m), Dmin, Dmax }
   * s: { exposure, steel, rates }
   */
  function evalSlab(p, s, D, grade) {
    const fck = fckOf(grade), fy = STEELS[s.steel].fy;
    const exp = EXPOSURE[s.exposure];
    const WR = !!p.waterRetaining;
    const cover = WR ? Math.max(45, exp.cover) : exp.cover;
    const dA = D - cover - 6;
    const Lx = Math.min(p.lx + dA / 1000, p.lx + p.support / 1000);
    const Ly = Math.min(p.ly + dA / 1000, p.ly + p.support / 1000);
    const widthPerp = p.widthPerp || Ly;
    const r = Ly / Lx;
    const oneWay = !!p.oneWay || r > 2;
    const fixed = p.edge === 'fixed';
    const wD = 25 * D / 1000 + (p.extraDL || 0);
    const wL = p.q || 0;

    let ax = 0, ay = 0, axn = 0, ayn = 0;
    if (oneWay) { if (fixed) { ax = 1 / 24; axn = 1 / 12; } else ax = 1 / 8; }
    else if (p.edge === 'ss') { ax = interp(R27, T27X, r); ay = interp(R27, T27Y, r); }
    else if (p.edge === 'ssr') { ax = interp(R26, C9X, r); ay = 0.056; }
    else { ax = interp(R26, C1XP, r); axn = interp(R26, C1XN, r); ay = 0.024; ayn = 0.032; }
    const L2 = Lx * Lx;

    // Wheel load: 45° dispersion through fill, effective width per IS 456 Cl 24.3.2
    const w = p.wheel || {};
    let MW = 0, MWn = 0, VW = 0, punch = null, befMid = 0;
    if (w.P > 0) {
      const Pd = w.P * (w.impact || 1);
      const a1 = w.a + 2000 * (p.fill || 0), b1 = w.b + 2000 * (p.fill || 0);
      const along = Math.min(a1, b1), across = Math.max(a1, b1);
      const Lmm = Lx * 1000, Wmm = widthPerp * 1000;
      const kk = interp(KR, fixed ? KCONT : KSS, Wmm / Lmm);
      const befAt = x => Math.max(Math.min(kk * x * (1 - x / Lmm) + across, Wmm), Math.min(across, Wmm));
      const intensity = bef => { // kN per m width
        let i = Pd / bef;
        const sp = (w.s || 0) * 1000;
        if (sp > 0 && sp < bef) i = Math.max(i, 2 * Pd / (bef + sp));
        return i * 1000;
      };
      befMid = befAt(Lmm / 2);
      const pM = intensity(befMid);
      const bal = Math.min(along, Lmm) / 1000;
      if (fixed) { MW = pM * Lx / 8 * (1 - bal / (2 * Lx)); MWn = MW; }
      else MW = pM * (Lx / 4 - bal / 8);
      const xv = Math.min(dA + along / 2, Lmm / 2); // load edge at d from support (critical section)
      VW = intensity(befAt(xv)) * (Lmm - xv) / Lmm;
      const u = 2 * (a1 + b1 + 2 * dA);
      punch = { Vu: 1.5 * Pd * 1000, u, d: dA, allow: 0.25 * Math.sqrt(fck) };
    }

    const MDx = ax * wD * L2, MLx = ax * wL * L2;
    const MDy = ay * wD * L2, MLy = ay * wL * L2;
    const MuX = 1.5 * (MDx + Math.max(MLx, MW)), MsX = MDx + Math.max(MLx, MW);
    const MuY = 1.5 * (MDy + Math.max(MLy, 0.3 * MW)), MsY = MDy + Math.max(MLy, 0.3 * MW);
    const MuXn = 1.5 * (axn * wD * L2 + Math.max(axn * wL * L2, MWn)), MsXn = MuXn / 1.5;
    const MuYn = 1.5 * (ayn * (wD + wL) * L2), MsYn = MuYn / 1.5;
    const Vu = 1.5 * (wD * Lx / 2 + Math.max(wL * Lx / 2, VW));

    const astMin = (WR ? (D >= 200 ? 0.0012 : 0.0024) : 0.0012) * 1000 * D;
    const crackLimit = WR ? 0.2 : 0.3;
    const base = { D, fck, fy, cover, crackLimit, astMin };
    let xb = chooseBars({ ...base, Mu: MuX * 1e6, Ms: MsX * 1e6, dEff: f => D - cover - f / 2, maxSpacing: d => Math.min(3 * d, 300) });
    if (xb.fail) return { ok: false, reason: 'short-span bottom: ' + xb.reason };
    // Raise main steel if one-way shear (no stirrups) needs a higher pt
    for (let it = 0; it < 2; it++) {
      const tcReq = Vu / xb.d / slabShearK(D);
      if (tcReq <= tauC(100 * xb.ast / (1000 * xb.d), fck)) break;
      if (tcReq > tauC(3, fck)) return { ok: false, reason: 'shear exceeds τc at 3% steel — needs more depth' };
      let lo = 0.15, hi = 3;
      for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (tauC(m, fck) >= tcReq) hi = m; else lo = m; }
      const nb = chooseBars({ ...base, astMin: Math.max(astMin, hi * 10 * xb.d), Mu: MuX * 1e6, Ms: MsX * 1e6, dEff: f => D - cover - f / 2, maxSpacing: d => Math.min(3 * d, 300) });
      if (nb.fail) return { ok: false, reason: 'short-span bottom (shear steel): ' + nb.reason };
      xb = nb;
    }
    const yb = chooseBars({ ...base, Mu: MuY * 1e6, Ms: MsY * 1e6, dEff: f => D - cover - xb.dia - f / 2, maxSpacing: d => Math.min(5 * d, 300) });
    if (yb.fail) return { ok: false, reason: 'long-span bottom: ' + yb.reason };
    let xt = null, yt = null, topFactor = 1;
    if (fixed) {
      xt = chooseBars({ ...base, Mu: MuXn * 1e6, Ms: MsXn * 1e6, dEff: f => D - cover - f / 2, maxSpacing: d => Math.min(3 * d, 300) });
      if (xt.fail) return { ok: false, reason: 'support top steel: ' + xt.reason };
      yt = chooseBars({ ...base, Mu: MuYn * 1e6, Ms: MsYn * 1e6, dEff: f => D - cover - xt.dia - f / 2, maxSpacing: d => Math.min(5 * d, 300) });
      if (yt.fail) return { ok: false, reason: 'support top steel: ' + yt.reason };
      topFactor = 0.6; // top bars extend 0.3 L from each support
    } else if (WR && D >= 200) {
      xt = chooseBars({ ...base, Mu: 0, Ms: 0, dEff: f => D - cover - f / 2 });
      yt = chooseBars({ ...base, Mu: 0, Ms: 0, dEff: f => D - cover - xt.dia - f / 2 });
    }

    const checks = [];
    checks.push(check('Flexure — short span', MuX, xb.MuR / 1e6, 'kNm/m', 'IS 456 Cl 38.1'));
    checks.push(check(oneWay ? 'Distribution steel moment' : 'Flexure — long span', MuY, yb.MuR / 1e6, 'kNm/m', 'IS 456 Cl 38.1'));
    if (fixed) checks.push(check('Flexure — support (hogging)', MuXn, xt.MuR / 1e6, 'kNm/m', 'IS 456 Annex D'));
    const d = xb.d;
    const pt = 100 * xb.ast / (1000 * d);
    const tc = slabShearK(D) * tauC(pt, fck);
    checks.push(check('One-way shear (no stirrups)', Vu / d, tc, 'MPa', 'IS 456 Cl 40.2'));
    if (punch) {
      checks.push(check('Punching under wheel', punch.Vu / (punch.u * punch.d), punch.allow, 'MPa', 'IS 456 Cl 31.6.3'));
    }
    const fs = 0.58 * fy * Math.min(astRequired(MuX * 1e6, fck, fy, 1000, d), xb.ast) / xb.ast;
    const allowLd = (fixed ? 26 : 20) * ktFactor(fs, pt);
    checks.push(check('Deflection (span / d)', Lx * 1000 / d, allowLd, '', 'IS 456 Cl 23.2.1'));
    if (xb.crack != null) checks.push(check('Crack width — bottom face', xb.crack, crackLimit, 'mm', WR ? 'IS 3370-2 Cl 4.1' : 'IS 456 Cl 35.3.2'));
    if (xt && xt.crack != null) checks.push(check('Crack width — top face', xt.crack, crackLimit, 'mm', WR ? 'IS 3370-2' : 'IS 456'));
    checks.push(check('Min. steel (short span)', astMin, xb.ast, 'mm²/m', WR ? 'IS 3370-2 Cl 8.1' : 'IS 456 Cl 26.5.2.1'));
    const ok = checks.every(c => c.pass);

    const steelKgM2 = kgPerM2(xb.ast + yb.ast) + (xt ? kgPerM2(xt.ast + yt.ast) * topFactor : 0);
    const R = s.rates;
    const costM2 = D / 1000 * R[grade] + steelKgM2 * (1 + R.lapPct / 100) * R.steel + R.formwork;
    return {
      ok, reason: ok ? '' : 'fails: ' + checks.filter(c => !c.pass).map(c => c.name).join(', '),
      D, grade, fck, cover, oneWay, Lx, Ly, r, xb, yb, xt, yt, steelKgM2, costM2, checks,
      loads: { wD, wL, MuX, MuY, MuXn, Vu, MW, befMid },
    };
  }

  function optimiseSlab(p, s) {
    const exp = EXPOSURE[s.exposure];
    const minFck = Math.max(fckOf(exp.minGrade), p.waterRetaining ? 30 : 0, p.minFck || 0);
    const grades = GRADE_LIST.filter(g => fckOf(g) >= minFck);
    const feasible = [];
    let lastFail = null;
    for (const g of grades) {
      for (const D of range(p.Dmin || 150, p.Dmax || 450, 10)) {
        const r = evalSlab(p, s, D, g);
        if (r.ok) feasible.push(r); else lastFail = r;
      }
    }
    feasible.sort((a, b) => a.costM2 - b.costM2);
    return { feasible, lastFail };
  }

  function bestPerKey(list, keyFn, n = 4) {
    const seen = new Set(), out = [];
    for (const r of list) { const k = keyFn(r); if (!seen.has(k)) { seen.add(k); out.push(r); } if (out.length >= n) break; }
    return out;
  }

  function boqRow(item, qty, unit, rate) { return { item, qty: round(qty, 2), unit, rate, amount: round(qty * rate, 0) }; }
  function finishBoq(rows) { return { rows, total: rows.reduce((t, r) => t + r.amount, 0) }; }
  function failResult(kind, msg) {
    return { ok: false, kind, error: msg, summary: [], sections: [], checks: [], boq: { rows: [], total: 0 }, alternatives: [], notes: [], warnings: [msg] };
  }

  // ─────────────────────── 1. slab over water tank ───────────────────────
  function designTankSlab(inp, s) {
    const wheel = { P: inp.P, a: inp.a, b: inp.b, s: inp.s, impact: inp.impact };
    const p = {
      lx: Math.min(inp.lx, inp.ly), ly: Math.max(inp.lx, inp.ly), support: inp.wall, edge: inp.edge,
      extraDL: inp.finish + inp.fill * inp.soilGamma, q: inp.q, wheel, fill: inp.fill,
      waterRetaining: inp.waterRetaining, Dmin: 150, Dmax: 450,
    };
    const { feasible, lastFail } = optimiseSlab(p, s);
    if (!feasible.length) return failResult('tank', 'No section up to 450 mm passes — ' + (lastFail ? lastFail.reason : 'check inputs') + '. Reduce span or add an intermediate beam.');
    const R = s.rates, lap = 1 + R.lapPct / 100;
    const gx = p.lx + inp.wall / 1000, gy = p.ly + inp.wall / 1000;
    const gross = gx * gy, open = inp.manhole > 0 ? inp.manhole * inp.manhole : 0;
    const tankBoq = r => {
      let torsion = 0, trim = 0;
      if (inp.edge === 'ssr' && !r.oneWay) torsion = 4 * (r.Lx / 5) ** 2 * 2 * kgPerM2(0.75 * r.xb.ast);
      if (open > 0) {
        const phi = Math.max(r.xb.dia, 12);
        trim = 4 * 2 * (inp.manhole + 2 * 50 * phi / 1000) * barKgPerM(phi) * (r.xt ? 2 : 1);
      }
      return { torsion, boq: finishBoq([
        boqRow(`RCC ${r.grade} roof slab, ${r.D} mm`, (gross - open) * r.D / 1000, 'm³', R[r.grade]),
        boqRow(`TMT ${STEELS[s.steel].label} (incl. ${R.lapPct}% laps/wastage)`, (r.steelKgM2 * gross + torsion + trim) * lap, 'kg', R.steel),
        boqRow('Soffit formwork & staging', p.lx * p.ly - open, 'm²', R.formwork),
      ]) };
    };
    const priced = feasible.map(r => ({ r, ...tankBoq(r) })).sort((a, c) => a.boq.total - c.boq.total);
    const b = priced[0].r, boq = priced[0].boq, torsion = priced[0].torsion;
    const top = b.xt ? `${barStr(b.xt)} (short) / ${barStr(b.yt)} (long)${inp.edge === 'fixed' ? ' over supports, 0.3 L' : ' — crack-control mesh'}` : (inp.edge === 'ssr' && !b.oneWay ? 'Corner torsion mesh only' : 'Not required');
    return {
      ok: true, kind: 'tank',
      summary: [
        { label: 'Slab thickness', value: `${b.D} mm` },
        { label: 'Concrete', value: b.grade },
        { label: 'Bottom — short span', value: barStr(b.xb) },
        { label: b.oneWay ? 'Distribution' : 'Bottom — long span', value: barStr(b.yb) },
        { label: 'Clear cover', value: `${b.cover} mm` },
        { label: 'Estimated cost', value: boq.total, money: true },
      ],
      sections: [
        { title: 'Design basis', rows: [
          ['Action', b.oneWay ? `One-way (ly/lx = ${round(b.r, 2)})` : `Two-way (ly/lx = ${round(b.r, 2)})`],
          ['Edge condition', EDGE_CONDITIONS[inp.edge]],
          ['Effective spans', `${round(b.Lx, 2)} m × ${round(b.Ly, 2)} m`],
          ['Dead load', `${round(b.loads.wD, 2)} kPa (slab + finish + ${inp.fill} m fill)`],
          ['Live load', inp.P > 0 ? `${inp.P} kN wheel × ${inp.impact} impact, effective width ${round(b.loads.befMid / 1000, 2)} m` : `${inp.q} kPa UDL`],
          ['Factored Mu (short / long)', `${round(b.loads.MuX, 1)} / ${round(b.loads.MuY, 1)} kNm/m`],
          ['Water-retaining rules', inp.waterRetaining ? 'IS 3370-2: M30 min, 45 mm cover, crack ≤ 0.2 mm' : 'Not applied'],
        ] },
        { title: 'Reinforcement', rows: [
          ['TMT grade', STEELS[s.steel].label + ' (IS 1786)'],
          ['Bottom, short span (main)', barStr(b.xb)],
          ['Bottom, long span', barStr(b.yb)],
          ['Top steel', top],
          ...(open > 0 ? [['Manhole trimmers', `2 × ${Math.max(b.xb.dia, 12)} mm each side of ${inp.manhole} m opening, each layer`]] : []),
          ...(torsion > 0 ? [['Corner torsion steel', `${barStr({ dia: b.xb.dia, spacing: b.xb.spacing })} top, both ways, over ${round(b.Lx / 5, 2)} m × ${round(b.Lx / 5, 2)} m at each corner`]] : []),
        ] },
      ],
      checks: b.checks,
      boq,
      alternatives: bestPerKey(priced, x => x.r.grade).map(x => ({
        label: `${x.r.grade}, ${x.r.D} mm`, detail: `${barStr(x.r.xb)} / ${barStr(x.r.yb)}`,
        cost: x.boq.total, best: x.r === b,
      })),
      drawing: {
        type: 'tank', D: b.D, cover: b.cover, grade: b.grade, fill: inp.fill, fillGamma: inp.soilGamma, finish: inp.finish,
        span: b.Lx, Lx: b.Lx, Ly: b.Ly, lx: p.lx, ly: p.ly, wall: inp.wall, xb: b.xb, yb: b.yb, xt: b.xt, yt: b.yt,
        oneWay: b.oneWay, edge: inp.edge, manhole: inp.manhole, torsion: torsion > 0, P: inp.P, q: inp.q, impact: inp.impact,
        along: Math.min(inp.a || 0, inp.b || 0), steel: STEELS[s.steel].label,
      },
      notes: [
        'Wheel load dispersed at 45° through fill; effective width per IS 456 Cl 24.3.2; wheel moments taken as simply supported (fixed edges: PL/8).',
        'Live UDL and wheel load are not combined — the worse governs (IS 875-2).',
        'Underside is the humid (water-side) face: crack width checked there.',
      ],
      warnings: [],
    };
  }

  // ─────────────────────────── 2. RCC drain ───────────────────────────
  const SURCHARGE = {
    none: { label: 'None (no traffic near drain)', q: 0 },
    pedestrian: { label: 'Pedestrian / footpath (5 kPa)', q: 5 },
    vehicle: { label: 'Vehicular — 1.2 m equivalent fill (IRC 6)', q: null },
  };

  function designDrain(inp, s) {
    const exp = EXPOSURE[s.exposure], R = s.rates, lap = 1 + R.lapPct / 100;
    const WR = !!inp.waterRetaining;
    const fy = STEELS[s.steel].fy;
    const cover = WR ? Math.max(45, exp.cover) : exp.cover;
    const coverBase = Math.max(cover, 50);
    const crackLimit = WR ? 0.2 : 0.3;
    const K0 = 1 - Math.sin(inp.phi * Math.PI / 180);
    const surch = inp.surcharge === 'vehicle' ? 1.2 * inp.gamma : SURCHARGE[inp.surcharge].q;
    const minFck = Math.max(fckOf(exp.minGrade), WR ? 30 : 0);
    const grades = GRADE_LIST.filter(g => fckOf(g) >= minFck);

    // Cover slab (precast, one-way, simply supported on walls)
    let cov = null, covFeas = [];
    if (inp.covered) {
      const r = optimiseSlab({
        lx: inp.B, ly: inp.unitWidth, support: 150, edge: 'ss', extraDL: 0, q: inp.q,
        wheel: { P: inp.P, a: inp.a, b: inp.b, s: inp.s, impact: inp.impact },
        fill: 0, waterRetaining: false, oneWay: true, widthPerp: inp.unitWidth, Dmin: 100, Dmax: 350,
      }, s);
      covFeas = r.feasible;
      if (!covFeas.length) return failResult('drain', 'Cover slab: no section up to 350 mm passes — ' + (r.lastFail ? r.lastFail.reason : ''));
      cov = covFeas[0];
    }
    const covW = cov ? 25 * cov.D / 1000 * (inp.B + 0.3) : 0;
    // wheel on the cover spreads at 45 deg down the continuous walls: unit width + 2 x wall height along the drain
    const wheelSpread = Math.max(1, inp.unitWidth + 2 * inp.H);
    const wheelR = inp.covered && inp.P > 0 ? inp.P * inp.impact / wheelSpread : 0;

    const Hw = inp.H + 0.075;
    const Ms_soil = K0 * inp.gamma * Hw ** 3 / 6 + K0 * surch * Hw ** 2 / 2;
    const Vs_soil = K0 * inp.gamma * Hw ** 2 / 2 + K0 * surch * Hw;
    const Ms_w = 9.81 * Hw ** 3 / 6;
    const faceMinPct = WR ? 0.0012 : 0.0006;
    const horizPct = WR ? 0.0012 : 0.0010;

    const all = [];
    let lastReason = '';
    for (const g of grades) {
      const fck = fckOf(g);
      for (const tw of range(Math.max(150, inp.twMin || 0), 300, 25)) {
        const base = { D: tw, fck, fy, cover, crackLimit };
        const soil = chooseBars({ ...base, Mu: 1.5 * Ms_soil * 1e6, Ms: Ms_soil * 1e6, dEff: f => tw - cover - f / 2, astMin: faceMinPct * 1000 * tw, maxSpacing: d => Math.min(3 * d, 300) });
        const inner = chooseBars({ ...base, Mu: 1.5 * Ms_w * 1e6, Ms: Ms_w * 1e6, dEff: f => tw - cover - f / 2, astMin: faceMinPct * 1000 * tw, maxSpacing: d => Math.min(3 * d, 300) });
        if (soil.fail || inner.fail) { lastReason = 'wall: ' + (soil.reason || inner.reason); continue; }
        const horiz = chooseBars({ ...base, Mu: 0, Ms: 0, dEff: f => tw - cover - soil.dia - f / 2, astMin: horizPct / 2 * 1000 * tw, crackLimit: 0 });
        const tcW = slabShearK(tw) * tauC(100 * soil.ast / (1000 * soil.d), fck);
        const wallChecks = [
          check('Wall flexure — soil face (earth + surcharge)', 1.5 * Ms_soil, soil.MuR / 1e6, 'kNm/m', 'IS 456 Cl 38.1'),
          check('Wall flexure — inner face (drain full, no backfill)', 1.5 * Ms_w, inner.MuR / 1e6, 'kNm/m', 'IS 456 Cl 38.1'),
          check('Wall shear at base', 1.5 * Vs_soil / soil.d, tcW, 'MPa', 'IS 456 Cl 40.2'),
        ];
        if (soil.crack != null) wallChecks.push(check('Wall crack width — soil face', soil.crack, crackLimit, 'mm', WR ? 'IS 3370-2' : 'IS 456 Cl 35.3.2'));
        if (!wallChecks.every(c => c.pass)) { lastReason = 'wall shear/crack'; continue; }

        for (const tb of range(Math.max(150, inp.tbMin || 0), 300, 25)) {
          const toe = (inp.toe || 0) / 1000;   // optional base projection beyond each wall
          const span = inp.B + tw / 1000, outer = inp.B + 2 * tw / 1000, baseW = outer + 2 * toe;
          const wallW = 25 * tw / 1000 * inp.H;
          const pNet = (2 * wallW + covW + wheelR) / outer;
          const MsTop = Math.max(pNet * span ** 2 / 8, Ms_w);
          const bb = { D: tb, fck, fy, crackLimit };
          const bot = chooseBars({ ...bb, cover: coverBase, Mu: 1.5 * Ms_soil * 1e6, Ms: Ms_soil * 1e6, dEff: f => tb - coverBase - f / 2, astMin: faceMinPct * 1000 * tb, maxSpacing: d => Math.min(3 * d, 300) });
          const topb = chooseBars({ ...bb, cover, Mu: 1.5 * MsTop * 1e6, Ms: MsTop * 1e6, dEff: f => tb - cover - f / 2, astMin: faceMinPct * 1000 * tb, maxSpacing: d => Math.min(3 * d, 300) });
          if (bot.fail || topb.fail) { lastReason = 'base: ' + (bot.reason || topb.reason); continue; }
          const dist = chooseBars({ ...bb, cover, Mu: 0, Ms: 0, dEff: f => tb - cover - f / 2, astMin: horizPct / 2 * 1000 * tb, crackLimit: 0 });
          const Vb = 1.5 * pNet * span / 2;
          const tcB = slabShearK(tb) * tauC(100 * topb.ast / (1000 * topb.d), fck);
          const qGross = (2 * wallW + 25 * tb / 1000 * baseW + covW + wheelR + 9.81 * inp.B * inp.H + (toe > 0 ? 2 * toe * inp.H * inp.gamma : 0)) / baseW;
          const checks = [
            ...wallChecks,
            check('Base flexure — bottom (wall fixity)', 1.5 * Ms_soil, bot.MuR / 1e6, 'kNm/m', 'IS 456 Cl 38.1'),
            check('Base flexure — top (soil reaction / water)', 1.5 * MsTop, topb.MuR / 1e6, 'kNm/m', 'IS 456 Cl 38.1'),
            check('Base shear', Vb / topb.d, tcB, 'MPa', 'IS 456 Cl 40.2'),
            check('Bearing pressure (drain full)', qGross, inp.sbc, 'kPa', 'IS 6403'),
          ];
          if (!checks.every(c => c.pass)) { lastReason = checks.find(c => !c.pass).name; continue; }
          const concM = 2 * tw / 1000 * inp.H + tb / 1000 * baseW;
          const steelM = (2 * inp.H * kgPerM2(soil.ast + inner.ast + 2 * horiz.ast) + baseW * kgPerM2(bot.ast + topb.ast + 2 * dist.ast)) * lap;
          const formM = 4 * inp.H;
          const pccM = (baseW + 0.15) * 0.075;
          const excM = (baseW + 0.6) * (inp.H + tb / 1000 + 0.075);
          const covCostM = cov ? cov.costM2 * (inp.B + 0.3) : 0;
          const costM = concM * R[g] + steelM * R.steel + formM * R.formwork + pccM * R.pcc + excM * R.excavation + covCostM;
          all.push({ toe: toe * 1000, grade: g, tw, tb, soil, inner, horiz, bot, topb, dist, checks, concM, steelM, formM, pccM, excM, costM, qGross });
          break; // thinnest base that works for this wall is cheapest
        }
      }
    }
    if (!all.length) return failResult('drain', 'No wall/base combination up to 300 mm passes — ' + lastReason + '. Consider a counterfort or reducing depth.');
    all.sort((a, b) => a.costM - b.costM);
    const b = all[0], L = inp.length;
    const rows = [
      boqRow('Excavation', b.excM * L, 'm³', R.excavation),
      boqRow('PCC M10 bed, 75 mm', b.pccM * L, 'm³', R.pcc),
      boqRow(`RCC ${b.grade} walls + base`, b.concM * L, 'm³', R[b.grade]),
      boqRow(`TMT ${STEELS[s.steel].label} walls + base (incl. laps)`, b.steelM * L, 'kg', R.steel),
      boqRow('Wall formwork (both faces)', b.formM * L, 'm²', R.formwork),
    ];
    if (cov) {
      const area = (inp.B + 0.3) * L;
      rows.push(boqRow(`Precast cover slabs ${cov.grade}, ${cov.D} mm`, area * cov.D / 1000, 'm³', R[cov.grade]));
      rows.push(boqRow('TMT in cover slabs (incl. laps)', area * cov.steelKgM2 * lap, 'kg', R.steel));
      rows.push(boqRow('Cover slab moulds', area, 'm²', R.formwork));
    }
    const boq = finishBoq(rows);
    const covChecks = cov ? cov.checks.map(c => ({ ...c, name: 'Cover slab — ' + c.name })) : [];
    return {
      ok: true, kind: 'drain',
      summary: [
        { label: 'Wall / base', value: `${b.tw} / ${b.tb} mm` },
        { label: 'Concrete', value: b.grade + (cov && cov.grade !== b.grade ? ` (cover ${cov.grade})` : '') },
        { label: 'Wall vertical (soil face)', value: barStr(b.soil) },
        { label: 'Base bottom', value: barStr(b.bot) },
        { label: 'Cover slab', value: cov ? `${cov.D} mm, ${barStr(cov.xb)}` : 'Open drain' },
        { label: 'Estimated cost', value: boq.total, money: true },
      ],
      sections: [
        { title: 'Design basis', rows: [
          ['Internal size', `${inp.B} m wide × ${inp.H} m deep, ${L} m long`],
          ['Earth pressure', `K₀ = ${round(K0, 3)}, γ = ${inp.gamma} kN/m³, surcharge ${round(surch, 1)} kPa`],
          ['Wall moment at base (service)', `${round(Ms_soil, 2)} kNm/m (soil) / ${round(Ms_w, 2)} kNm/m (water)`],
          ['Bearing pressure', `${round(b.qGross, 1)} kPa vs SBC ${inp.sbc} kPa${b.toe ? ` (base toe ${b.toe} mm each side)` : ''}`],
          ['Cover', `${cover} mm (walls, base top), ${coverBase} mm (base bottom)`],
          ['Rules', WR ? 'IS 3370-2 (sewage/effluent): crack ≤ 0.2 mm, 0.24% min steel' : 'IS 456: crack ≤ 0.3 mm'],
        ] },
        { title: 'Reinforcement', rows: [
          ['TMT grade', STEELS[s.steel].label],
          ['Wall vertical — soil face', barStr(b.soil)],
          ['Wall vertical — inner face', barStr(b.inner)],
          ['Wall horizontal — each face', barStr(b.horiz)],
          ['Base — bottom (transverse)', barStr(b.bot)],
          ['Base — top (transverse)', barStr(b.topb)],
          ['Base — longitudinal, each face', barStr(b.dist)],
          ...(cov ? [['Cover slab main / distribution', `${barStr(cov.xb)} / ${barStr(cov.yb)}`], ['Cover unit', `${inp.unitWidth} m wide × ${round(inp.B + 0.3, 2)} m long, ≈ ${round(25 * cov.D / 1000 * inp.unitWidth * (inp.B + 0.3) / 9.81 * 1000, 0)} kg each`]] : []),
        ] },
      ],
      checks: [...b.checks, ...covChecks],
      boq,
      alternatives: bestPerKey(all, r => r.grade).map(r => ({
        label: `${r.grade}: wall ${r.tw} / base ${r.tb} mm`, detail: `soil face ${barStr(r.soil)}`, cost: Math.round(r.costM * L), best: r === b,
      })),
      drawing: {
        type: 'drain', B: inp.B, H: inp.H, tw: b.tw, tb: b.tb, toe: b.toe || 0, cover, coverBase, grade: b.grade, coverD: cov ? cov.D : 0,
        soil: b.soil, inner: b.inner, horiz: b.horiz, bot: b.bot, top: b.topb, dist: b.dist,
        cov: cov ? { D: cov.D, grade: cov.grade, cover: cov.cover, xb: cov.xb, yb: cov.yb, Lx: cov.Lx } : null,
        unitWidth: inp.unitWidth, K0, gamma: inp.gamma, surch, Hw, MsSoil: Ms_soil, MsW: Ms_w, qGross: b.qGross, sbc: inp.sbc,
        P: inp.covered ? inp.P : 0, impact: inp.impact, along: Math.min(inp.a || 0, inp.b || 0), steel: STEELS[s.steel].label,
      },
      notes: [
        'Walls designed as cantilevers from the base (cover slab assumed not to prop the walls).',
        'Wheel load on the cover spreads at 45 deg down the walls (unit width + 2 x depth along the drain) for base and bearing checks.',
        'Inner face designed for drain running full with no backfill (construction / test condition).',
        'Hydraulic sizing is not part of this tool — enter the required internal size.',
      ],
      warnings: [],
    };
  }

  // ─────────────────────── 3. internal rigid road ───────────────────────
  // IRC 58 — k vs soaked CBR
  const CBR_X = [2, 3, 4, 5, 7, 10, 15, 20, 50, 100];
  const K_Y = [21, 28, 35, 42, 48, 55, 62, 69, 140, 220];
  const kFromCBR = cbr => interp(CBR_X, K_Y, cbr);
  // Effective k over sub-base (approx. per IRC 58 tables), MPa/m
  const KS_BASE = [28, 56, 84];
  const K_EFF = {
    gsb150: [39, 64, 92], gsb225: [44, 70, 98], gsb300: [53, 78, 104],
    dlc100: [76, 140, 190], dlc150: [110, 200, 260],
  };
  function effectiveK(ks, layer) {
    if (!layer) return ks;
    const ys = K_EFF[layer];
    if (ks < KS_BASE[0]) return ks * ys[0] / KS_BASE[0];
    if (ks > KS_BASE[2]) return Math.min(ks * ys[2] / KS_BASE[2], 300);
    return interp(KS_BASE, ys, ks);
  }
  const ROAD_SUBBASES = [
    { id: 'g150', label: '150 mm GSB', gsb: 150, dlc: 0, layer: 'gsb150' },
    { id: 'g225', label: '225 mm GSB', gsb: 225, dlc: 0, layer: 'gsb225' },
    { id: 'g150d100', label: '100 mm DLC on 150 mm GSB', gsb: 150, dlc: 100, layer: 'dlc100' },
    { id: 'g150d150', label: '150 mm DLC on 150 mm GSB', gsb: 150, dlc: 150, layer: 'dlc150' },
  ];
  // IRC 58 temperature differential (°C) by region for h = 150/200/250/300 mm
  const REGIONS = {
    north: { label: 'Punjab, UP, Uttarakhand (plains), Haryana, Rajasthan, Gujarat, N. MP', dt: [12.5, 13.1, 14.3, 15.8] },
    // IRC 58 excludes hilly regions from its table; 18 °C adopted for Bhimtal (high altitude: strong solar
    // radiation, large day–night swing). Override with measured site data when available.
    hilly: { label: 'Bhimtal / Uttarakhand & HP hills (ΔT 18 °C)', dt: [18, 18, 18, 18], hilly: true },
    east: { label: 'Bihar, Jharkhand, WB, Assam, E. Odisha', dt: [15.6, 16.4, 16.6, 16.8] },
    central: { label: 'Maharashtra, Karnataka, S. MP, Chhattisgarh, AP, Telangana, W. Odisha', dt: [17.3, 19.0, 20.3, 21.0] },
    south: { label: 'Kerala, S. Tamil Nadu', dt: [15.0, 16.4, 17.6, 18.1] },
    coastalHills: { label: 'Coastal, bounded by hills', dt: [14.6, 15.8, 16.2, 17.0] },
    coastal: { label: 'Coastal, unbounded by hills', dt: [15.5, 17.0, 19.0, 19.2] },
  };
  const DT_H = [150, 200, 250, 300];
  const BR_X = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14];
  const BR_C = [0, 0.04, 0.175, 0.44, 0.72, 0.92, 1.03, 1.077, 1.08, 1.075, 1.05, 1.0, 0.95];
  const bradburyC = r => (r <= 1 ? 0 : interp(BR_X, BR_C, r));
  const radiusRelStiff = (E, h, k, mu) => Math.pow(E * h ** 3 / (12 * (1 - mu * mu) * k), 0.25); // k in N/mm³
  const eqRadius = (a, h) => (a < 1.724 * h ? Math.sqrt(1.6 * a * a + h * h) - 0.675 * h : a);
  function edgeStress(P, h, l, a, mu = 0.15) { // Westergaard (Teller–Sutherland), IRC 58
    const b = eqRadius(a, h);
    return 0.529 * P / (h * h) * (1 + 0.54 * mu) * (4 * Math.log10(l / b) + 0.359);
  }
  const cornerStress = (P, h, l, a) => 3 * P / (h * h) * (1 - Math.pow(a * Math.SQRT2 / l, 1.2));
  function fatigueN(SR) { // IRC 58 fatigue model
    if (SR < 0.45) return Infinity;
    if (SR <= 0.55) return Math.pow(4.2577 / (SR - 0.4325), 3.268);
    return Math.pow(10, (0.9718 - SR) / 0.0828);
  }
  // IRC 58 recommended dowels (plain MS) vs slab thickness
  const DOWELS = [[200, 25, 360], [230, 30, 400], [250, 32, 450], [280, 36, 450], [300, 38, 500]];
  function dowelFor(h) { let r = null; for (const row of DOWELS) if (h >= row[0]) r = row; return r ? { dia: r[1], len: r[2], spacing: 300 } : null; }

  const ROAD_PRESETS = {
    colony: { label: 'Residential / colony road', cvpd: 15, commAxle: 80, maxAxle: 100, maxReps: 1000 },
    campus: { label: 'Campus / industrial estate road', cvpd: 100, commAxle: 100, maxAxle: 120, maxReps: 5000 },
    fire: { label: 'Fire-tender access (NBC 45 t)', cvpd: 10, commAxle: 80, maxAxle: 160, maxReps: 500 },
    heavy: { label: 'Heavy industrial / logistics yard', cvpd: 400, commAxle: 110, maxAxle: 140, maxReps: 20000 },
    custom: { label: 'Custom', custom: true },
  };

  function designRoad(inp, s) {
    const R = s.rates, lap = 1 + R.lapPct / 100, fy = STEELS[s.steel].fy;
    const ks = inp.kOverride > 0 ? inp.kOverride : kFromCBR(inp.cbr);
    const rr = inp.growth / 100;
    const growthF = rr > 0 ? ((1 + rr) ** inp.years - 1) / rr : inp.years;
    const Ncum = inp.cvpd * 365 * growthF * inp.ldf;
    const E = 30000, mu = 0.15, alpha = 1e-5;
    const nL = Math.max(1, Math.round(inp.roadWidth / inp.laneWidth));
    const longJ = (nL - 1) / inp.roadWidth; // m of longitudinal joint per m²
    const dtTable = REGIONS[inp.region].dt;
    const groups = [
      { label: 'Commercial axle', axle: inp.commAxle, reps: Ncum },
      { label: 'Heaviest axle', axle: inp.maxAxle, reps: inp.maxReps },
    ];
    const minFck = 30;
    const grades = GRADE_LIST.filter(g => fckOf(g) >= minFck);
    const subbases = inp.kOverride > 0 ? [ROAD_SUBBASES[0]] : ROAD_SUBBASES;
    const designs = [];

    function evalRoad(h, fck, k) {
      const kN = k / 1000; // N/mm³
      const l = radiusRelStiff(E, h, kN, mu);
      const MR = 0.7 * Math.sqrt(fck);
      let cfd = 0;
      const rows = groups.map(g => {
        const P = g.axle / 2 * inp.lsf * 1000;
        const a = Math.sqrt(P / (Math.PI * inp.tyre));
        const se = edgeStress(P, h, l, a, mu);
        const N = fatigueN(se / MR);
        cfd += Number.isFinite(N) ? g.reps / N : 0;
        return { ...g, P, a, se, sc: cornerStress(P, h, l, a), N };
      });
      const dT = inp.dtOverride > 0 ? inp.dtOverride : interp(DT_H, dtTable, h);
      const C = bradburyC(inp.jointSpacing * 1000 / l);
      const st = C * E * alpha * dT / 2;
      const heavy = rows[1];
      const checks = [
        check('Fatigue — cumulative damage (edge)', cfd, 1, 'CFD', 'IRC 58 fatigue model'),
        check('Edge stress: heaviest axle + curling', heavy.se + st, MR, 'MPa', 'IRC 58 / Westergaard + Bradbury'),
        check('Corner stress: heaviest axle', heavy.sc, MR, 'MPa', 'IRC 58 / Westergaard corner'),
      ];
      return { ok: checks.every(c => c.pass), checks, l, MR, cfd, st, dT, C, rows };
    }

    for (const sb of subbases) {
      const k = inp.kOverride > 0 ? inp.kOverride : effectiveK(ks, sb.layer);
      for (const g of grades) {
        const fck = fckOf(g);
        let found = null;
        for (const h of range(Math.max(150, inp.hMin || 0), 400, 10)) {
          const r = evalRoad(h, fck, k);
          if (r.ok) { found = { h, ...r }; break; }
        }
        if (!found) continue;
        const h = found.h;
        const W = 24 * h / 1000; // kN/m² slab weight
        // tie bars (TMT 12 mm) at longitudinal joints — subgrade drag
        const tieAs = inp.laneWidth * 1.5 * W / 200 * 1000; // mm²/m
        const tieSp = Math.max(300, Math.min(750, Math.floor(barArea(12) / tieAs * 1000 / 50) * 50));
        const tieLen = Math.ceil((2 * 200 * 12 / (4 * 2.46) + 150) / 10) * 10;
        const tieKgM2 = longJ > 0 ? (1000 / tieSp) * tieLen / 1000 * barKgPerM(12) * longJ : 0;
        const common = h / 1000 * R[g] + sb.gsb / 1000 * R.gsb + sb.dlc / 1000 * R.dlc + R.subgrade + longJ * R.sawcut + tieKgM2 * lap * R.steel;
        // JPCP
        const dw = dowelFor(h);
        const dowelKgM2 = dw ? (1000 / dw.spacing) * dw.len / 1000 * barKgPerM(dw.dia) / inp.jointSpacing : 0;
        const jpcpCost = common + R.sawcut / inp.jointSpacing + dowelKgM2 * R.msDowel;
        designs.push({ type: 'JPCP', sb, k, grade: g, h, ...found, dw, dowelKgM2, tie: { dia: 12, spacing: tieSp, len: tieLen }, tieKgM2, meshKgM2: 0, costM2: jpcpCost, joint: inp.jointSpacing });
        // JRCP — TMT mesh by subgrade drag, longer joints, dowels at every joint
        const fs = 0.6 * fy;
        const AsL = inp.jrcpSpacing * 1.5 * W / (2 * fs) * 1000;
        const AsT = inp.laneWidth * 1.5 * W / (2 * fs) * 1000;
        const pick = req => chooseBars({ Mu: 0, Ms: 0, D: h, fck, fy, cover: 50, astMin: req, dEff: f => h / 3, dias: [8, 10, 12] });
        const mL = pick(AsL), mT = pick(AsT);
        const dwR = dw || { dia: 25, len: 360, spacing: 300 };
        const dowelR = (1000 / dwR.spacing) * dwR.len / 1000 * barKgPerM(dwR.dia) / inp.jrcpSpacing;
        const meshKgM2 = kgPerM2(mL.ast + mT.ast);
        const jrcpCost = common + R.sawcut / inp.jrcpSpacing + dowelR * R.msDowel + meshKgM2 * lap * R.steel;
        designs.push({ type: 'JRCP', sb, k, grade: g, h, ...found, dw: dwR, dowelKgM2: dowelR, tie: { dia: 12, spacing: tieSp, len: tieLen }, tieKgM2, mesh: { L: mL, T: mT }, meshKgM2, costM2: jrcpCost, joint: inp.jrcpSpacing });
      }
    }
    if (!designs.length) return failResult('road', 'No slab up to 400 mm passes. Reduce the heaviest axle, improve the subgrade or add DLC.');
    designs.sort((a, b) => a.costM2 - b.costM2);
    const b = designs[0];
    const area = inp.roadWidth * inp.length;
    const rows = [
      boqRow('Subgrade preparation (top 500 mm, ≥ 97% MDD)', area, 'm²', R.subgrade),
      boqRow(`GSB, ${b.sb.gsb} mm`, area * b.sb.gsb / 1000, 'm³', R.gsb),
    ];
    if (b.sb.dlc) rows.push(boqRow(`DLC, ${b.sb.dlc} mm`, area * b.sb.dlc / 1000, 'm³', R.dlc));
    rows.push(boqRow(`PQC ${b.grade}, ${b.h} mm`, area * b.h / 1000, 'm³', R[b.grade]));
    if (b.dowelKgM2) rows.push(boqRow(`Dowel bars ${b.dw.dia} mm × ${b.dw.len} @ ${b.dw.spacing} (plain MS)`, area * b.dowelKgM2, 'kg', R.msDowel));
    if (b.tieKgM2) rows.push(boqRow(`Tie bars 12 mm TMT × ${b.tie.len} @ ${b.tie.spacing}`, area * b.tieKgM2 * lap, 'kg', R.steel));
    if (b.meshKgM2) rows.push(boqRow(`TMT mesh ${barStr(b.mesh.L)} long. / ${barStr(b.mesh.T)} trans.`, area * b.meshKgM2 * lap, 'kg', R.steel));
    rows.push(boqRow('Sawn joints + sealant', area * (1 / b.joint + longJ), 'm', R.sawcut));
    const boq = finishBoq(rows);
    const warnings = [];
    if (inp.cbr < 4 && !(inp.kOverride > 0)) warnings.push(`Subgrade CBR ${inp.cbr}% is weak: replace the top 500 mm with selected soil of CBR ≥ 8% and re-run with CBR 8.`);
    const bestJ = designs.find(d => d.type === 'JPCP'), bestR = designs.find(d => d.type === 'JRCP');
    return {
      ok: true, kind: 'road',
      summary: [
        { label: 'PQC slab', value: `${b.h} mm ${b.grade}` },
        { label: 'Type', value: b.type === 'JPCP' ? 'Plain jointed (JPCP)' : 'Reinforced jointed (JRCP)' },
        { label: 'Joints', value: `${b.joint} m c/c, ${b.dw ? `${b.dw.dia} mm dowels` : 'no dowels (SP:62)'}` },
        { label: 'Sub-base', value: b.sb.label },
        { label: 'Subgrade', value: `CBR ${inp.cbr}% → k ${round(ks, 0)} MPa/m (eff. ${round(b.k, 0)})` },
        { label: 'Estimated cost', value: boq.total, money: true },
      ],
      sections: [
        { title: 'Traffic & stresses', rows: [
          ['Design repetitions (commercial axles)', `${Math.round(Ncum).toLocaleString('en-IN')} over ${inp.years} yr`],
          ['Flexural strength', `${round(b.MR, 2)} MPa (0.7√fck, ${b.grade})`],
          ['Radius of relative stiffness', `${round(b.l, 0)} mm`],
          ['Edge stress — commercial / heaviest', `${round(b.rows[0].se, 2)} / ${round(b.rows[1].se, 2)} MPa`],
          ['Curling stress', `${round(b.st, 2)} MPa (ΔT ${round(b.dT, 1)} °C ${inp.dtOverride > 0 ? 'user-entered' : REGIONS[inp.region].hilly ? 'hill default' : 'IRC 58'}, C = ${round(b.C, 2)})`],
          ['Cumulative fatigue damage', `${round(b.cfd, 3)}`],
        ] },
        { title: 'Reinforcement & joints', rows: [
          ['Dowel bars (transverse joints)', b.dw ? `${b.dw.dia} mm plain MS × ${b.dw.len} mm @ ${b.dw.spacing} mm, debonded one side` : 'Not required for h < 200 mm (IRC SP:62)'],
          ['Tie bars (longitudinal joints)', longJ > 0 ? `12 mm TMT × ${b.tie.len} mm @ ${b.tie.spacing} mm, at mid-depth` : 'Single lane — none'],
          ['Mesh', b.type === 'JRCP' ? `${barStr(b.mesh.L)} longitudinal, ${barStr(b.mesh.T)} transverse, upper third` : 'None (plain slab)'],
          ['Transverse joint spacing', `${b.joint} m`],
          ['Lanes / longitudinal joints', `${nL} / ${nL - 1}`],
        ] },
        { title: 'Foundation layers', rows: [
          ['Sub-base', b.sb.label + (b.sb.dlc ? ' (DLC 7-day ≥ 7 MPa)' : ' (drainage layer)')],
          ['Separation membrane', '125 µm polythene between sub-base and PQC'],
          ['Subgrade', 'Top 500 mm compacted to ≥ 97% MDD (IS 2720-8)'],
        ] },
      ],
      checks: b.checks,
      boq,
      alternatives: [bestJ, bestR].filter(Boolean).concat(bestPerKey(designs, d => d.sb.id + d.type, 6).filter(d => d !== bestJ && d !== bestR)).slice(0, 5).map(d => ({
        label: `${d.type} ${d.h} mm ${d.grade}`, detail: d.sb.label + (d.type === 'JRCP' ? `, mesh ${barStr(d.mesh.L)}` : ''), cost: Math.round(d.costM2 * area), best: d === b,
      })),
      drawing: {
        type: 'road', h: b.h, gsb: b.sb.gsb, dlc: b.sb.dlc, dw: b.dw, mesh: b.type === 'JRCP', meshBars: b.mesh || null,
        tie: longJ > 0 ? b.tie : null, grade: b.grade, kind: b.type, joint: b.joint, roadWidth: inp.roadWidth, laneWidth: inp.laneWidth,
        nL, k: b.k, cbr: inp.cbr, axle: inp.maxAxle, steel: STEELS[s.steel].label,
      },
      notes: [
        'IRC 58 (2002 method): Westergaard edge/corner stresses, Bradbury curling, fatigue on edge load stress.',
        'JRCP curling computed at 4.5 m effective crack spacing (mesh holds intermediate cracks tight).',
        'Dowel bars are plain mild steel per IRC 58 — not TMT.',
        ...(REGIONS[inp.region].hilly && !(inp.dtOverride > 0) ? ['Hilly region: IRC 58 gives no ΔT for hills, so 18 °C is adopted (Bhimtal default). Enter a measured site ΔT to override; check frost / freeze–thaw exposure.'] : []),
        'Curling often governs: a stiffer support (higher k) raises curling stress, so DLC does not always thin the slab.',
      ],
      warnings,
    };
  }

  // ─────────────────── 4. warehouse floor (TR34) ───────────────────
  const TYRES = { solid: { label: 'Solid rubber', p: 2.0 }, poly: { label: 'Polyurethane', p: 5.0 }, pneumatic: { label: 'Pneumatic', p: 0.8 } };
  // Typical hooked-end fibre residual strengths (EN 14651) vs dosage — replace with supplier data
  const FIBRE = { 20: [2.0, 1.6], 25: [2.5, 2.1], 30: [3.0, 2.6], 35: [3.4, 3.0], 40: [3.8, 3.4] };
  const FLOOR_SUBBASES = [
    { id: 'g150', label: '150 mm GSB', gsb: 150, wmm: 0, dlc: 0, layer: 'gsb150' },
    { id: 'g150w100', label: '100 mm WMM on 150 mm GSB', gsb: 150, wmm: 100, dlc: 0, layer: 'gsb225' },
    { id: 'g150d100', label: '100 mm DLC on 150 mm GSB', gsb: 150, wmm: 0, dlc: 100, layer: 'dlc100' },
  ];
  const FLOOR_PRESETS = {
    cement: { label: 'Cement / bag store (block stacking)', post: 0, plate: 100, x: 300, y: 1000, wheel: 15, tyre: 'poly', udl: 30, line: 0 },
    light: { label: 'Light racking, pallet trucks', post: 30, plate: 100, x: 300, y: 1000, wheel: 25, tyre: 'poly', udl: 20, line: 0 },
    medium: { label: 'Selective racking, 3 t forklift', post: 60, plate: 120, x: 300, y: 1100, wheel: 40, tyre: 'solid', udl: 30, line: 0 },
    heavy: { label: 'High-bay racking, reach trucks', post: 100, plate: 150, x: 300, y: 1100, wheel: 55, tyre: 'poly', udl: 50, line: 0 },
    custom: { label: 'Custom', custom: true },
  };

  function tr34Props(fcu, h) {
    const fck = 0.8 * fcu; // cube → cylinder
    const fctm = 0.3 * Math.pow(fck, 2 / 3);
    const fctk = 0.7 * fctm;
    const fctd = fctk * Math.max(1.6 - h / 1000, 1) / 1.5;
    const Ecm = 22000 * Math.pow((fck + 8) / 10, 0.3);
    return { fck, fctm, fctk, fctd, Ecm, Mn: fctd * h * h / 6 };
  }
  // Meyerhof yield-line capacities (N) — Mp, Mn in N·mm/mm; a, l in mm
  function pointCapacity(loc, Mp, Mn, a, l, x = 0, y = 0) {
    const S = Mp + Mn;
    const at = (aa) => {
      switch (loc) {
        case 'internal': return aa === 0 ? 2 * Math.PI * S : 4 * Math.PI * S / (1 - aa / (3 * l));
        case 'edge': return aa === 0 ? Math.PI * S / 2 + 2 * Mn : (Math.PI * S + 4 * Mn) / (1 - 2 * aa / (3 * l));
        case 'corner': return aa === 0 ? 2 * Mn : 4 * Mn / (1 - aa / l);
        case 'dual': return aa === 0 ? (2 * Math.PI + 1.8 * x / l) * S : (4 * Math.PI / (1 - aa / (3 * l)) + 1.8 * x / (l - aa / 2)) * S;
        case 'quad': return aa === 0 ? (2 * Math.PI + 1.8 * (x + y) / l) * S : (4 * Math.PI / (1 - aa / (3 * l)) + 1.8 * (x + y) / (l - aa / 2)) * S;
      }
      return 0;
    };
    const r = a / l;
    if (r >= 0.2) return at(a);
    const p0 = at(0), p2 = at(0.2 * l);
    return p0 + (p2 - p0) * r / 0.2;
  }

  function designFloor(inp, s) {
    const R = s.rates, lap = 1 + R.lapPct / 100, fy = STEELS[s.steel].fy;
    const ks = inp.kOverride > 0 ? inp.kOverride : kFromCBR(inp.cbr);
    const LT = inp.joint === 'sawn' ? 0.15 : 0;
    const gR = 1.2, gM = 1.6, gU = 1.5;
    const tyreP = TYRES[inp.tyre].p;
    const options = [];
    for (const dia of [8, 10, 12]) for (const sp of [300, 250, 200, 150, 125, 100]) options.push({ type: 'mesh', dia, spacing: sp });
    for (const dose of [20, 25, 30, 35, 40]) options.push({ type: 'fibre', dose });
    for (const dose of [20, 25]) for (const dia of [8, 10]) options.push({ type: 'hybrid', dose, dia, spacing: 200 });
    const subbases = inp.kOverride > 0 ? [FLOOR_SUBBASES[0]] : FLOOR_SUBBASES;

    function evalFloor(h, fcu, k, opt) {
      const pr = tr34Props(fcu, h);
      const kN = k / 1000;
      const l = Math.pow(pr.Ecm * h ** 3 / (12 * (1 - 0.04) * kN), 0.25);
      let Mp = 0, ast = 0, d = 0.75 * h, fR = null;
      if (opt.type !== 'fibre') {
        ast = astPerM(opt.dia, opt.spacing);
        d = h - 40 - opt.dia;
        Mp += 0.95 * ast / 1000 * fy * d / 1.15; // per mm width
      }
      if (opt.type !== 'mesh') {
        fR = FIBRE[opt.dose];
        const sr1 = 0.45 * fR[0], sr4 = 0.37 * fR[1];
        Mp += h * h / 1.5 * (0.29 * sr4 + 0.16 * sr1);
      }
      const Mn = pr.Mn;
      const kd = Math.min(1 + Math.sqrt(200 / d), 2);
      const vmin = 0.035 * kd ** 1.5 * Math.sqrt(pr.fck);
      let vRd = vmin;
      if (ast > 0) vRd = Math.max(0.18 / 1.5 * kd * Math.pow(100 * Math.min(ast / (1000 * d), 0.02) * pr.fck, 1 / 3), vmin);
      if (fR) vRd += 0.015 * 2 * (fR[0] + fR[1]);
      const vmax = 0.5 * 0.6 * (1 - pr.fck / 250) * pr.fck / 1.5;
      const punch = (c, loc) => {
        const u0 = { internal: 4 * c, edge: 3 * c, corner: 2 * c }[loc];
        const u1 = { internal: 4 * c + 4 * Math.PI * d, edge: 3 * c + 2 * Math.PI * d, corner: 2 * c + Math.PI * d }[loc];
        return Math.min(vmax * u0 * d, vRd * u1 * d);
      };
      const checks = [];
      const kN_ = v => v / 1000;
      if (inp.post > 0) {
        const P = inp.post * 1000, c = inp.plate, a = Math.sqrt(c * c / Math.PI);
        checks.push(check('Rack post — internal', kN_(gR * P), kN_(pointCapacity('internal', Mp, Mn, a, l)), 'kN', 'TR34 §7.10'));
        checks.push(check('Rack posts — back-to-back pair', kN_(2 * gR * P), kN_(pointCapacity('dual', Mp, Mn, a, l, inp.x)), 'kN', 'TR34 §7.10'));
        checks.push(check('Rack posts — group of four', kN_(4 * gR * P), kN_(pointCapacity('quad', Mp, Mn, a, l, inp.x, inp.y)), 'kN', 'TR34 §7.10'));
        checks.push(check('Rack post — at joint/edge', kN_(gR * P * (1 - LT)), kN_(pointCapacity('edge', Mp, Mn, a, l)), 'kN', 'TR34 §7.10'));
        if (inp.rackAtCorners) checks.push(check('Rack post — at joint intersection', kN_(gR * P * (1 - LT)), kN_(pointCapacity('corner', Mp, Mn, a, l)), 'kN', 'TR34 §7.10'));
        checks.push(check('Punching — rack post (internal)', kN_(gR * P), kN_(punch(c, 'internal')), 'kN', 'TR34 §7.11'));
        checks.push(check('Punching — rack post (edge)', kN_(gR * P * (1 - LT)), kN_(punch(c, 'edge')), 'kN', 'TR34 §7.11'));
      }
      if (inp.wheel > 0) {
        const W = inp.wheel * 1000, A = W / tyreP, a = Math.sqrt(A / Math.PI), c = Math.sqrt(A);
        checks.push(check('MHE wheel — internal', kN_(gM * W), kN_(pointCapacity('internal', Mp, Mn, a, l)), 'kN', 'TR34 §7.10'));
        checks.push(check('MHE wheel — crossing joint', kN_(gM * W * (1 - LT)), kN_(pointCapacity('edge', Mp, Mn, a, l)), 'kN', 'TR34 §7.10'));
        checks.push(check('Punching — MHE wheel', kN_(gM * W), kN_(punch(c, 'internal')), 'kN', 'TR34 §7.11'));
      }
      if (inp.mezz > 0) {
        const P = inp.mezz * 1000, c = inp.mezzPlate, a = Math.sqrt(c * c / Math.PI);
        checks.push(check('Mezzanine leg — internal', kN_(gU * P), kN_(pointCapacity('internal', Mp, Mn, a, l)), 'kN', 'TR34 §7.10'));
        checks.push(check('Mezzanine leg — punching', kN_(gU * P), kN_(punch(c, 'internal')), 'kN', 'TR34 §7.11'));
      }
      const lam = Math.pow(3 * kN / (pr.Ecm * h ** 3), 0.25); // 1/mm
      if (inp.udl > 0) checks.push(check('Uniform storage load (worst aisle pattern)', gU * inp.udl, 5.95 * lam * lam * Mn * 1000, 'kPa', 'TR34 §7.12'));
      if (inp.line > 0) checks.push(check('Line load (internal)', gU * inp.line, 4 * lam * Mn, 'kN/m', 'TR34 §7.13'));
      if (opt.type !== 'fibre') checks.push(check('Minimum mesh (0.08%)', 0.0008 * 1000 * h, ast, 'mm²/m', 'TR34'));
      return { ok: checks.every(c => c.pass), checks, l, lam, Mp, Mn, pr, d, ast, fR };
    }

    const all = [];
    for (const sb of subbases) {
      const k = inp.kOverride > 0 ? inp.kOverride : effectiveK(ks, sb.layer);
      for (const g of ['M30', 'M35', 'M40']) {
        for (const opt of options) {
          for (const h of range(150, 350, 10)) {
            const r = evalFloor(h, fckOf(g), k, opt);
            if (!r.ok) continue;
            const S = Math.min(6, 30 * h / 1000);
            let reinfCost = 0, steelKgM2 = 0, fibreKgM2 = 0;
            if (opt.type !== 'fibre') steelKgM2 = 2 * kgPerM2(r.ast) * lap; // bottom mesh both ways
            if (inp.topMesh) steelKgM2 += 2 * kgPerM2(astPerM(8, 200)) * lap;
            if (opt.type !== 'mesh') fibreKgM2 = opt.dose * h / 1000;
            reinfCost = steelKgM2 * R.steel + fibreKgM2 * R.fibre;
            const cost = h / 1000 * R[g] + reinfCost + (2 / S) * R.sawcut + (2 / 36) * R.armouredJoint
              + (inp.membrane ? R.membrane : 0) + (inp.hardener ? R.hardener : 0)
              + sb.gsb / 1000 * R.gsb + sb.wmm / 1000 * R.wmm + sb.dlc / 1000 * R.dlc + R.subgrade;
            all.push({ sb, k, grade: g, h, opt, S, steelKgM2, fibreKgM2, costM2: cost, ...r });
            break;
          }
        }
      }
    }
    if (!all.length) return failResult('floor', 'No slab up to 350 mm passes TR34 checks. Reduce loads, enlarge baseplates or improve the subgrade.');
    all.sort((a, b) => a.costM2 - b.costM2);
    const b = all[0], A = inp.area;
    const reinfLabel = o => o.type === 'mesh' ? `TMT mesh ${o.dia} mm @ ${o.spacing} both ways (bottom)`
      : o.type === 'fibre' ? `Steel fibre ${o.dose} kg/m³` : `Fibre ${o.dose} kg/m³ + ${o.dia} mm @ ${o.spacing} mesh`;
    const rows = [
      boqRow('Subgrade preparation', A, 'm²', R.subgrade),
      boqRow(`GSB, ${b.sb.gsb} mm`, A * b.sb.gsb / 1000, 'm³', R.gsb),
    ];
    if (b.sb.wmm) rows.push(boqRow(`WMM, ${b.sb.wmm} mm`, A * b.sb.wmm / 1000, 'm³', R.wmm));
    if (b.sb.dlc) rows.push(boqRow(`DLC, ${b.sb.dlc} mm`, A * b.sb.dlc / 1000, 'm³', R.dlc));
    if (inp.membrane) rows.push(boqRow('Slip membrane, 2 × 125 µm', A, 'm²', R.membrane));
    rows.push(boqRow(`Floor slab ${b.grade}, ${b.h} mm`, A * b.h / 1000, 'm³', R[b.grade]));
    if (b.steelKgM2) rows.push(boqRow(`TMT mesh ${STEELS[s.steel].label} (incl. laps)`, A * b.steelKgM2, 'kg', R.steel));
    if (b.fibreKgM2) rows.push(boqRow(`Steel fibre ${b.opt.dose} kg/m³`, A * b.fibreKgM2, 'kg', R.fibre));
    rows.push(boqRow(`Sawn joints @ ${b.S} m + sealant`, A * 2 / b.S, 'm', R.sawcut));
    rows.push(boqRow('Armoured free-movement joints (≈ 36 m bays)', A * 2 / 36, 'm', R.armouredJoint));
    if (inp.hardener) rows.push(boqRow('Dry-shake surface hardener', A, 'm²', R.hardener));
    const boq = finishBoq(rows);
    const byType = ['mesh', 'fibre', 'hybrid'].map(t => all.find(d => d.opt.type === t)).filter(Boolean);
    const warnings = [];
    if (inp.cbr < 4 && !(inp.kOverride > 0)) warnings.push(`Subgrade CBR ${inp.cbr}% is weak: improve the top 500 mm (CBR ≥ 8%) or confirm k by plate-load test (IS 1888).`);
    return {
      ok: true, kind: 'floor',
      summary: [
        { label: 'Floor slab', value: `${b.h} mm ${b.grade}` },
        { label: 'Reinforcement', value: reinfLabel(b.opt) },
        { label: 'Sawn joints', value: `${b.S} m grid` },
        { label: 'Sub-base', value: b.sb.label },
        { label: 'Modulus k (eff.)', value: `${round(b.k, 0)} MPa/m` },
        { label: 'Estimated cost', value: boq.total, money: true },
      ],
      sections: [
        { title: 'TR34 design values', rows: [
          ['Concrete', `${b.grade} (fck,cyl ≈ ${round(b.pr.fck, 1)} MPa, Ecm ${round(b.pr.Ecm / 1000, 1)} GPa)`],
          ['Moment capacity Mn (hogging, plain)', `${round(b.Mn / 1000, 2)} kNm/m`],
          ['Moment capacity Mp (sagging, reinforced)', `${round(b.Mp / 1000, 2)} kNm/m`],
          ['Radius of relative stiffness', `${round(b.l, 0)} mm`],
          ['Critical aisle width (UDL)', `${round(Math.PI / (2 * b.lam) / 1000, 2)} m`],
          ['Load transfer at sawn joints', LT ? '15%' : 'none (free edge)'],
          ['Rack posts at joint intersections', inp.rackAtCorners ? 'Checked (corner yield line)' : 'Avoided — keep posts ≥ 300 mm off sawn-joint intersections'],
        ] },
        { title: 'Specification', rows: [
          ['Reinforcement', reinfLabel(b.opt) + (b.opt.type !== 'fibre' ? `, ${40} mm bottom cover` : '')],
          ['Top crack-control mesh', inp.topMesh ? '8 mm @ 200 both ways, 40 mm cover' : 'Not provided'],
          ['Joints', `Sawn ${b.S} m × ${b.S} m within 24 h, depth h/4; armoured free-movement joints with plate dowels at ≈ 36 m`],
          ['Sub-base / membrane', `${b.sb.label}${inp.membrane ? ', 2 × 125 µm polythene slip membrane' : ''}`],
          ['Subgrade', 'Top 500 mm compacted to ≥ 97% MDD; verify k by plate-load test (IS 1888)'],
          ['Surface', inp.hardener ? 'Dry-shake hardener, power-floated; flatness per TR34 FM2 (free movement)' : 'Power-floated; flatness per TR34 FM2'],
        ] },
      ],
      checks: b.checks,
      boq,
      alternatives: byType.map(d => ({ label: `${d.h} mm ${d.grade} — ${d.opt.type}`, detail: reinfLabel(d.opt) + ', ' + d.sb.label, cost: Math.round(d.costM2 * A), best: d === b })),
      drawing: {
        type: 'floor', h: b.h, grade: b.grade, gsb: b.sb.gsb, wmm: b.sb.wmm, dlc: b.sb.dlc, opt: b.opt, topMesh: inp.topMesh, S: b.S,
        aisle: inp.aisle, post: inp.post > 0, postLoad: inp.post, plate: inp.plate, x: inp.x, y: inp.y, wheel: inp.wheel,
        tyre: TYRES[inp.tyre].label, udl: inp.udl, k: b.k, membrane: inp.membrane, steel: STEELS[s.steel].label,
      },
      notes: [
        'TR34 (4th ed.) yield-line method; partial factors: racking 1.2, MHE 1.6, UDL/line/mezzanine 1.5.',
        'Fibre residual strengths (fR1, fR4) are typical hooked-end values — confirm with the supplier’s EN 14651 test data.',
        'Mesh: Mp from bottom mesh, Mn from plain concrete (TR34 approach).',
      ],
      warnings,
    };
  }

  return {
    GRADE_LIST, STEELS, EXPOSURE, DEFAULT_RATES, RATE_LABELS, SLAB_LOAD_PRESETS, EDGE_CONDITIONS, SURCHARGE,
    ROAD_PRESETS, REGIONS, FLOOR_PRESETS, TYRES,
    designTankSlab, designDrain, designRoad, designFloor,
    lib: {
      interp, muLimit, astRequired, muCapacity, tauC, slabShearK, crackWidth, ktFactor, chooseBars, evalSlab, optimiseSlab,
      kFromCBR, effectiveK, radiusRelStiff, edgeStress, cornerStress, fatigueN, bradburyC, dowelFor,
      tr34Props, pointCapacity, barKgPerM, astPerM, xuMaxRatio,
    },
  };
});
