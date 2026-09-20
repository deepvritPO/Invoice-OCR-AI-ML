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
