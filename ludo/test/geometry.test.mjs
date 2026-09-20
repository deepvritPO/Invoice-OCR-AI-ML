// Geometry suite — derived from SPEC.md sections 1 and 2 only.
// Checks the 5x13 = 65 ring, the progress coordinate, the safe-cell set and
// that the pre-computed `layout` is a physically sane board.
import test from 'node:test';
import assert from 'node:assert/strict';

import * as G from '../js/geometry.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Every ring cell plus every home-column cell, as plain points. */
function allCells() {
  const cells = G.layout.ring.map((c, i) => ({ id: `ring${i}`, x: c.x, y: c.y }));
  for (let p = 0; p < G.PLAYERS; p++) {
    for (let s = 0; s < G.HOME_COLUMN; s++) {
      const h = G.layout.homes[p][s];
      cells.push({ id: `home${p}.${s}`, x: h.x, y: h.y });
    }
  }
  return cells;
}

test('board constants match the 5-player generalisation', () => {
  assert.equal(G.PLAYERS, 5);
  assert.equal(G.ARM_CELLS, 13);
  assert.equal(G.RING, 65);
  assert.equal(G.RING, G.PLAYERS * G.ARM_CELLS);
  assert.equal(G.HOME_COLUMN, 5);
  assert.equal(G.HOME_STEP, 70);
  assert.equal(G.MAX_TOKENS, 4);
});

test('COLORS has one complete entry per player', () => {
  assert.equal(G.COLORS.length, G.PLAYERS);
  const ids = new Set();
  for (const c of G.COLORS) {
    for (const key of ['id', 'name', 'hex', 'dark', 'light', 'text']) {
      assert.ok(c[key] !== undefined && c[key] !== null, `COLORS entry missing ${key}`);
    }
    assert.match(String(c.hex), /^#[0-9a-f]{3,8}$/i, 'hex must be a CSS hex colour');
    ids.add(c.id);
  }
  assert.equal(ids.size, G.PLAYERS, 'colour ids must be unique');
});

test('startIndex / entryIndex use the 13p+7 and 13p+6 offsets', () => {
  for (let p = 0; p < G.PLAYERS; p++) {
    assert.equal(G.startIndex(p), 13 * p + 7);
    assert.equal(G.entryIndex(p), 13 * p + 6);
    // entry is exactly one cell "behind" the start, going backwards round the ring
    assert.equal((G.entryIndex(p) + 1) % G.RING, G.startIndex(p));
  }
});

test('SAFE_CELLS is exactly {13k+2, 13k+7}', () => {
  const expected = new Set();
  for (let k = 0; k < G.PLAYERS; k++) {
    expected.add(13 * k + 2);
    expected.add(13 * k + 7);
  }
  assert.equal(G.SAFE_CELLS.size, 10);
  assert.deepEqual([...G.SAFE_CELLS].sort((a, b) => a - b), [...expected].sort((a, b) => a - b));
  for (let i = 0; i < G.RING; i++) {
    assert.equal(G.isSafe(i), expected.has(i), `isSafe(${i}) disagrees with the safe set`);
  }
  // every start cell is safe, no tip is safe
  for (let p = 0; p < G.PLAYERS; p++) {
    assert.equal(G.isSafe(G.startIndex(p)), true, `start of player ${p} must be safe`);
    assert.equal(G.isSafe(G.entryIndex(p)), false, 'tips are not safe');
  }
});

test('layout has the shape the renderer relies on', () => {
  assert.equal(G.layout.size, 1000);
  assert.equal(G.layout.viewBox, '0 0 1000 1000');
  assert.deepEqual(G.layout.center, { x: 500, y: 500 });
  assert.ok(G.layout.cell > 0, 'cell edge length must be positive');

  assert.equal(G.layout.ring.length, G.RING);
  assert.equal(G.layout.homes.length, G.PLAYERS);
  assert.equal(G.layout.bases.length, G.PLAYERS);
  assert.equal(G.layout.armOutlines.length, G.PLAYERS);
  assert.equal(G.layout.goalSlots.length, G.PLAYERS);
  assert.equal(G.layout.goal.wedges.length, G.PLAYERS);

  for (let p = 0; p < G.PLAYERS; p++) {
    assert.equal(G.layout.homes[p].length, G.HOME_COLUMN);
    G.layout.homes[p].forEach((h, s) => assert.equal(h.step, s, 'home cells carry their step'));
    assert.equal(G.layout.bases[p].slots.length, G.MAX_TOKENS);
    assert.equal(G.layout.bases[p].p, p);
    assert.equal(G.layout.goalSlots[p].length, G.MAX_TOKENS);
    assert.ok(typeof G.layout.goal.wedges[p].d === 'string' && G.layout.goal.wedges[p].d.length > 0);
    assert.ok(typeof G.layout.armOutlines[p].d === 'string' && G.layout.armOutlines[p].d.length > 0);
  }

  G.layout.ring.forEach((c, i) => {
    assert.equal(c.index, i, 'ring entries are index-ordered');
    assert.equal(c.arm, Math.floor(i / G.ARM_CELLS), 'ring cell knows its arm');
    assert.equal(c.tip, i % G.ARM_CELLS === 6, 'tip flag marks 13i+6');
    assert.equal(c.safe, G.SAFE_CELLS.has(i), 'safe flag mirrors SAFE_CELLS');
    assert.equal(typeof c.rot, 'number');
    const owner = [0, 1, 2, 3, 4].find((p) => G.startIndex(p) === i);
    assert.equal(c.startFor, owner === undefined ? null : owner, `startFor wrong at ring ${i}`);
  });
});

test('the ring is continuous, including the 64 -> 0 wrap', () => {
  const w = G.layout.cell;
  for (let i = 0; i < G.RING; i++) {
    const a = G.layout.ring[i];
    const b = G.layout.ring[(i + 1) % G.RING];
    const d = dist(a, b);
    assert.ok(d <= 1.6 * w, `ring ${i} -> ${(i + 1) % G.RING} is ${d.toFixed(1)}, more than 1.6 cells apart`);
    assert.ok(d >= 0.9 * w, `ring ${i} -> ${(i + 1) % G.RING} is ${d.toFixed(1)}, closer than 0.9 cells`);
  }
  // the wrap specifically: 13*4+12 = 64 must neighbour 0
  const wrap = dist(G.layout.ring[64], G.layout.ring[0]);
  assert.ok(wrap <= 1.6 * w, `wrap 64 -> 0 is ${wrap.toFixed(1)}`);
});

test('no two cell centres are closer than 0.9 cell widths', () => {
  const cells = allCells();
  const min = 0.9 * G.layout.cell;
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const d = dist(cells[i], cells[j]);
      assert.ok(d >= min, `${cells[i].id} and ${cells[j].id} overlap (${d.toFixed(2)} < ${min.toFixed(2)})`);
    }
  }
});

test('every drawn element sits inside the viewBox', () => {
  const size = G.layout.size;
  const half = G.layout.cell / 2;
  const inside = (pt, pad, what) => {
    assert.ok(Number.isFinite(pt.x) && Number.isFinite(pt.y), `${what} is not a finite point`);
    assert.ok(pt.x - pad >= -0.5 && pt.x + pad <= size + 0.5, `${what} escapes horizontally (${pt.x})`);
    assert.ok(pt.y - pad >= -0.5 && pt.y + pad <= size + 0.5, `${what} escapes vertically (${pt.y})`);
  };
  G.layout.ring.forEach((c, i) => inside(c, half, `ring cell ${i}`));
  for (let p = 0; p < G.PLAYERS; p++) {
    G.layout.homes[p].forEach((h, s) => inside(h, half, `home ${p}.${s}`));
    const base = G.layout.bases[p];
    inside(base, base.r, `base ${p}`);
    base.slots.forEach((s, i) => inside(s, 0, `base slot ${p}.${i}`));
    G.layout.goalSlots[p].forEach((s, i) => inside(s, 0, `goal slot ${p}.${i}`));
  }
  inside(G.layout.goal, G.layout.goal.r, 'goal disc');
});

test('progressToCell covers the ring regime, including the wrap', () => {
  for (let p = 0; p < G.PLAYERS; p++) {
    for (let t = 0; t <= 64; t++) {
      const cell = G.progressToCell(p, t);
      assert.equal(cell.kind, 'ring', `p${p} t${t} should be a ring cell`);
      assert.equal(cell.index, (G.startIndex(p) + t) % G.RING, `p${p} t${t} maps to the wrong ring index`);
      assert.ok(cell.index >= 0 && cell.index < G.RING);
    }
    // t = 0 is the start cell, and the wrap regime is exercised whenever
    // startIndex(p) + t >= 65
    assert.equal(G.progressToCell(p, 0).index, G.startIndex(p));
    const wrapT = G.RING - G.startIndex(p); // first t whose raw sum exceeds 64
    assert.equal(G.progressToCell(p, wrapT).index, 0, `p${p} should wrap to ring 0 at t=${wrapT}`);
  }
});

test('64 steps from the start lands on the player own entry tip', () => {
  for (let p = 0; p < G.PLAYERS; p++) {
    assert.equal(G.progressToCell(p, 64).kind, 'ring');
    assert.equal(G.progressToCell(p, 64).index, G.entryIndex(p));
  }
});

test('progressToCell covers the home-column and goal regimes', () => {
  for (let p = 0; p < G.PLAYERS; p++) {
    for (let t = 65; t <= 69; t++) {
      const cell = G.progressToCell(p, t);
      assert.equal(cell.kind, 'home', `p${p} t${t} should be a home cell`);
      assert.equal(cell.index, t - 65);
    }
    const goal = G.progressToCell(p, G.HOME_STEP);
    assert.equal(goal.kind, 'goal');
  }
});

test('cellCenter is defined for every t and agrees with layout', () => {
  const eps = 1e-6;
  for (let p = 0; p < G.PLAYERS; p++) {
    for (let t = 0; t <= G.HOME_STEP; t++) {
      const c = G.cellCenter(p, t);
      assert.ok(c && Number.isFinite(c.x) && Number.isFinite(c.y), `cellCenter(${p},${t}) is not a point`);
      const cell = G.progressToCell(p, t);
      if (cell.kind === 'ring') {
        const ref = G.layout.ring[cell.index];
        assert.ok(dist(c, ref) < eps, `cellCenter(${p},${t}) != layout.ring[${cell.index}]`);
      } else if (cell.kind === 'home') {
        const ref = G.layout.homes[p][cell.index];
        assert.ok(dist(c, ref) < eps, `cellCenter(${p},${t}) != layout.homes[${p}][${cell.index}]`);
      } else {
        // the goal is the centre disc; per-player parking spots live inside it
        assert.ok(dist(c, G.layout.goal) <= G.layout.goal.r + G.layout.cell,
          `cellCenter(${p},70) is outside the goal disc`);
      }
    }
  }
});

test('baseSlot returns the four parking spots of each base', () => {
  for (let p = 0; p < G.PLAYERS; p++) {
    for (let slot = 0; slot < G.MAX_TOKENS; slot++) {
      const pt = G.baseSlot(p, slot);
      assert.ok(pt && Number.isFinite(pt.x) && Number.isFinite(pt.y), `baseSlot(${p},${slot}) is not a point`);
      const ref = G.layout.bases[p].slots[slot];
      assert.ok(dist(pt, ref) < 1e-6, `baseSlot(${p},${slot}) disagrees with layout.bases`);
      assert.ok(dist(pt, G.layout.bases[p]) <= G.layout.bases[p].r + 1e-6,
        `baseSlot(${p},${slot}) is outside its own base`);
    }
  }
});

test('geometry is pure: repeated calls return identical values', () => {
  const a = G.cellCenter(2, 33);
  const b = G.cellCenter(2, 33);
  assert.deepEqual(a, b);
  assert.deepEqual(G.progressToCell(3, 17), G.progressToCell(3, 17));
});

// ---------------------------------------------------------------------------
// Arm-frame regressions.
//
// These exist because the board once shipped with a seven-slot middle column and
// only six occupants: the tip was pushed one extra pitch out, so every arm had a
// cell-sized hole in its innermost row and the home run never reached the goal.
// ---------------------------------------------------------------------------

const D2R = Math.PI / 180;
const armAngle = (p) => (-90 + p * 72) * D2R;

/** Board point -> the arm-local (u = outward along the axis, v = across) frame. */
function localOf(pt, p) {
  const a = armAngle(p);
  const dx = pt.x - G.layout.center.x;
  const dy = pt.y - G.layout.center.y;
  return { u: dx * Math.cos(a) + dy * Math.sin(a), v: -dx * Math.sin(a) + dy * Math.cos(a) };
}

/**
 * The four board-space corners of a cell. A cell is axis-aligned in its OWN arm's
 * frame, so the corner offsets have to be rotated by that arm's angle — not by any
 * other arm's.
 */
function cornersOf(pt, arm) {
  const a = armAngle(arm);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const h = G.layout.cell / 2;
  return [[-h, -h], [-h, h], [h, -h], [h, h]].map(([du, dv]) => ({
    x: pt.x + du * cos - dv * sin,
    y: pt.y + du * sin + dv * cos,
  }));
}

/**
 * The goal is a regular pentagon with its vertices on the arm axes, so its apothem is
 * r * cos36 and the outward normal of the edge between vertex p and vertex p+1 points
 * along armAngle(p) + 36deg. A point is inside iff it is inside all five edges.
 */
function insideGoal(pt, slack = 0) {
  const { x: cx, y: cy } = G.layout.center;
  const apothem = G.layout.goal.r * Math.cos(36 * D2R);
  for (let p = 0; p < G.PLAYERS; p++) {
    const n = armAngle(p) + 36 * D2R;
    const d = (pt.x - cx) * Math.cos(n) + (pt.y - cy) * Math.sin(n);
    if (d > apothem - slack) return false;
  }
  return true;
}

/** Distance from a point to the goal pentagon's boundary, positive when inside. */
function goalClearance(pt) {
  const { x: cx, y: cy } = G.layout.center;
  const apothem = G.layout.goal.r * Math.cos(36 * D2R);
  let worst = Infinity;
  for (let p = 0; p < G.PLAYERS; p++) {
    const n = armAngle(p) + 36 * D2R;
    worst = Math.min(worst, apothem - ((pt.x - cx) * Math.cos(n) + (pt.y - cy) * Math.sin(n)));
  }
  return worst;
}

test('every arm cell sits on one of the six radial rows, in the right column', () => {
  const cell = G.layout.cell;
  for (let p = 0; p < G.PLAYERS; p++) {
    // The outward ring column defines the six rows u1..u6.
    const rows = [];
    for (let j = 0; j <= 5; j++) {
      const { u, v } = localOf(G.layout.ring[13 * p + j], p);
      assert.ok(v < -0.5 * cell, `ring ${13 * p + j} should be the -v column, got v=${v.toFixed(2)}`);
      rows.push(u);
    }
    for (let k = 1; k < rows.length; k++) {
      const gap = rows[k] - rows[k - 1];
      assert.ok(gap > 0.9 * cell && gap < 1.25 * cell,
        `arm ${p} row ${k} is ${gap.toFixed(2)} from row ${k - 1}: not one pitch`);
    }
    // The inward ring column reuses the same six rows, walking back down.
    for (let j = 7; j <= 12; j++) {
      const { u, v } = localOf(G.layout.ring[13 * p + j], p);
      assert.ok(v > 0.5 * cell, `ring ${13 * p + j} should be the +v column`);
      assert.ok(Math.abs(u - rows[12 - j]) < 1e-6,
        `ring ${13 * p + j} is off the row grid (u=${u.toFixed(2)})`);
    }
  }
});

test('the middle column has no empty radial slot between the tip and the goal', () => {
  const cell = G.layout.cell;
  for (let p = 0; p < G.PLAYERS; p++) {
    // Rows u1..u6, read off the outward ring column of this same arm.
    const rows = Array.from({ length: 6 }, (_, j) => localOf(G.layout.ring[13 * p + j], p).u);

    // Occupants of the middle column, innermost first: home 4..0 then the tip.
    const column = [];
    for (let s = G.HOME_COLUMN - 1; s >= 0; s--) column.push({ id: `home${p}.${s}`, pt: G.layout.homes[p][s] });
    column.push({ id: `tip${p}`, pt: G.layout.ring[G.entryIndex(p)] });

    assert.equal(column.length, rows.length,
      `arm ${p}: ${rows.length} radial rows but ${column.length} middle-column cells`);

    column.forEach((occ, k) => {
      const { u, v } = localOf(occ.pt, p);
      assert.ok(Math.abs(v) < 1e-6, `${occ.id} is not on the arm axis (v=${v.toFixed(2)})`);
      assert.ok(Math.abs(u - rows[k]) < 1e-6,
        `${occ.id} sits at u=${u.toFixed(2)} but row ${k + 1} is at ${rows[k].toFixed(2)} — empty slot`);
    });

    // Belt and braces: no two consecutive occupants are more than one pitch apart.
    for (let k = 1; k < column.length; k++) {
      const gap = localOf(column[k].pt, p).u - localOf(column[k - 1].pt, p).u;
      assert.ok(gap < 1.25 * cell,
        `arm ${p}: ${column[k - 1].id} -> ${column[k].id} is ${gap.toFixed(2)}, a slot wide enough to hold a cell`);
    }
  }
});

test('the innermost home cell docks against the goal pentagon vertex', () => {
  const cell = G.layout.cell;
  for (let p = 0; p < G.PLAYERS; p++) {
    const inner = G.layout.homes[p][G.HOME_COLUMN - 1];
    const edge = localOf(inner, p).u - cell / 2; // inner edge of the last home cell
    const gap = edge - G.layout.goal.r;          // the pentagon vertex lies on this axis
    assert.ok(gap > 0, `p${p}: the goal wedge bites ${(-gap).toFixed(2)} into the last home cell`);
    // A whole cell of clearance means a missing row; even half a cell reads as a
    // corridor of bare board between the home run and the goal. It has to be a gutter.
    assert.ok(gap < 0.5 * cell,
      `p${p}: ${gap.toFixed(2)} (${(gap / cell).toFixed(2)} cell) of empty board between the last home cell and the goal — a corridor`);
  }
});

test('the goal wedge never overlaps a ring or home cell', () => {
  const cells = [
    ...G.layout.ring.map((c, i) => [`ring${i}`, c, c.arm]),
    ...G.layout.homes.flatMap((col, q) => col.map((h, s) => [`home${q}.${s}`, h, q])),
  ];
  for (const [id, c, arm] of cells) {
    for (const corner of cornersOf(c, arm)) {
      assert.equal(insideGoal(corner, 1e-9), false, `${id} has a corner inside the goal pentagon`);
    }
  }
});

test('TOKEN_HIT_R gives a tap target bigger than the disc but inside the cell pitch', () => {
  // The whole point of the hit area: it must be meaningfully larger than what is
  // painted. The visible disc is 0.36 * cell (render.js).
  const discR = G.layout.cell * 0.36;
  assert.ok(G.TOKEN_HIT_R > discR * 1.3,
    `hit radius ${G.TOKEN_HIT_R} is barely bigger than the disc ${discR.toFixed(2)}`);
  assert.equal(G.layout.tokenHitR, G.TOKEN_HIT_R, 'layout must expose the same value');

  // ...and it must not reach into a neighbouring cell, or a dense corner of the
  // board mis-taps. The bound is half the closest distance between two DISTINCT
  // cells, re-derived here from `layout` rather than copied from geometry.js.
  const cells = allCells();
  let closest = Infinity;
  let pair = null;
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const d = dist(cells[i], cells[j]);
      if (d < closest) { closest = d; pair = [cells[i].id, cells[j].id]; }
    }
  }
  assert.ok(G.TOKEN_HIT_R <= closest / 2,
    `hit radius ${G.TOKEN_HIT_R} overlaps ${pair && pair.join(' / ')} (${closest.toFixed(2)} apart)`);
});

test('no two cells hit areas overlap, base slots included', () => {
  // Every anchor a token can occupy on a cell or in a base, at the scale the
  // renderer draws it there. Goal slots are excluded on purpose: those four spots
  // share one wedge, they are not neighbouring cells, and a token parked at the
  // goal can never be played — render.js shrinks its target back to the disc.
  const anchors = allCells().map((c) => ({ ...c, r: G.TOKEN_HIT_R }));
  for (let p = 0; p < G.PLAYERS; p++) {
    for (let slot = 0; slot < 4; slot++) {
      const { x, y } = G.baseSlot(p, slot);
      anchors.push({ id: `base${p}.${slot}`, x, y, r: G.TOKEN_HIT_R });
    }
  }
  for (let i = 0; i < anchors.length; i++) {
    for (let j = i + 1; j < anchors.length; j++) {
      const gap = dist(anchors[i], anchors[j]) - anchors[i].r - anchors[j].r;
      assert.ok(gap >= 0,
        `${anchors[i].id} and ${anchors[j].id} overlap by ${(-gap).toFixed(2)} board units`);
    }
  }
});

test('four parked tokens fit inside a goal wedge', () => {
  // render.js draws a goal token at tokenR = 0.36*cell with a 0.16*tokenR stroke, then
  // scales the group by GOAL_SCALE = 0.72 -> outer radius 0.28 * cell.
  const R = 0.28 * G.layout.cell;
  for (let p = 0; p < G.PLAYERS; p++) {
    const slots = G.layout.goalSlots[p];
    slots.forEach((s, i) => {
      assert.ok(goalClearance(s) >= R,
        `goal slot ${p}.${i} has ${goalClearance(s).toFixed(2)} clearance, needs ${R.toFixed(2)}`);
    });
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        assert.ok(dist(slots[i], slots[j]) >= 2 * R,
          `goal slots ${p}.${i} and ${p}.${j} overlap (${dist(slots[i], slots[j]).toFixed(2)} < ${(2 * R).toFixed(2)})`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Seat palette: colour-vision separation, ink contrast, and agreement with the
// stylesheet.
//
// The palette used to be chosen by hue alone and claimed in a comment to be
// "separable under deuteranopia"; it was not — Jade/Orchid collapsed to deltaE76
// 14.2 under deutan and Cobalt/Orchid to 23.8 under protan. These tests pin the
// claim down numerically.
// ---------------------------------------------------------------------------

const CVD_THRESHOLD = 25; // deltaE76 below this is a documented confusion risk
const INK_CONTRAST = 4.5; // WCAG AA for the numerals drawn on a seat colour

const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const matmul = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);

const SRGB_TO_XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.0721750],
  [0.0193339, 0.1191920, 0.9503041],
];
// Hunt-Pointer-Estevez LMS, normalised to D65 (Viénot, Brettel & Mollon 1999)
const RGB_TO_LMS = [
  [0.31399022, 0.63951294, 0.04649755],
  [0.15537241, 0.75789446, 0.08670142],
  [0.01775239, 0.10944209, 0.87256922],
];
const LMS_TO_RGB = [
  [5.47221206, -4.6419601, 0.16963708],
  [-1.1252419, 2.29317094, -0.1678952],
  [0.02980165, -0.19318073, 1.16364789],
];
const DICHROMAT = {
  protan: [[0, 1.05118294, -0.05116099], [0, 1, 0], [0, 0, 1]],
  deutan: [[1, 0, 0], [0.9513092, 0, 0.04866992], [0, 0, 1]],
};

/** Linear-sRGB as seen by a dichromat (or as-is for `normal`). */
function simulate(hex, kind) {
  const rgb = hex2rgb(hex).map(toLinear);
  if (kind === 'normal') return rgb;
  return matmul(LMS_TO_RGB, matmul(DICHROMAT[kind], matmul(RGB_TO_LMS, rgb)))
    .map((c) => Math.max(0, Math.min(1, c)));
}

const D65 = [0.95047, 1.0, 1.08883];
const labF = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
function toLab(linearRGB) {
  const f = matmul(SRGB_TO_XYZ, linearRGB).map((v, i) => labF(v / D65[i]));
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}
const deltaE76 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const relLuminance = (hex) => {
  const [r, g, b] = hex2rgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrastRatio = (a, b) => {
  const x = relLuminance(a);
  const y = relLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

for (const variant of ['hex', 'dark']) {
  test(`the ${variant === 'hex' ? 'light' : 'dark'}-theme seat hues survive deuteranopia and protanopia`, () => {
    const hexes = G.COLORS.map((c) => c[variant]);
    for (const kind of ['normal', 'deutan', 'protan']) {
      const labs = hexes.map((h) => toLab(simulate(h, kind)));
      for (let i = 0; i < labs.length; i++) {
        for (let j = i + 1; j < labs.length; j++) {
          const d = deltaE76(labs[i], labs[j]);
          assert.ok(d >= CVD_THRESHOLD,
            `${kind}: ${G.COLORS[i].name}/${G.COLORS[j].name} deltaE76 ${d.toFixed(1)} < ${CVD_THRESHOLD}`);
        }
      }
    }
  });
}

test('seat ink clears 4.5:1 on both variants of its own seat', () => {
  for (const c of G.COLORS) {
    for (const variant of ['hex', 'dark']) {
      const ratio = contrastRatio(c.text, c[variant]);
      assert.ok(ratio >= INK_CONTRAST,
        `${c.name} ink ${c.text} on ${c[variant]} is ${ratio.toFixed(2)}:1, below ${INK_CONTRAST}:1`);
    }
  }
});

test('COLORS agrees exactly with the --p0..--p4 and --p-ink in css/styles.css', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const css = readFileSync(fileURLToPath(new URL('../css/styles.css', import.meta.url)), 'utf8');

  /** The text of the first `{...}` block whose selector line contains `selector`. */
  function blockAfter(selector) {
    const at = css.indexOf(selector);
    assert.ok(at >= 0, `css/styles.css has no ${selector} rule`);
    const open = css.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
    }
    throw new Error(`unterminated block for ${selector}`);
  }
  const seatVars = (block) =>
    Array.from({ length: G.PLAYERS }, (_, i) => {
      const m = block.match(new RegExp(`--p${i}\\s*:\\s*(#[0-9a-fA-F]{3,8})`));
      assert.ok(m, `--p${i} is missing from the block`);
      return m[1].toLowerCase();
    });

  assert.deepEqual(seatVars(blockAfter(':root {')), G.COLORS.map((c) => c.hex.toLowerCase()),
    'light --p0..--p4 must equal COLORS[].hex');
  assert.deepEqual(seatVars(blockAfter(':root:not([data-theme="light"])')), G.COLORS.map((c) => c.dark.toLowerCase()),
    'the prefers-color-scheme dark --p0..--p4 must equal COLORS[].dark');
  assert.deepEqual(seatVars(blockAfter(':root[data-theme="dark"]')), G.COLORS.map((c) => c.dark.toLowerCase()),
    'the [data-theme="dark"] --p0..--p4 must equal COLORS[].dark');

  G.COLORS.forEach((c, i) => {
    const m = css.match(new RegExp(`\\.p${i}\\s*\\{[^}]*--p-ink\\s*:\\s*(#[0-9a-fA-F]{3,8})`));
    assert.ok(m, `.p${i} does not declare --p-ink`);
    assert.equal(m[1].toLowerCase(), c.text.toLowerCase(), `.p${i} --p-ink must equal COLORS[${i}].text`);
    const pi = css.match(new RegExp(`\\.p${i}\\s*\\{[^}]*--player-ink\\s*:\\s*(#[0-9a-fA-F]{3,8})`));
    assert.ok(pi, `.p${i} does not declare --player-ink`);
    assert.equal(pi[1].toLowerCase(), c.text.toLowerCase(), `.p${i} --player-ink must equal COLORS[${i}].text`);
  });
});
