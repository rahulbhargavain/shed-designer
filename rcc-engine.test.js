// Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const RCC = require('./rcc-engine.js');
const L = RCC.lib;

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ± ${tol}, got ${a}`);
const settings = { exposure: 'severe', steel: 'Fe500D', rates: RCC.DEFAULT_RATES };

// ── IS 456 section design ──
test('Mu,lim coefficients match IS 456 / SP-16 (0.138, 0.133 fck bd²)', () => {
  near(L.muLimit(20, 415, 1000, 100) / (20 * 1000 * 100 * 100), 0.138, 0.001);
  near(L.muLimit(20, 500, 1000, 100) / (20 * 1000 * 100 * 100), 0.133, 0.001);
});

test('Ast from Annex G matches SP-16 Table 2 (M20/Fe415, Mu/bd² = 1.0 → pt ≈ 0.295%)', () => {
  const ast = L.astRequired(1.0 * 1000 * 200 * 200, 20, 415, 1000, 200);
  near(100 * ast / (1000 * 200), 0.295, 0.002);
});

test('Moment capacity is the inverse of Ast required', () => {
  const Mu = 60e6, ast = L.astRequired(Mu, 30, 500, 1000, 180);
  near(L.muCapacity(ast, 30, 500, 1000, 180), Mu, Mu * 1e-3); // IS 456 rounds 4/0.87 to 4.6
});

test('τc follows IS 456 Table 19 and interpolates', () => {
  near(L.tauC(0.5, 20), 0.48, 1e-9);
  near(L.tauC(1.0, 30), 0.66, 1e-9);
  near(L.tauC(0.625, 25), (0.49 + 0.57) / 2, 1e-9);
  near(L.slabShearK(150), 1.3, 1e-9);
  near(L.slabShearK(300), 1.0, 1e-9);
});

test('Bar weight d²/162', () => {
  near(L.barKgPerM(12), 0.888, 0.001);
  near(L.barKgPerM(16), 1.580, 0.001);
});

test('Crack width rises with bar spacing and service moment', () => {
  const base = { D: 250, d: 199, ast: 754, dia: 12, cover: 45, fck: 30 };
  const w1 = L.crackWidth({ ...base, Ms: 40e6, spacing: 150 }).w;
  const w2 = L.crackWidth({ ...base, Ms: 40e6, spacing: 250 }).w;
  const w3 = L.crackWidth({ ...base, Ms: 60e6, spacing: 150 }).w;
  assert.ok(w2 > w1 && w3 > w1);
  assert.ok(w1 > 0 && w1 < 0.5);
});

test('chooseBars returns the lightest arrangement meeting Mu and min steel', () => {
  const r = L.chooseBars({ Mu: 30e6, Ms: 0, D: 180, fck: 25, fy: 500, cover: 30, astMin: 216, dEff: f => 180 - 30 - f / 2 });
  assert.ok(!r.fail);
  assert.ok(r.MuR >= 30e6);
  assert.ok(r.ast >= r.astReq);
  assert.ok(r.spacing >= 100 && r.spacing <= 300);
});

// ── Pavement / ground ──
test('k from CBR follows IRC 58 table', () => {
  near(L.kFromCBR(5), 42, 1e-9);
  near(L.kFromCBR(10), 55, 1e-9);
  near(L.kFromCBR(6), 45, 1e-9);
});

test('Sub-base raises effective k; DLC more than GSB', () => {
  const ks = 42;
  assert.ok(L.effectiveK(ks, 'gsb150') > ks);
  assert.ok(L.effectiveK(ks, 'dlc150') > L.effectiveK(ks, 'dlc100'));
  assert.ok(L.effectiveK(ks, 'dlc100') > L.effectiveK(ks, 'gsb300'));
});

test('IRC 58 fatigue model: SR < 0.45 unlimited, continuity at 0.55', () => {
  assert.equal(L.fatigueN(0.44), Infinity);
  const a = L.fatigueN(0.5499), b = L.fatigueN(0.5501);
  assert.ok(Math.abs(Math.log10(a) - Math.log10(b)) < 0.05, `${a} vs ${b}`);
  assert.ok(L.fatigueN(0.7) < L.fatigueN(0.6));
});

test('Westergaard edge stress falls with thickness; hand calc at h=300', () => {
  // P=99 kN, p=0.8 MPa, k=0.06 N/mm³ — hand calc ≈ 2.09 MPa
  const P = 99000, a = Math.sqrt(P / (Math.PI * 0.8));
  const l = L.radiusRelStiff(30000, 300, 0.06, 0.15);
  near(L.edgeStress(P, 300, l, a), 2.09, 0.03);
  const l2 = L.radiusRelStiff(30000, 200, 0.06, 0.15);
  assert.ok(L.edgeStress(P, 200, l2, a) > L.edgeStress(P, 300, l, a));
});

test('Bradbury coefficient table end points', () => {
  assert.equal(L.bradburyC(0.8), 0);
  near(L.bradburyC(8), 1.077, 1e-9);
});

test('IRC 58 dowel table', () => {
  assert.equal(L.dowelFor(180), null);
  assert.deepEqual(L.dowelFor(250), { dia: 32, len: 450, spacing: 300 });
});

// ── TR34 ──
test('TR34 UDL capacity hand calc (h=200, M40 cube, k=0.05) ≈ 5.95 λ² Mn', () => {
  const pr = L.tr34Props(40, 200);
  const lam = Math.pow(3 * 0.05 / (pr.Ecm * 200 ** 3), 0.25);
  const w = 5.95 * lam * lam * pr.Mn * 1000;
  assert.ok(w > 40 && w < 75, `UDL ${w} kPa`);
});

test('TR34 point-load capacity: internal > edge > corner; interpolation continuous at a/l = 0.2', () => {
  const Mp = 15000, Mn = 12000, l = 800;
  const ai = L.pointCapacity('internal', Mp, Mn, 80, l);
  assert.ok(ai > L.pointCapacity('edge', Mp, Mn, 80, l));
  assert.ok(L.pointCapacity('edge', Mp, Mn, 80, l) > L.pointCapacity('corner', Mp, Mn, 80, l));
  near(L.pointCapacity('internal', Mp, Mn, 0.1999 * l, l), L.pointCapacity('internal', Mp, Mn, 0.2 * l, l), 200);
  assert.ok(L.pointCapacity('quad', Mp, Mn, 80, l, 300, 1000) > L.pointCapacity('dual', Mp, Mn, 80, l, 300));
});

// ── End-to-end modules ──
const tankBase = { lx: 4, ly: 6, wall: 230, fill: 0.3, soilGamma: 18, finish: 1.5, edge: 'ssr', manhole: 0.6, waterRetaining: true };
const slab = k => { const p = { ...RCC.SLAB_LOAD_PRESETS[k] }; delete p.label; return p; };

test('Tank slab: feasible, all checks pass, IS 3370 rules applied', () => {
  const r = RCC.designTankSlab({ ...tankBase, ...slab('fire') }, settings);
  assert.ok(r.ok, r.error);
  assert.ok(r.checks.every(c => c.pass));
  assert.ok(r.drawing.cover >= 45);
  assert.ok(['M30', 'M35', 'M40'].includes(r.summary[1].value));
  assert.ok(r.boq.total > 0);
  assert.ok(r.alternatives.some(a => a.best && a.cost === r.boq.total));
});

test('Tank slab: heavier live load never gives a thinner or cheaper slab', () => {
  const light = RCC.designTankSlab({ ...tankBase, ...slab('pedestrian') }, settings);
  const heavy = RCC.designTankSlab({ ...tankBase, ...slab('fire') }, settings);
  assert.ok(heavy.drawing.D >= light.drawing.D);
  assert.ok(heavy.boq.total > light.boq.total);
});

test('Drain: walls, base and cover designed; BOQ total equals best alternative', () => {
  const r = RCC.designDrain({ B: 0.6, H: 0.9, length: 100, gamma: 18, phi: 30, sbc: 100, surcharge: 'vehicle', covered: true, ...slab('truck'), unitWidth: 0.6, waterRetaining: false }, settings);
  assert.ok(r.ok, r.error);
  assert.ok(r.checks.every(c => c.pass));
  assert.ok(r.drawing.coverD >= 100);
  assert.equal(r.alternatives.find(a => a.best).cost, Math.round(r.boq.total));
});

test('Drain: deeper drain needs at least as thick a wall', () => {
  const base = { B: 0.6, length: 10, gamma: 18, phi: 30, sbc: 150, surcharge: 'vehicle', covered: false, q: 0, P: 0, a: 0, b: 0, s: 0, impact: 1, unitWidth: 0.6, waterRetaining: false };
  const shallow = RCC.designDrain({ ...base, H: 0.6 }, settings);
  const deep = RCC.designDrain({ ...base, H: 1.8 }, settings);
  assert.ok(shallow.ok && deep.ok);
  assert.ok(deep.drawing.tw >= shallow.drawing.tw);
});

const roadBase = { cbr: 6, kOverride: 0, years: 20, growth: 5, ldf: 0.5, tyre: 0.8, lsf: 1.1, region: 'central', laneWidth: 3.5, roadWidth: 7, length: 500, jointSpacing: 4.5, jrcpSpacing: 12 };
const rp = k => { const p = { ...RCC.ROAD_PRESETS[k] }; delete p.label; return p; };

test('Road: both JPCP and JRCP compared; recommended is cheapest', () => {
  const r = RCC.designRoad({ ...roadBase, ...rp('campus') }, settings);
  assert.ok(r.ok, r.error);
  assert.ok(r.checks.every(c => c.pass));
  assert.ok(r.alternatives.some(a => a.label.startsWith('JPCP')));
  assert.ok(r.alternatives.some(a => a.label.startsWith('JRCP')));
  const best = r.alternatives.find(a => a.best);
  assert.ok(r.alternatives.every(a => a.cost >= best.cost));
  assert.ok(r.drawing.h >= 150 && r.drawing.h <= 400);
});

test('Road: heavier axle never cheaper; weak subgrade flagged', () => {
  // Note: a softer subgrade can legitimately reduce Bradbury curling stress (larger l),
  // so cost is not asserted monotonic in CBR — only the improvement warning.
  const ref = RCC.designRoad({ ...roadBase, ...rp('campus') }, settings);
  const weak = RCC.designRoad({ ...roadBase, ...rp('campus'), cbr: 3, kOverride: 0 }, settings);
  const heavy = RCC.designRoad({ ...roadBase, ...rp('campus'), maxAxle: 160 }, settings);
  assert.ok(heavy.boq.total >= ref.boq.total);
  assert.ok(weak.ok && weak.warnings.some(w => /CBR/.test(w)));
  assert.equal(ref.warnings.length, 0);
});

const floorBase = { cbr: 6, kOverride: 0, joint: 'sawn', rackAtCorners: false, mezz: 0, mezzPlate: 150, area: 2000, topMesh: true, membrane: true, hardener: true, aisle: 3 };
const fp = k => { const p = { ...RCC.FLOOR_PRESETS[k] }; delete p.label; return p; };

test('Floor: mesh, fibre and hybrid compared; all TR34 checks pass', () => {
  const r = RCC.designFloor({ ...floorBase, ...fp('medium') }, settings);
  assert.ok(r.ok, r.error);
  assert.ok(r.checks.every(c => c.pass));
  const types = r.alternatives.map(a => a.label.split('— ')[1]);
  assert.deepEqual(types.sort(), ['fibre', 'hybrid', 'mesh']);
});

test('Floor: heavier racking or corner check never makes the floor cheaper', () => {
  const med = RCC.designFloor({ ...floorBase, ...fp('medium') }, settings);
  const heavy = RCC.designFloor({ ...floorBase, ...fp('heavy') }, settings);
  const corners = RCC.designFloor({ ...floorBase, ...fp('medium'), rackAtCorners: true }, settings);
  assert.ok(heavy.boq.total >= med.boq.total);
  assert.ok(corners.boq.total >= med.boq.total);
});

test('All modules run fast enough for live recalculation (< 500 ms total)', () => {
  const t = Date.now();
  RCC.designTankSlab({ ...tankBase, ...slab('fire') }, settings);
  RCC.designDrain({ B: 0.6, H: 0.9, length: 100, gamma: 18, phi: 30, sbc: 100, surcharge: 'vehicle', covered: true, ...slab('truck'), unitWidth: 0.6, waterRetaining: false }, settings);
  RCC.designRoad({ ...roadBase, ...rp('campus') }, settings);
  RCC.designFloor({ ...floorBase, ...fp('heavy') }, settings);
  assert.ok(Date.now() - t < 500);
});

test('Road: hilly region (Bhimtal) defaults to ΔT 18 °C; ΔT override drives curling', () => {
  const hill = RCC.designRoad({ ...roadBase, ...rp('campus'), region: 'hilly', dtOverride: 0 }, settings);
  const site18 = RCC.designRoad({ ...roadBase, ...rp('campus'), region: 'hilly', dtOverride: 18 }, settings);
  assert.ok(hill.ok);
  assert.equal(hill.boq.total, site18.boq.total);
  assert.ok(hill.sections[0].rows.some(r => /ΔT 18 °C hill default/.test(r[1])));
  const hot = RCC.designRoad({ ...roadBase, ...rp('campus'), region: 'hilly', dtOverride: 22 }, settings);
  assert.ok(hot.boq.total >= site18.boq.total);
});

test('Minimum thickness options: road hMin and drain tbMin / twMin / toe are honoured', () => {
  const road = RCC.designRoad({ ...roadBase, ...rp('campus'), hMin: 280 }, settings);
  assert.ok(road.ok && road.drawing.h >= 280);
  const base = { B: 0.45, H: 0.6, length: 10, gamma: 18, phi: 30, sbc: 100, surcharge: 'vehicle', covered: true, ...slab('fire'), unitWidth: 0.6, waterRetaining: false };
  const d0 = RCC.designDrain(base, settings);
  const d1 = RCC.designDrain({ ...base, tbMin: 175, twMin: 175, toe: 100 }, settings);
  assert.ok(d0.ok && d1.ok);
  assert.ok(d1.drawing.tb >= 175 && d1.drawing.tw >= 175 && d1.drawing.toe === 100);
  const bear = r => r.checks.find(c => /Bearing/.test(c.name)).util;
  assert.ok(bear(d1) < bear(d0));
});
