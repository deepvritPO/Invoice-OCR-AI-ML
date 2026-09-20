/**
 * geometry.js — pentagon Ludo board maths.
 *
 * Classic Ludo is a cross of 4 arms x 13 cells; this is the 5-arm generalisation:
 * 5 arms x 13 = 65 ring cells, each arm rotated by -90deg + i*72deg about (500,500).
 *
 * Everything is built once, at module load, from a handful of constants expressed as
 * multiples of the cell edge. Pure and deterministic: no Math.random, no Date, no DOM.
 */

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const PLAYERS = 5;
export const ARM_CELLS = 13;
export const RING = PLAYERS * ARM_CELLS; // 65
export const HOME_COLUMN = 5;
export const HOME_STEP = 70; // t value that means "in the goal"
export const MAX_TOKENS = 4;

/**
 * Seat palette. These are the same five hues css/styles.css paints as --p0..--p4,
 * and `text` matches --player-ink there. Keep the two in step: a seat's name must
 * describe the colour a player sees.
 *
 * The five hues are spread on lightness as well as hue, so that every pair stays
 * above deltaE76 = 25 under simulated deuteranopia AND protanopia, in both themes
 * (worst pair: 33.7 light / 38.6 dark deutan, 31.9 light / 30.8 dark protan — see
 * test/geometry.test.mjs). `text` clears 4.5:1 against both the light and the dark
 * variant of its own seat. Tritanopia is NOT solved by hue alone (Jade/Sky collapse):
 * seats need a redundant non-colour channel for that.
 */
export const COLORS = [
  { id: 'amber', name: 'Amber', hex: '#ce8d1b', dark: '#fbac23', light: '#fecf95', text: '#2d2419' },
  { id: 'cobalt', name: 'Cobalt', hex: '#0f4cb8', dark: '#3369e0', light: '#d4d4ff', text: '#ffffff' },
  { id: 'jade', name: 'Jade', hex: '#1ba98b', dark: '#0fb694', light: '#a6e4d1', text: '#0d2a23' },
  { id: 'crimson', name: 'Crimson', hex: '#b0332f', dark: '#d23a3a', light: '#feccc4', text: '#ffffff' },
  { id: 'sky', name: 'Sky', hex: '#4babea', dark: '#79b6e8', light: '#b6dbfe', text: '#16242f' },
];

/** Ring indices that never capture: every start cell plus the star 8 steps ahead of it. */
export const SAFE_CELLS = new Set(
  Array.from({ length: PLAYERS }, (_, k) => [ARM_CELLS * k + 2, ARM_CELLS * k + 7]).flat()
);

// ---------------------------------------------------------------------------
// Board constants (board units; the viewBox is 1000 x 1000)
// ---------------------------------------------------------------------------

const SIZE = 1000;
const CX = SIZE / 2;
const CY = SIZE / 2;

const CELL = 46; // cell edge length — every other length is a multiple of this

const PITCH = 1.08 * CELL; // centre-to-centre spacing along an arm (u direction)
const HALF_W = 1.06 * CELL; // |v| of the two ring columns; the home column sits at v = 0

const ARM_SWEEP_DEG = 360 / PLAYERS; // 72
const ARM_BASE_DEG = -90; // arm 0 points straight up
const HALF_WEDGE_DEG = ARM_SWEEP_DEG / 2; // 36 — half the angular slice owned by one arm

const DEG = Math.PI / 180;

/**
 * Wrap distance we aim for between cell 13i+12 (u1, +w) and cell 13(i+1)+0 (u1, -w).
 * It has to be large enough that the two squares — rotated 72deg apart — cannot overlap.
 * Two squares of edge C separated by d along a direction that projects onto their axes
 * with factor cos(18deg) need d * cos(18deg) > C/2 * (1 + cos18 + sin18), i.e. d > 1.40 * C.
 */
const TARGET_WRAP = 1.45 * CELL;

/**
 * Circumradius of the central pentagon (vertices on the arm axes). The vertex has to
 * dock against the innermost home cell without biting into it, so the hard ceiling is
 * U[1] - CELL/2 = 2.19 * CELL; 2.10 leaves a 4.25-unit gutter, the same order as the
 * 3.68-unit gutter between two ordinary cells.
 */
const GOAL_R = 2.10 * CELL;
const ARM_PAD = 0.76 * CELL; // how far the decorative arm plate sits outside a cell centre
const TIP_PAD = 1.42 * CELL; // how far the plate's prow sits beyond the outermost cell centre

const BASE_ANGLE_DEG = 31; // base sits this far from arm p's axis, towards arm p+1
const BASE_R = 7.8 * CELL; // distance of the base plate centre from the board centre
const BASE_PLATE_R = 2.0 * CELL; // radius of the base plate
const BASE_SLOT_OFF = 0.44 * BASE_PLATE_R; // 2x2 parking grid inside the plate

// ---------------------------------------------------------------------------
// Frame helpers: every piece of the board is authored in an arm-local frame
// (u = outward along the arm axis, v = perpendicular) and then rotated + translated.
// ---------------------------------------------------------------------------

/** Rotation of arm `arm`, in degrees, normalised to (-180, 180]. */
function armRotation(arm) {
  const deg = ((ARM_BASE_DEG + arm * ARM_SWEEP_DEG) % 360 + 540) % 360 - 180;
  return deg === -180 ? 180 : deg;
}

function armAngle(arm) {
  return (ARM_BASE_DEG + arm * ARM_SWEEP_DEG) * DEG;
}

/** (u, v) in arm-local units -> board coordinates, plus the rotation a cell should carry. */
function place(u, v, arm) {
  const a = armAngle(arm);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return { x: CX + u * cos - v * sin, y: CY + u * sin + v * cos, rot: armRotation(arm) };
}

/** Polar point around the board centre (angle in radians, measured like armAngle). */
function polar(radius, angle) {
  return { x: CX + radius * Math.cos(angle), y: CY + radius * Math.sin(angle) };
}

const round2 = (n) => Math.round(n * 100) / 100;

function pathOf(points) {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${round2(p.x)} ${round2(p.y)}`).join(' ') + ' Z';
}

// ---------------------------------------------------------------------------
// Solving the innermost radius
// ---------------------------------------------------------------------------

/**
 * Distance between the last cell of one arm (u1, +w) and the first cell of the next
 * arm (u1, -w). Both sit at radius hypot(u1, w); their angular separation is
 * 72deg - 2*atan(w/u1), so the chord is 2 * r * sin(36deg - atan(w/u1)).
 * Strictly increasing in u1, so a bisection is enough.
 */
function wrapDistance(u1) {
  const r = Math.hypot(u1, HALF_W);
  const phi = Math.atan2(HALF_W, u1);
  return 2 * r * Math.sin(HALF_WEDGE_DEG * DEG - phi);
}

function solveInnerRadius(target) {
  let lo = HALF_W; // wrapDistance(HALF_W) is negative: the arms would overlap
  let hi = HALF_W * 12; // comfortably past the target
  for (let i = 0; i < 90; i++) {
    const mid = (lo + hi) / 2;
    if (wrapDistance(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const U1 = solveInnerRadius(TARGET_WRAP);

/**
 * u[k] for k = 1..6: the six radial rows of an arm. u[0] is unused.
 * All three of an arm's columns use the same six rows — the two ring columns run
 * U[1]..U[6], and the middle column is the five home cells U[1]..U[5] capped by the
 * tip at U[6]. That is what makes an arm a solid 6 x 3 block with no empty slot.
 */
const U = [0, U1];
for (let k = 2; k <= 6; k++) U[k] = U[k - 1] + PITCH;

// ---------------------------------------------------------------------------
// Ring, home columns, goal, bases, arm plates
// ---------------------------------------------------------------------------

function buildRing() {
  const cells = [];
  for (let arm = 0; arm < PLAYERS; arm++) {
    for (let j = 0; j < ARM_CELLS; j++) {
      const index = arm * ARM_CELLS + j;
      let u;
      let v;
      if (j <= 5) {
        u = U[1 + j]; // outward column
        v = -HALF_W;
      } else if (j === 6) {
        u = U[6]; // tip — outermost row, between the two ring columns
        v = 0;
      } else {
        u = U[13 - j]; // inward column, back from U[6] down to U[1]
        v = HALF_W;
      }
      const { x, y, rot } = place(u, v, arm);
      cells.push({
        index,
        x,
        y,
        rot,
        arm,
        safe: SAFE_CELLS.has(index),
        tip: j === 6,
        startFor: j === 7 ? arm : null,
      });
    }
  }
  return cells;
}

function buildHomes() {
  const homes = [];
  for (let p = 0; p < PLAYERS; p++) {
    const column = [];
    for (let step = 0; step < HOME_COLUMN; step++) {
      // step 0 is the outermost home cell (u5, just inside the tip), step 4 the
      // innermost (u1), whose inner edge docks against the goal pentagon's vertex
      const { x, y, rot } = place(U[5 - step], 0, p);
      column.push({ x, y, rot, step });
    }
    homes.push(column);
  }
  return homes;
}

/**
 * The goal is a regular pentagon whose vertices lie on the five arm axes, so each
 * player's wedge is a kite that points straight down their home column.
 */
function buildGoal() {
  const midR = GOAL_R * Math.cos(HALF_WEDGE_DEG * DEG);
  const vertex = (p) => polar(GOAL_R, armAngle(p));
  const edgeMid = (p, side) => polar(midR, armAngle(p) + side * HALF_WEDGE_DEG * DEG);

  const wedges = [];
  const centroids = [];
  for (let p = 0; p < PLAYERS; p++) {
    const pts = [{ x: CX, y: CY }, edgeMid(p, -1), vertex(p), edgeMid(p, 1)];
    wedges.push({ p, d: pathOf(pts) });
    // The kite is two equal triangles mirrored about the axis, so the area centroid
    // is the mean of both triangle centroids: (2*O + M- + M+ + 2*V) / 6.
    centroids.push({
      x: (2 * CX + pts[1].x + pts[3].x + 2 * pts[2].x) / 6,
      y: (2 * CY + pts[1].y + pts[3].y + 2 * pts[2].y) / 6,
    });
  }
  return { goal: { x: CX, y: CY, r: GOAL_R, wedges }, centroids, midR };
}

/** Four parking spots inside player p's goal wedge, authored in the arm-local frame. */
function buildGoalSlots() {
  // A 2 x 2 grid, chosen to maximise the clearance of a goal-sized token (radius
  // 0.28 * CELL once render.js has applied GOAL_SCALE) from the wedge's two flanks,
  // its outer edge, and from the other three tokens.
  const rows = [
    { u: 0.44 * GOAL_R, v: 0.14 * GOAL_R },
    { u: 0.72 * GOAL_R, v: 0.14 * GOAL_R },
  ];
  return Array.from({ length: PLAYERS }, (_, p) =>
    rows.flatMap(({ u, v }) => [place(u, -v, p), place(u, v, p)]).map(({ x, y }) => ({ x, y }))
  );
}

function buildBases(ring) {
  const offset = BASE_ANGLE_DEG * DEG;
  return Array.from({ length: PLAYERS }, (_, p) => {
    const a = armAngle(p) + offset;
    const cx = CX + BASE_R * Math.cos(a);
    const cy = CY + BASE_R * Math.sin(a);
    // Local axes of the plate: radial and tangential, so the 2x2 grid looks upright.
    const rx = Math.cos(a);
    const ry = Math.sin(a);
    const tx = -Math.sin(a);
    const ty = Math.cos(a);
    const s = BASE_SLOT_OFF;
    const slots = [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ].map(([dr, dt]) => ({ x: cx + s * (dr * rx + dt * tx), y: cy + s * (dr * ry + dt * ty) }));

    // Connector from the plate rim to the edge of this player's start cell.
    const start = ring[startIndex(p)];
    const dx = start.x - cx;
    const dy = start.y - cy;
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    return {
      p,
      x: cx,
      y: cy,
      r: BASE_PLATE_R,
      slots,
      gateFrom: { x: cx + ux * BASE_PLATE_R, y: cy + uy * BASE_PLATE_R },
      gateTo: { x: start.x - ux * (CELL * 0.5), y: start.y - uy * (CELL * 0.5) },
    };
  });
}

/**
 * Decorative plate under each arm. The two inner flanks run along a ray from the board
 * centre at `rayDeg`, chosen strictly between the outermost cell-corner angle and the
 * 36deg wedge boundary: that guarantees the plate swallows every cell corner (a ray
 * through the origin at a larger angle passes outside a point of smaller angle) while
 * never crossing into the neighbouring arm's wedge.
 */
function buildArmOutlines(midR) {
  const cornerDeg = Math.atan2(HALF_W + CELL / 2, U1 - CELL / 2) / DEG;
  const rayDeg = (cornerDeg + HALF_WEDGE_DEG) / 2;
  const rayTan = Math.tan(rayDeg * DEG);
  const flankV = HALF_W + ARM_PAD;
  const flankU = flankV / rayTan; // where the ray reaches the plate's full half-width
  const notchU = midR * Math.cos(rayDeg * DEG);
  const notchV = midR * Math.sin(rayDeg * DEG);

  return Array.from({ length: PLAYERS }, (_, p) => {
    const local = [
      [GOAL_R, 0], // mates with the goal pentagon's vertex on this arm's axis
      [notchU, -notchV],
      [flankU, -flankV],
      [U[6] + ARM_PAD, -flankV],
      [U[6] + TIP_PAD, 0], // the prow of the arm, past the full-width outermost row
      [U[6] + ARM_PAD, flankV],
      [flankU, flankV],
      [notchU, notchV],
    ];
    return { p, d: pathOf(local.map(([u, v]) => place(u, v, p))) };
  });
}

const ring = buildRing();
const homes = buildHomes();
const { goal, centroids: goalCentroids, midR: goalMidR } = buildGoal();
const goalSlots = buildGoalSlots();
const bases = buildBases(ring);
const armOutlines = buildArmOutlines(goalMidR);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** First cell of arm p's inward column — where a token leaves the base. */
export function startIndex(p) {
  return ARM_CELLS * p + 7;
}

/** Arm p's tip: the last ring cell a token of player p stands on before its home column. */
export function entryIndex(p) {
  return ARM_CELLS * p + 6;
}

export function isSafe(ringIndex) {
  return SAFE_CELLS.has(ringIndex);
}

const clampProgress = (t) => (t < 0 ? 0 : t > HOME_STEP ? HOME_STEP : t | 0);

/** Map a player's progress 0..70 onto a concrete board cell. */
export function progressToCell(p, t) {
  const step = clampProgress(t);
  if (step === HOME_STEP) return { kind: 'goal' };
  if (step >= RING) return { kind: 'home', index: step - RING };
  return { kind: 'ring', index: (startIndex(p) + step) % RING };
}

/** Board-unit centre of whatever cell progress `t` puts player p on (goal included). */
export function cellCenter(p, t) {
  const cell = progressToCell(p, t);
  if (cell.kind === 'goal') return { ...goalCentroids[p] };
  if (cell.kind === 'home') {
    const { x, y } = homes[p][cell.index];
    return { x, y };
  }
  const { x, y } = ring[cell.index];
  return { x, y };
}

/** Parking spot `slot` (0..3) inside player p's base. */
export function baseSlot(p, slot) {
  const spots = bases[p].slots;
  const { x, y } = spots[((slot % spots.length) + spots.length) % spots.length];
  return { x, y };
}

export const layout = Object.freeze({
  size: SIZE,
  viewBox: `0 0 ${SIZE} ${SIZE}`,
  center: { x: CX, y: CY },
  cell: CELL,
  ring,
  homes,
  bases,
  goal,
  armOutlines,
  goalSlots,
});
