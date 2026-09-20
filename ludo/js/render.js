/**
 * render.js — SVG drawing + animation for pentagon Ludo.
 *
 * Owns everything inside <svg id="board">: six layer groups drawn once by mount(),
 * then a pool of <g class="token"> nodes kept in step with the engine state by sync().
 *
 * Colour policy: no hex value is ever written into the DOM. Every coloured element
 * carries the class "p0".."p4" and, as a stylesheet-overridable fallback, a
 * presentation attribute referencing the custom property var(--p0)..var(--p4).
 * Presentation attributes lose to any CSS rule, so css/styles.css stays in charge.
 */

import { PLAYERS, TOKEN_HIT_R, layout, cellCenter, baseSlot, progressToCell } from './geometry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const LAYERS = ['layer-plates', 'layer-cells', 'layer-bases', 'layer-goal', 'layer-tokens', 'layer-fx'];

const HOP_MS = 90; // time for one cell-to-cell hop
const CAPTURE_MS = 540;
const RIPPLE_MS = 520;
const DICE_TUMBLE_MS = 560;

/**
 * Pace multiplier applied to every duration above. setSpeed() scales the clock and
 * nothing else — no branch below reads it, so an animation cannot change which cells
 * a token visits, and 0 ("Instant") simply makes animate() jump to its final frame.
 */
const MIN_SPEED = 0;
const MAX_SPEED = 1;
const DICE_FRAMES = [3, 6, 2, 5, 1, 4, 6, 2]; // deterministic tumble, no Math.random

/** Pip positions as [column, row] on a 3x3 grid, classic die faces. */
const PIPS = {
  1: [[1, 1]],
  2: [[0, 0], [2, 2]],
  3: [[0, 0], [1, 1], [2, 2]],
  4: [[0, 0], [2, 0], [0, 2], [2, 2]],
  5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
  6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
};

const GOAL_SCALE = 0.72; // a token at full size overhangs the goal wedge's edge

const DEG = Math.PI / 180;
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

/** Symmetric ease-in-out (quadratic) — gentle start and stop on every hop. */
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

function el(tag, attrs, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  if (parent) parent.appendChild(node);
  return node;
}

/** Point `back` units short of `to`, along the line from `from`. */
function pullBack(from, to, back) {
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const k = Math.max(0, len - back) / len;
  return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
}

function transformOf(x, y, scale = 1, rot = 0) {
  let t = `translate(${r2(x)} ${r2(y)})`;
  if (rot) t += ` rotate(${r2(rot)})`;
  if (scale !== 1) t += ` scale(${r3(scale)})`;
  return t;
}

/** Path for a regular star centred on the origin, first point straight up. */
function starPath(outerR, innerR, points = 5) {
  const step = 180 / points;
  const coords = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = (-90 + i * step) * DEG;
    coords.push(`${r2(r * Math.cos(a))} ${r2(r * Math.sin(a))}`);
  }
  return `M${coords.join(' L')} Z`;
}

/** Outline of the central goal pentagon — vertices sit on the five arm axes. */
function goalRimPath() {
  const { x, y, r } = layout.goal;
  const coords = Array.from({ length: PLAYERS }, (_, p) => {
    const a = (-90 + p * (360 / PLAYERS)) * DEG;
    return `${r2(x + r * Math.cos(a))} ${r2(y + r * Math.sin(a))}`;
  });
  return `M${coords.join(' L')} Z`;
}

function reducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

export function createRenderer(svgEl, opts = {}) {
  const doc = svgEl.ownerDocument || document;
  const cell = layout.cell;
  const tokenR = cell * 0.36;
  const shadowId = 'ludo-token-shadow';

  /** id -> {group, label} */
  const tokens = new Map();
  /** cell key -> count chip shown when several tokens share that cell */
  const badges = new Map();
  /** id -> {x, y, scale} — where each token currently sits on screen. */
  const positions = new Map();
  const layers = new Map();
  /** rAF ids with a frame still scheduled. Bounded by the number of live animations. */
  const liveFrames = new Set();
  /** Resolvers of animate() promises that have not settled yet. */
  const pending = new Set();

  /**
   * Accessibility view of the board, kept here so sync(), pulseTokens(), clearPulse()
   * and relabel() can never disagree about a token's movability.
   *   movable   — ids the active player may move right now
   *   pickPhase — a human is being asked to choose one of them
   *   humanSeat — the player id whose tokens this browser's user owns, or null
   */
  const a11y = { movable: new Set(), pickPhase: false, humanSeat: null };
  /** Token id holding the single tab stop outside the pick phase (roving tabindex). */
  let rovingId = null;

  /** The most recent state handed to sync(); label refreshes read it. */
  let lastState = null;

  /** Pace multiplier: 1 = Normal, 1/3 = Fast, 0 = Instant. See setSpeed(). */
  let speed = 1;
  const dur = (ms) => ms * speed;

  let animChain = Promise.resolve();
  let diceChain = Promise.resolve();
  let diceValue = null;
  let diceBtn = null;
  let diceFaceEl = null;
  let disposed = false;

  // -------------------------------------------------------------------------
  // rAF plumbing
  // -------------------------------------------------------------------------

  /** Run `step(progress)` every frame for `duration` ms; always ends on step(1). */
  function animate(duration, step) {
    if (disposed || duration <= 0) {
      step(1);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let startTs = null;
      let frameId = 0;
      const settle = () => { pending.delete(settle); resolve(); };
      const tick = (ts) => {
        liveFrames.delete(frameId); // this frame has fired; it can no longer be cancelled
        if (disposed) {
          settle();
          return;
        }
        if (startTs === null) startTs = ts;
        const p = clamp((ts - startTs) / duration, 0, 1);
        step(p);
        if (p < 1) {
          frameId = requestAnimationFrame(tick);
          liveFrames.add(frameId);
        } else {
          settle();
        }
      };
      frameId = requestAnimationFrame(tick);
      liveFrames.add(frameId);
      pending.add(settle);
    });
  }

  /**
   * Stop every animation in flight. Cancelling a frame alone would wedge the caller,
   * because the awaited promise from animate() would never settle — so settle them all.
   */
  function cancelAnimations() {
    for (const id of liveFrames) cancelAnimationFrame(id);
    liveFrames.clear();
    for (const settle of [...pending]) settle();
    pending.clear();
  }

  /** Board animations never overlap: each one waits for the previous to settle. */
  function serialise(run) {
    const next = animChain.then(run, run);
    animChain = next.catch(() => {});
    return next;
  }

  // -------------------------------------------------------------------------
  // Static board
  // -------------------------------------------------------------------------

  function buildDefs() {
    const defs = el('defs', {}, svgEl);
    const filter = el('filter', { id: shadowId, x: '-40%', y: '-40%', width: '180%', height: '180%' }, defs);
    // No flood-color: the default (black) keeps the shadow theme-neutral.
    el('feDropShadow', { dx: 0, dy: cell * 0.05, stdDeviation: cell * 0.055, 'flood-opacity': 0.3 }, filter);
  }

  function buildPlates(layer) {
    el('rect', {
      class: 'board-bg', x: 0, y: 0, width: layout.size, height: layout.size,
      rx: cell * 0.8, fill: 'none',
    }, layer);
    for (const arm of layout.armOutlines) {
      el('path', {
        class: `arm-plate p${arm.p}`, 'data-player': arm.p, d: arm.d,
        fill: `var(--p${arm.p})`, 'fill-opacity': 0.09,
        stroke: `var(--p${arm.p})`, 'stroke-opacity': 0.26,
        'stroke-width': 2, 'stroke-linejoin': 'round',
      }, layer);
    }
  }

  function addFace(parent, player, fillOpacity, strokeOpacity) {
    el('rect', {
      class: `cell-face p${player}`,
      x: r2(-cell / 2), y: r2(-cell / 2), width: cell, height: cell, rx: r2(cell * 0.22),
      fill: `var(--p${player})`, 'fill-opacity': fillOpacity,
      stroke: `var(--p${player})`, 'stroke-opacity': strokeOpacity, 'stroke-width': 1.6,
    }, parent);
  }

  function addStar(parent, player, onSolid) {
    el('path', {
      class: `cell-star p${player}`,
      d: starPath(cell * 0.27, cell * 0.115),
      // On a start cell the face is already saturated, so the star is punched out in white.
      fill: onSolid ? 'var(--p-ink, white)' : `var(--p${player})`,
      'fill-opacity': onSolid ? 0.92 : 0.5,
    }, parent);
  }

  /**
   * Chevron inside a tip cell pointing at the owner's home column. The cell's local
   * +x axis runs outward along the arm, so "inward" is -x.
   */
  function addTipChevron(parent, player) {
    const a = cell * 0.17;
    el('path', {
      class: `cell-arrow p${player}`,
      d: `M${r2(a)} ${r2(-a * 1.15)} L${r2(-a * 0.85)} 0 L${r2(a)} ${r2(a * 1.15)}`,
      fill: 'none', stroke: `var(--p${player})`, 'stroke-opacity': 0.9,
      'stroke-width': r2(cell * 0.11), 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }, parent);
  }

  function buildCells(layer) {
    for (const ringCell of layout.ring) {
      const isStart = ringCell.startFor !== null;
      const classes = ['cell', `p${ringCell.arm}`];
      if (ringCell.safe) classes.push('cell--safe');
      if (ringCell.tip) classes.push('cell--tip');
      if (isStart) classes.push('cell--start');
      const g = el('g', {
        class: classes.join(' '),
        'data-ring': ringCell.index,
        'data-player': isStart ? ringCell.startFor : null,
        transform: transformOf(ringCell.x, ringCell.y, 1, ringCell.rot),
      }, layer);
      addFace(g, ringCell.arm, isStart ? 0.95 : ringCell.tip ? 0.2 : 0.13, isStart ? 0.95 : 0.34);
      if (ringCell.safe) addStar(g, ringCell.arm, isStart);
      if (ringCell.tip) addTipChevron(g, ringCell.arm);
    }

    for (let p = 0; p < PLAYERS; p++) {
      for (const home of layout.homes[p]) {
        const g = el('g', {
          class: `cell cell--home p${p}`,
          'data-player': p,
          'data-step': home.step,
          transform: transformOf(home.x, home.y, 1, home.rot),
        }, layer);
        // Opacity ramps up towards the centre so the run-in reads as a gradient.
        addFace(g, p, r3(0.3 + home.step * 0.11), 0.52);
      }
    }
  }

  function buildBases(layer) {
    for (const base of layout.bases) {
      const g = el('g', { class: `base p${base.p}`, 'data-player': base.p }, layer);
      const gateEnd = pullBack(base.gateFrom, base.gateTo, cell * 0.24);
      el('path', {
        class: `base-gate p${base.p}`,
        d: `M${r2(base.gateFrom.x)} ${r2(base.gateFrom.y)} L${r2(gateEnd.x)} ${r2(gateEnd.y)}`,
        fill: 'none', stroke: `var(--p${base.p})`, 'stroke-opacity': 0.4,
        'stroke-width': r2(cell * 0.42), 'stroke-linecap': 'round',
      }, g);
      el('circle', {
        class: `base-plate p${base.p}`, cx: r2(base.x), cy: r2(base.y), r: r2(base.r),
        fill: `var(--p${base.p})`, 'fill-opacity': 0.2,
        stroke: `var(--p${base.p})`, 'stroke-opacity': 0.62, 'stroke-width': 2.5,
      }, g);
      const wellR = Math.min(
        base.r * 0.94,
        Math.max(...base.slots.map((s) => Math.hypot(s.x - base.x, s.y - base.y))) + tokenR * 1.3
      );
      el('circle', {
        class: `base-well p${base.p}`, cx: r2(base.x), cy: r2(base.y), r: r2(wellR),
        fill: `var(--p${base.p})`, 'fill-opacity': 0.1,
        stroke: `var(--p${base.p})`, 'stroke-opacity': 0.32, 'stroke-width': 1.4,
      }, g);
      for (const slot of base.slots) {
        el('circle', {
          class: `base-slot p${base.p}`, cx: r2(slot.x), cy: r2(slot.y), r: r2(tokenR * 0.92),
          fill: `var(--p${base.p})`, 'fill-opacity': 0.26,
          stroke: `var(--p${base.p})`, 'stroke-opacity': 0.5, 'stroke-width': 1.4,
        }, g);
      }
    }
  }

  function buildGoal(layer) {
    const g = el('g', { class: 'goal' }, layer);
    for (const wedge of layout.goal.wedges) {
      el('path', {
        class: `goal-wedge p${wedge.p}`, 'data-player': wedge.p, d: wedge.d,
        fill: `var(--p${wedge.p})`, 'fill-opacity': 0.6,
        stroke: `var(--p${wedge.p})`, 'stroke-opacity': 0.9,
        'stroke-width': 1.5, 'stroke-linejoin': 'round',
      }, g);
    }
    el('path', {
      class: 'goal-rim', d: goalRimPath(), fill: 'none',
      stroke: 'currentColor', 'stroke-opacity': 0.35, 'stroke-width': 3, 'stroke-linejoin': 'round',
    }, g);
    const star = el('path', {
      class: 'goal-star', d: starPath(layout.goal.r * 0.22, layout.goal.r * 0.095),
      fill: 'var(--p-ink, white)', 'fill-opacity': 0.9,
    }, g);
    star.setAttribute('transform', transformOf(layout.goal.x, layout.goal.y));
  }

  function mount() {
    clearBoard();
    svgEl.setAttribute('viewBox', layout.viewBox);
    if (!svgEl.getAttribute('role')) svgEl.setAttribute('role', 'img');
    if (!svgEl.getAttribute('aria-label')) svgEl.setAttribute('aria-label', 'Ludo board');
    buildDefs();
    for (const id of LAYERS) layers.set(id, el('g', { id }, svgEl));
    buildPlates(layers.get('layer-plates'));
    buildCells(layers.get('layer-cells'));
    buildBases(layers.get('layer-bases'));
    buildGoal(layers.get('layer-goal'));
    svgEl.addEventListener('click', handleClick);
    svgEl.addEventListener('keydown', handleKeyDown);
    svgEl.addEventListener('focusin', handleFocusIn);
    if (opts.onCellHover) {
      svgEl.addEventListener('pointerover', handleHover);
      svgEl.addEventListener('pointerout', handleHover);
    }
  }

  // -------------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------------

  function createTokenNode(token, player) {
    const group = el('g', {
      class: `token p${player.id}`,
      'data-token-id': token.id,
      'data-player': player.id,
      // Roving tabindex: applyTabStops() promotes exactly one token (or, during a
      // human's pick, every movable one). Twenty permanent tab stops is not usable.
      tabindex: -1,
      role: 'img',
    }, layers.get('layer-tokens'));
    // Invisible tap target, drawn first so it sits behind the disc. The visible disc
    // is only ~12 CSS px across on a phone; this circle is sized in BOARD units, so it
    // scales with the viewBox and with the group's own scale when tokens stack.
    // pointer-events:all is explicit — a `fill: none` from a future stylesheet rule
    // would otherwise make the whole target untappable.
    el('circle', {
      class: 'token-hit', cx: 0, cy: 0, r: r2(TOKEN_HIT_R),
      fill: 'transparent', 'pointer-events': 'all',
    }, group);
    el('circle', {
      class: `token-disc p${player.id}`, cx: 0, cy: 0, r: r2(tokenR),
      fill: `var(--p${player.id})`, stroke: 'var(--p-ink, white)', 'stroke-opacity': 0.85,
      'stroke-width': r2(tokenR * 0.16), filter: `url(#${shadowId})`,
    }, group);
    el('circle', {
      class: 'token-gloss', cx: 0, cy: r2(-tokenR * 0.3), r: r2(tokenR * 0.44),
      fill: 'var(--p-ink, white)', 'fill-opacity': 0.2,
    }, group);
    const label = el('text', {
      class: `token-label p${player.id}`, x: 0, y: 0,
      'text-anchor': 'middle', 'dominant-baseline': 'central',
      'font-family': 'inherit', 'font-size': r2(tokenR * 0.95), 'font-weight': 700,
      fill: 'var(--p-ink, white)', 'pointer-events': 'none',
    }, group);
    const node = { group, label, hit: group.querySelector('.token-hit') };
    tokens.set(token.id, node);
    return node;
  }

  /**
   * Count chip for a shared cell. It is parked on the cell's upper-right diagonal,
   * which the fan always leaves free because every fan starts straight up.
   */
  function setBadge(key, at, count, player) {
    let badge = badges.get(key);
    if (!badge) {
      const group = el('g', { class: 'token-badge', 'data-cell': key }, layers.get('layer-tokens'));
      const w = tokenR * 1.24;
      const h = tokenR * 0.82;
      const dot = el('rect', {
        class: 'token-badge-chip',
        x: r2(-w / 2), y: r2(-h / 2), width: r2(w), height: r2(h), rx: r2(h / 2),
        stroke: 'var(--p-ink, white)', 'stroke-width': 1.8,
      }, group);
      const text = el('text', {
        class: 'token-badge-count', x: 0, y: 0,
        'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-family': 'inherit', 'font-size': r2(tokenR * 0.56), 'font-weight': 700,
        fill: 'var(--p-ink, white)', 'pointer-events': 'none',
      }, group);
      badge = { group, dot, text };
      badges.set(key, badge);
    }
    const d = tokenR * 1.5 * Math.SQRT1_2;
    badge.group.setAttribute('transform', transformOf(at.x + d, at.y - d));
    badge.group.setAttribute('class', `token-badge p${player}`);
    badge.dot.setAttribute('fill', `var(--p${player})`);
    badge.text.textContent = String(count);
    layers.get('layer-tokens').appendChild(badge.group); // chips draw above the discs
    return badge;
  }

  /** 1-based number shown on a token, derived from its stable index. */
  function tokenNumber(token) {
    return (indexOf(token) % 4) + 1;
  }

  function indexOf(token) {
    if (Number.isInteger(token.index)) return token.index;
    const match = /t(\d+)$/.exec(token.id || '');
    return match ? Math.max(0, Number(match[1]) - 1) : 0;
  }

  /** Where a token sits, plus the key of the cell it shares with others (null = private slot). */
  function spotOf(player, token) {
    if (token.place === 'base') return { ...baseSlot(player.id, indexOf(token)), key: null, at: 'base' };
    if (token.place === 'goal') {
      const slots = layout.goalSlots[player.id];
      const slot = slots[indexOf(token) % slots.length];
      return { x: slot.x, y: slot.y, key: null, at: 'goal', scale: GOAL_SCALE };
    }
    const cellRef = progressToCell(player.id, token.t);
    const point = cellCenter(player.id, token.t);
    const key = cellRef.kind === 'ring' ? `r${cellRef.index}`
      : cellRef.kind === 'home' ? `h${player.id}.${cellRef.index}` : null;
    return { x: point.x, y: point.y, key, at: cellRef.kind === 'home' ? 'home' : 'track' };
  }

  function describe(player, token, number) {
    const where = token.place === 'base' ? 'in base'
      : token.place === 'goal' ? 'home'
        : `${token.t} steps along`;
    const head = `${player.name} token ${number}, ${where}`;
    // Movability is otherwise signalled only by a coloured stroke and a pulse, which
    // is nothing at all to a screen reader.
    if (!a11y.pickPhase || !ownedByUser(player.id)) return head;
    return a11y.movable.has(token.id) ? `${head}, ready to move` : `${head}, cannot move this turn`;
  }

  const ownedByUser = (playerId) => a11y.humanSeat !== null && playerId === a11y.humanSeat;

  /**
   * The single funnel for a token's accessible state. sync(), pulseTokens(),
   * clearPulse() and relabel() all come through here, so the label, the role, the
   * disabled state and the CSS class can never drift out of step.
   */
  function applyTokenA11y(node, player, token, number) {
    const g = node.group;
    g.setAttribute('aria-label', describe(player, token, number));
    g.classList.toggle('token--movable', a11y.movable.has(token.id));
    if (ownedByUser(player.id)) {
      // A control of the user's: keep it a button so its state can be announced,
      // and mark it inert rather than removing it while they are choosing.
      g.setAttribute('role', 'button');
      if (a11y.pickPhase && !a11y.movable.has(token.id)) g.setAttribute('aria-disabled', 'true');
      else g.removeAttribute('aria-disabled');
    } else {
      // Another seat's token — board information, not a control. Promising an
      // action that can never fire is worse than exposing none.
      g.setAttribute('role', 'img');
      g.removeAttribute('aria-disabled');
    }
  }

  const tokenOrder = () => [...tokens.keys()];

  /**
   * Exactly one tab stop on the board outside a pick, one per movable token during it.
   * Everything else stays reachable with the arrow keys.
   */
  function applyTabStops() {
    const ids = tokenOrder();
    if (!ids.length) return;
    if (a11y.pickPhase && a11y.movable.size) {
      for (const id of ids) {
        const node = tokens.get(id);
        if (node) node.group.setAttribute('tabindex', a11y.movable.has(id) ? '0' : '-1');
      }
      return;
    }
    if (!rovingId || !tokens.has(rovingId)) {
      rovingId = ids.find((id) => id.startsWith(`p${a11y.humanSeat}t`)) || ids[0];
    }
    for (const id of ids) {
      const node = tokens.get(id);
      if (node) node.group.setAttribute('tabindex', id === rovingId ? '0' : '-1');
    }
  }

  /** Re-apply labels and tab stops to every token after the a11y view changes. */
  function refreshTokenA11y() {
    for (const player of (lastState && lastState.players) || []) {
      for (const token of player.tokens || []) {
        const node = tokens.get(token.id);
        if (node) applyTokenA11y(node, player, token, tokenNumber(token));
      }
    }
    applyTabStops();
  }

  function sync(state, view = {}) {
    const movable = new Set(view.movableTokenIds || []);
    const selected = view.selectedTokenId || null;
    const active = Number.isInteger(view.activePlayer) ? view.activePlayer : state.turn;
    a11y.movable = movable;
    a11y.pickPhase = view.pickPhase === true;
    a11y.humanSeat = Number.isInteger(view.humanSeat) ? view.humanSeat : null;
    lastState = state;

    const entries = [];
    const shared = new Map();
    for (const player of state.players) {
      for (const token of player.tokens) {
        const spot = spotOf(player, token);
        const entry = { token, player, scale: 1, ...spot };
        entries.push(entry);
        if (!entry.key) continue;
        const list = shared.get(entry.key);
        if (list) list.push(entry);
        else shared.set(entry.key, [entry]);
      }
    }

    // Tokens sharing a cell fan out around its centre; the ring grows and the discs
    // shrink with the crowd, so every label stays readable.
    const stacked = new Set();
    for (const [key, list] of shared) {
      const n = list.length;
      if (n < 2) continue;
      const centre = { x: list[0].x, y: list[0].y };
      const spread = tokenR * (0.5 + 0.13 * n);
      const scale = n === 2 ? 0.8 : n === 3 ? 0.7 : 0.58;
      list.forEach((entry, i) => {
        const a = (-90 + (i * 360) / n) * DEG;
        entry.x += spread * Math.cos(a);
        entry.y += spread * Math.sin(a);
        entry.scale = scale;
      });
      setBadge(key, centre, n, list[n - 1].player.id);
      stacked.add(key);
    }
    for (const [key, badge] of badges) {
      if (stacked.has(key)) continue;
      badge.group.remove();
      badges.delete(key);
    }

    const alive = new Set();
    for (const entry of entries) {
      const { token, player } = entry;
      alive.add(token.id);
      const node = tokens.get(token.id) || createTokenNode(token, player);
      const number = tokenNumber(token);
      if (node.label.textContent !== String(number)) node.label.textContent = String(number);
      node.group.setAttribute('transform', transformOf(entry.x, entry.y, entry.scale));
      // Four tokens parked in one goal wedge sit 27.05 units apart — closer than any
      // two cells — so at the goal the target shrinks back to the disc. Everywhere
      // else the full cell-sized target applies, scaled with the group.
      const hitR = r2(entry.at === 'goal' ? tokenR : TOKEN_HIT_R);
      if (node.hit && node.hit.getAttribute('r') !== String(hitR)) {
        node.hit.setAttribute('r', String(hitR));
      }
      applyTokenA11y(node, player, token, number);
      const cl = node.group.classList;
      cl.toggle('token--selected', selected === token.id);
      cl.toggle('token--goal', entry.at === 'goal');
      cl.toggle('token--base', entry.at === 'base');
      cl.toggle('token--home', entry.at === 'home');
      cl.toggle('token--stacked', entry.scale !== 1);
      positions.set(token.id, { x: entry.x, y: entry.y, scale: entry.scale });
    }

    for (const [id, node] of tokens) {
      if (alive.has(id)) continue;
      node.group.remove();
      tokens.delete(id);
      positions.delete(id);
      if (rovingId === id) rovingId = null;
    }

    applyTabStops();
    highlightActive(active);
  }

  function highlightActive(active) {
    svgEl.setAttribute('data-active-player', String(active));
    for (const node of svgEl.querySelectorAll('.base, .arm-plate, .cell--start, .goal-wedge')) {
      const on = node.getAttribute('data-player') === String(active);
      node.classList.toggle('is-active', on);
    }
    // Presentation attributes, so a stylesheet rule still wins.
    for (const plate of svgEl.querySelectorAll('.arm-plate')) {
      plate.setAttribute('fill-opacity', plate.classList.contains('is-active') ? 0.16 : 0.09);
    }
    for (const base of svgEl.querySelectorAll('.base')) {
      const on = base.classList.contains('is-active');
      const plate = base.querySelector('.base-plate');
      if (plate) {
        plate.setAttribute('fill-opacity', on ? 0.32 : 0.2);
        plate.setAttribute('stroke-width', on ? 4.5 : 2.5);
      }
    }
  }

  function pulseTokens(tokenIds) {
    a11y.movable = new Set(tokenIds || []);
    a11y.pickPhase = true;
    refreshTokenA11y();
  }

  function clearPulse() {
    a11y.movable = new Set();
    a11y.pickPhase = false;
    refreshTokenA11y();
  }

  /**
   * Point at one token without selecting it — the move picker's buttons call this on
   * hover and on focus so the panel and the board name the same piece. Purely visual:
   * it touches no label, role or tab stop, so it cannot disturb the pick.
   */
  function highlightToken(tokenId) {
    for (const [id, node] of tokens) {
      node.group.classList.toggle('token--preview', id === tokenId);
    }
  }

  /**
   * Scale every animation clock. 1 = Normal, 1/3 = Fast, 0 = Instant (no deliberate
   * delay at all). Nothing but timing changes: the waypoints, the state and the RNG
   * are untouched, so the same seed replays the same game at any speed.
   */
  function setSpeed(value) {
    const n = Number(value);
    speed = Number.isFinite(n) ? clamp(n, MIN_SPEED, MAX_SPEED) : 1;
    return speed;
  }

  // -------------------------------------------------------------------------
  // Animation
  // -------------------------------------------------------------------------

  /** Screen points the token has to visit, starting from where it currently is. */
  function moveWaypoints(event) {
    const steps = Array.isArray(event.path) && event.path.length ? event.path.slice() : [event.to];
    if (steps.length > 1 && steps[0] === event.from) steps.shift();
    const here = positions.get(event.tokenId);
    const points = steps.map((t) => cellCenter(event.playerId, t));
    return here ? [{ x: here.x, y: here.y }, ...points] : points;
  }

  /** Look a token up in a state snapshot; both animations are handed one. */
  function lookUp(state, playerId, tokenId) {
    const player = state && state.players ? state.players[playerId] : null;
    const token = player ? player.tokens.find((t) => t.id === tokenId) : null;
    return { player, token };
  }

  function relabel(node, state, playerId, tokenId) {
    const { player, token } = lookUp(state, playerId, tokenId);
    // Through the same funnel as sync(): an animation must not strip the movability
    // suffix, the role or aria-disabled that the pick phase just put on.
    if (token) applyTokenA11y(node, player, token, tokenNumber(token));
  }

  /**
   * SVG has no z-index, so the only way to draw the moving token above the rest is to
   * re-append its <g> to the end of the layer. Chrome implements that as remove +
   * insert, which BLURS the node: every human move dropped focus on <body> about 80ms
   * after ui.js had deliberately handed it to the token, and it stayed there for the
   * whole bot lap (measured: single stretches of up to 14.8s), which made the board's
   * Arrow/Home/End roving unreachable and broke SPEC 8. Carry the focus across.
   */
  function raiseToTop(group) {
    const held = group.contains(document.activeElement);
    layers.get('layer-tokens').appendChild(group);
    if (held) group.focus({ preventScroll: true });
  }

  function animateMove(event, state) {
    return serialise(() => {
      const node = tokens.get(event.tokenId);
      if (!node) return Promise.resolve();
      const points = moveWaypoints(event);
      const end = points[points.length - 1];
      const hops = points.length - 1;
      const finish = () => {
        node.group.setAttribute('transform', transformOf(end.x, end.y));
        positions.set(event.tokenId, { x: end.x, y: end.y, scale: 1 });
        node.group.classList.remove('token--moving');
        relabel(node, state, event.playerId, event.tokenId);
      };
      if (hops < 1 || speed === 0 || reducedMotion()) {
        finish();
        return Promise.resolve();
      }

      raiseToTop(node.group); // the mover draws above the rest
      node.group.classList.add('token--moving');

      // A long jump (base -> start, or into the goal) is given proportionally more time.
      const spans = [];
      let total = 0;
      for (let i = 0; i < hops; i++) {
        const dx = points[i + 1].x - points[i].x;
        const dy = points[i + 1].y - points[i].y;
        const ms = dur(HOP_MS) * clamp(Math.hypot(dx, dy) / (cell * 1.15), 1, 3);
        spans.push({ start: total, ms });
        total += ms;
      }

      const lift = cell * 0.22;
      return animate(total, (p) => {
        const clock = p * total;
        let i = hops - 1;
        while (i > 0 && clock < spans[i].start) i--;
        const local = clamp((clock - spans[i].start) / spans[i].ms, 0, 1);
        const eased = easeInOut(local);
        const arc = Math.sin(Math.PI * local);
        const x = lerp(points[i].x, points[i + 1].x, eased);
        const y = lerp(points[i].y, points[i + 1].y, eased) - lift * arc;
        node.group.setAttribute('transform', transformOf(x, y, 1 + 0.12 * arc));
      }).then(finish);
    });
  }

  function pointOfCell(playerId, cellRef) {
    if (!cellRef) return null;
    if (cellRef.kind === 'ring') {
      const c = layout.ring[cellRef.index];
      return c ? { x: c.x, y: c.y } : null;
    }
    if (cellRef.kind === 'home') {
      const c = layout.homes[playerId][cellRef.index];
      return c ? { x: c.x, y: c.y } : null;
    }
    return { x: layout.goal.x, y: layout.goal.y };
  }

  function ripple(at, playerId) {
    const fx = layers.get('layer-fx');
    if (!fx || !at) return;
    const circle = el('circle', {
      class: `fx-ripple p${playerId}`, cx: r2(at.x), cy: r2(at.y), r: r2(cell * 0.3),
      fill: 'none', stroke: `var(--p${playerId})`, 'stroke-width': 3, 'stroke-opacity': 0.9,
    }, fx);
    animate(dur(RIPPLE_MS), (p) => {
      circle.setAttribute('r', r2(cell * (0.3 + 1.1 * p)));
      circle.setAttribute('stroke-opacity', r3(0.9 * (1 - p)));
    }).then(() => circle.remove());
  }

  function animateCapture(event, state) {
    return serialise(() => {
      const node = tokens.get(event.tokenId);
      const { token } = lookUp(state, event.playerId, event.tokenId);
      const home = baseSlot(event.playerId, token ? indexOf(token) : 0);
      const here = positions.get(event.tokenId) || pointOfCell(event.playerId, event.fromCell) || home;

      ripple(here, event.playerId);
      if (!node) return Promise.resolve();

      const finish = () => {
        node.group.setAttribute('transform', transformOf(home.x, home.y));
        node.group.setAttribute('opacity', 1);
        node.group.classList.remove('token--captured');
        positions.set(event.tokenId, { x: home.x, y: home.y, scale: 1 });
        relabel(node, state, event.playerId, event.tokenId);
      };
      if (speed === 0 || reducedMotion()) {
        finish();
        return Promise.resolve();
      }

      raiseToTop(node.group);
      node.group.classList.add('token--captured');

      // Quadratic arc whose control point is pushed away from the board centre.
      const mid = { x: (here.x + home.x) / 2, y: (here.y + home.y) / 2 };
      const away = Math.hypot(mid.x - layout.center.x, mid.y - layout.center.y) || 1;
      const bulge = Math.hypot(home.x - here.x, home.y - here.y) * 0.22;
      const ctrl = {
        x: mid.x + ((mid.x - layout.center.x) / away) * bulge,
        y: mid.y + ((mid.y - layout.center.y) / away) * bulge,
      };

      return animate(dur(CAPTURE_MS), (p) => {
        const e = easeInOut(p);
        const inv = 1 - e;
        const x = inv * inv * here.x + 2 * inv * e * ctrl.x + e * e * home.x;
        const y = inv * inv * here.y + 2 * inv * e * ctrl.y + e * e * home.y;
        const dip = Math.sin(Math.PI * p);
        node.group.setAttribute('transform', transformOf(x, y, 1 - 0.45 * dip, 540 * e));
        node.group.setAttribute('opacity', r3(1 - 0.6 * dip));
      }).then(finish);
    });
  }

  // -------------------------------------------------------------------------
  // Dice
  // -------------------------------------------------------------------------

  function diceNodes() {
    if (!diceBtn || !diceBtn.isConnected) diceBtn = opts.diceEl || doc.getElementById('dice');
    if (!diceFaceEl || !diceFaceEl.isConnected) diceFaceEl = opts.diceFaceEl || doc.getElementById('dice-face');
    return { button: diceBtn, face: diceFaceEl };
  }

  function drawPips(face, value) {
    face.textContent = '';
    const svg = el('svg', {
      class: 'dice-pips', viewBox: '0 0 100 100', width: '1em', height: '1em',
      'aria-hidden': 'true', focusable: 'false',
    }, face);
    for (const [col, row] of PIPS[value] || []) {
      el('circle', { class: 'pip', cx: 22 + col * 28, cy: 22 + row * 28, r: 11, fill: 'currentColor' }, svg);
    }
  }

  /** Paint one face without changing the renderer's idea of the current value. */
  function paintFace(value) {
    const { button, face } = diceNodes();
    const valid = Number.isInteger(value) && value >= 1 && value <= 6 ? value : null;
    if (button) {
      for (let v = 1; v <= 6; v++) button.classList.toggle(`dice--${v}`, v === valid);
      button.classList.toggle('dice--empty', valid === null);
      button.setAttribute('data-value', valid === null ? '' : String(valid));
      button.setAttribute('aria-label', valid === null ? 'Roll the dice' : `Dice showing ${valid}`);
    }
    if (face) {
      face.setAttribute('data-value', valid === null ? '' : String(valid));
      drawPips(face, valid);
    }
    return valid;
  }

  function setDice(value, { rolling = false } = {}) {
    diceValue = paintFace(value);
    const { button } = diceNodes();
    if (button) {
      button.classList.toggle('is-rolling', !!rolling);
      button.setAttribute('aria-busy', rolling ? 'true' : 'false');
    }
  }

  function shakeDice() {
    const run = () => {
      const { button } = diceNodes();
      if (button) {
        button.classList.add('is-rolling');
        button.setAttribute('aria-busy', 'true');
      }
      const settle = () => {
        if (button) {
          button.classList.remove('is-rolling');
          button.setAttribute('aria-busy', 'false');
        }
        paintFace(diceValue);
      };
      if (speed === 0 || reducedMotion()) {
        settle();
        return Promise.resolve();
      }
      let shown = -1;
      return animate(dur(DICE_TUMBLE_MS), (p) => {
        const frame = Math.min(DICE_FRAMES.length - 1, Math.floor(p * DICE_FRAMES.length));
        if (frame !== shown) {
          shown = frame;
          paintFace(DICE_FRAMES[frame]);
        }
      }).then(settle);
    };
    const next = diceChain.then(run, run);
    diceChain = next.catch(() => {});
    return next;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  function tokenIdFrom(target) {
    const node = target && typeof target.closest === 'function' ? target.closest('.token') : null;
    return node ? node.getAttribute('data-token-id') : null;
  }

  function handleClick(ev) {
    const id = tokenIdFrom(ev.target);
    if (id && opts.onTokenClick) opts.onTokenClick(id);
  }

  const ROVE = {
    ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1,
  };

  /** Move the roving stop `delta` places, or to `absolute` ('first' | 'last'). */
  function rove(fromId, delta, absolute) {
    const ids = tokenOrder();
    if (!ids.length) return;
    let next;
    if (absolute === 'first') next = ids[0];
    else if (absolute === 'last') next = ids[ids.length - 1];
    else {
      const here = ids.indexOf(fromId);
      next = ids[(((here < 0 ? 0 : here) + delta) % ids.length + ids.length) % ids.length];
    }
    const node = tokens.get(next);
    if (!node) return;
    // During a pick the tab stops belong to the movable tokens; roving still lets the
    // player read every square, it just must not add a second stop behind their back.
    if (!a11y.pickPhase || !a11y.movable.size) {
      rovingId = next;
      applyTabStops();
    }
    node.group.focus({ preventScroll: true });
  }

  function handleKeyDown(ev) {
    const id = tokenIdFrom(ev.target);
    if (!id) return;
    if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
      // Outside a pick, Space on a token belongs to the dice — ui.js rolls it.
      if (!a11y.pickPhase) return;
      ev.preventDefault();
      ev.stopPropagation();          // ui.js must not re-dispatch the same activation
      if (opts.onTokenClick) opts.onTokenClick(id);
      return;
    }
    if (ev.key in ROVE) {
      ev.preventDefault();
      ev.stopPropagation();
      rove(id, ROVE[ev.key]);
      return;
    }
    if (ev.key === 'Home') {
      ev.preventDefault();
      ev.stopPropagation();
      rove(id, 0, 'first');
      return;
    }
    if (ev.key === 'End') {
      ev.preventDefault();
      ev.stopPropagation();
      rove(id, 0, 'last');
    }
  }

  /** Whatever the player last focused becomes the board's one tab stop. */
  function handleFocusIn(ev) {
    const id = tokenIdFrom(ev.target);
    if (!id || !tokens.has(id)) return;
    rovingId = id;
    if (!a11y.pickPhase || !a11y.movable.size) applyTabStops();
  }

  function handleHover(ev) {
    const node = ev.target && typeof ev.target.closest === 'function' ? ev.target.closest('.cell') : null;
    if (ev.type === 'pointerout' || !node) {
      opts.onCellHover(null);
      return;
    }
    const ring = node.getAttribute('data-ring');
    opts.onCellHover(ring !== null
      ? { kind: 'ring', index: Number(ring) }
      : { kind: 'home', player: Number(node.getAttribute('data-player')), step: Number(node.getAttribute('data-step')) });
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  function clearBoard() {
    svgEl.removeEventListener('click', handleClick);
    svgEl.removeEventListener('keydown', handleKeyDown);
    svgEl.removeEventListener('focusin', handleFocusIn);
    if (opts.onCellHover) {
      svgEl.removeEventListener('pointerover', handleHover);
      svgEl.removeEventListener('pointerout', handleHover);
    }
    cancelAnimations();
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
    tokens.clear();
    rovingId = null;
    lastState = null;
    badges.clear();
    positions.clear();
    layers.clear();
  }

  function destroy() {
    disposed = true;
    cancelAnimations();
    clearBoard();
    svgEl.removeAttribute('data-active-player');
    const { button } = diceNodes();
    if (button) {
      button.classList.remove('is-rolling');
      button.removeAttribute('aria-busy');
    }
  }

  return {
    mount,
    sync,
    animateMove,
    animateCapture,
    pulseTokens,
    clearPulse,
    highlightToken,
    setSpeed,
    cancelAnimations,
    setDice,
    shakeDice,
    destroy,
  };
}
