/**
 * Bot move selection — SPEC §4.
 *
 * Pure and deterministic: every random draw comes from a mulberry32 stream seeded
 * from `state.rngState` + `state.moveCount`, never Math.random or Date.
 * Imports geometry only; the engine's State/Move shapes are used as documented in SPEC.
 */

import { RING, HOME_STEP, startIndex, isSafe } from './geometry.js';

/** Highest progress value that is still a ring cell (65..69 are the home column). */
const LAST_RING_STEP = RING - 1; // 64
const DICE_FACES = [1, 2, 3, 4, 5, 6];
const EASY_RANDOM_RATE = 0.6;

/**
 * Heuristic weights. Roughly ordered by the priority list in SPEC §4:
 * finish > capture > develop/escape > shape (blocks, safe squares) > raw progress.
 */
const W = {
  goal: 1000, // land exactly on HOME_STEP
  winGame: 400, // ...and that was our last token
  homeEntry: 150, // slip into the home column, out of reach forever
  homeDepth: 9, // per cell deeper inside the home column
  capture: 95, // flat reward for sending someone back
  captureProgress: 2.2, // per unit of progress the victim loses
  extraTurn: 34,
  safety: 1.0, // multiplies the change in expected material loss
  safeCell: 26, // finish the move on a star/start square
  block: 30, // two of ours on one ring cell
  blockContested: 14, // per nearby opponent, capped
  breakBlock: 34, // dismantling a block we already hold
  exit: 60, // leave the base
  exitCrowd: 22, // per extra token still stuck in the base
  develop: 40, // nothing of ours is on the track at all
  startGuard: 40, // vacating our start square while tokens still wait in base
  progress: 0.55, // raw distance travelled
  runner: 18, // convex top-up so the leader is pushed rather than the pack
  retaliation: 0.9, // 'hard' only: what the best opponent reply takes back
  noise: 16, // 'normal' only: mild deterministic jitter
};

// ---------------------------------------------------------------------------
// Deterministic RNG (local copy of mulberry32 — ai.js imports geometry only)
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Same state + same move count => same stream, so bot play replays identically. */
function derivedRng(state) {
  const base = Number.isFinite(state?.rngState) ? state.rngState >>> 0 : 0;
  const moves = Number.isFinite(state?.moveCount) ? state.moveCount >>> 0 : 0;
  return mulberry32((base ^ Math.imul(moves + 1, 0x9e3779b1)) >>> 0);
}

// ---------------------------------------------------------------------------
// Light board model: a flat token list we can cheaply mutate for look-ahead
// ---------------------------------------------------------------------------

function snapshot(state) {
  const tokens = [];
  for (const player of state.players) {
    for (const token of player.tokens) {
      tokens.push({ p: player.id, id: token.id, place: token.place, t: token.t | 0 });
    }
  }
  return tokens;
}

/** Ring index a track token stands on (only valid while t <= LAST_RING_STEP). */
function ringOf(token) {
  return (startIndex(token.p) + token.t) % RING;
}

function onRing(token) {
  return token.place === 'track' && token.t <= LAST_RING_STEP;
}

/** The model after `move` resolves: mover relocated, victims back in their base. */
function applyToModel(tokens, move) {
  const captured = new Set(move.captures || []);
  return tokens.map((token) => {
    if (token.id === move.tokenId) {
      return { ...token, place: move.to >= HOME_STEP ? 'goal' : 'track', t: move.to };
    }
    if (captured.has(token.id)) return { ...token, place: 'base', t: 0 };
    return token;
  });
}

/** Map ring index -> tokens standing there. */
function occupancy(tokens) {
  const occ = new Map();
  for (const token of tokens) {
    if (!onRing(token)) continue;
    const key = ringOf(token);
    const here = occ.get(key);
    if (here) here.push(token);
    else occ.set(key, [token]);
  }
  return occ;
}

/** Player owning a block (2+ of one colour) on this ring cell, else null. */
function blockOwner(occ, ring) {
  const here = occ.get(ring);
  if (!here || here.length < 2) return null;
  const seen = new Set();
  for (const token of here) {
    if (seen.has(token.p)) return token.p;
    seen.add(token.p);
  }
  return null;
}

/** Would a mover of `player` be stopped walking `steps` cells from `fromRing`? */
function pathBlocked(occ, player, fromRing, steps, blocksOn) {
  if (!blocksOn) return false;
  for (let k = 1; k <= steps; k += 1) {
    const owner = blockOwner(occ, (fromRing + k) % RING);
    if (owner !== null && owner !== player) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Threat model
// ---------------------------------------------------------------------------

/**
 * Dice values with which some opponent could capture on `ring`.
 * Respects the pentagon wrap, safe cells, blocks, and ignores opponents whose
 * roll would divert them into their own home column (they can never come back).
 */
function threatDice(tokens, occ, ring, victimPlayer, blocksOn) {
  const dice = new Set();
  if (isSafe(ring)) return dice; // safe cells never capture
  for (const token of tokens) {
    if (token.p === victimPlayer || !onRing(token)) continue;
    const from = ringOf(token);
    const steps = (ring - from + RING) % RING; // wraps around the pentagon
    if (steps < 1 || steps > 6) continue;
    if (token.t + steps > LAST_RING_STEP) continue; // they would turn into their home column
    if (pathBlocked(occ, token.p, from, steps, blocksOn)) continue;
    dice.add(steps);
  }
  return dice;
}

/** What a token is worth: the journey already invested in it. */
function materialValue(t) {
  return 14 + t * 1.7;
}

/** Expected material `player` loses to one opponent roll, summed over its tokens. */
function exposure(tokens, occ, player, blocksOn) {
  let total = 0;
  for (const token of tokens) {
    if (token.p !== player || !onRing(token)) continue;
    const dice = threatDice(tokens, occ, ringOf(token), player, blocksOn);
    if (dice.size > 0) total += (dice.size / 6) * materialValue(token.t);
  }
  return total;
}

/**
 * One-ply retaliation ('hard'): expected material `player` hands to the strongest
 * single reply, averaged over dice 1..6. Base exits are ignored because every
 * start cell is safe, so leaving the base can never capture.
 */
function retaliation(state, tokens, occ, player, blocksOn) {
  let worst = 0;
  for (const seat of state.players) {
    if (seat.id === player || seat.finished) continue;
    let expected = 0;
    for (const face of DICE_FACES) {
      let best = 0;
      for (const token of tokens) {
        if (token.p !== seat.id || !onRing(token)) continue;
        if (token.t + face > LAST_RING_STEP) continue;
        const from = ringOf(token);
        const target = (from + face) % RING;
        if (isSafe(target) || pathBlocked(occ, seat.id, from, face, blocksOn)) continue;
        let value = 0;
        for (const victim of occ.get(target) || []) {
          if (victim.p === player) value += materialValue(victim.t);
        }
        if (value > best) best = value;
      }
      expected += best / 6;
    }
    if (expected > worst) worst = expected;
  }
  return worst;
}

/** How busy a ring cell is: opponents within one roll count double those within two. */
function contested(tokens, ring, player) {
  let weight = 0;
  for (const token of tokens) {
    if (token.p === player || !onRing(token)) continue;
    const steps = (ring - ringOf(token) + RING) % RING;
    if (steps >= 1 && steps <= 6) weight += 1;
    else if (steps <= 12) weight += 0.5;
  }
  return Math.min(weight, 3);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreMove(state, move, ctx) {
  const me = move.playerId;
  const { tokens, occBefore, blocksOn, baseCount, trackCount, level } = ctx;
  const after = applyToModel(tokens, move);
  const occAfter = occupancy(after);
  let score = 0;

  if (move.to >= HOME_STEP) {
    // Finishing a token is the whole point; finishing the set ends our game.
    score += W.goal;
    if (!after.some((token) => token.p === me && token.place !== 'goal')) score += W.winGame;
  } else if (move.to >= RING) {
    // The home column is out of everyone's reach, so depth is pure profit.
    score += W.homeEntry + W.homeDepth * (move.to - RING);
  }

  for (const victimId of move.captures || []) {
    const victim = tokens.find((token) => token.id === victimId);
    score += W.capture + W.captureProgress * (victim ? victim.t : 0);
  }

  if (move.grantsExtraTurn) score += W.extraTurn;

  // Net swing in what a single opponent roll can take from us: this is what makes
  // the bot flee threatened squares, hide on safe ones and value captures twice.
  score += W.safety * (ctx.exposureBefore - exposure(after, occAfter, me, blocksOn));

  if (move.toCell && move.toCell.kind === 'ring') {
    const target = move.toCell.index;
    if (isSafe(target)) score += W.safeCell;
    if (blocksOn && blockOwner(occAfter, target) === me) {
      score += W.block + W.blockContested * contested(tokens, target, me);
    }
  }

  // Walking one token out of a block costs us the wall it was holding.
  if (blocksOn && move.fromCell && move.fromCell.kind === 'ring') {
    const source = move.fromCell.index;
    if (blockOwner(occBefore, source) === me && blockOwner(occAfter, source) !== me) {
      score -= W.breakBlock + W.blockContested * contested(tokens, source, me);
    }
  }

  if (move.kind === 'exit') {
    score += W.exit + W.exitCrowd * Math.max(baseCount - 1, 0);
    if (trackCount === 0) score += W.develop;
  } else if (move.from === 0 && baseCount > 0) {
    // Our start square is the landing pad for everything still in the base —
    // stepping off it and leaving it empty wastes future sixes.
    const guarded = after.some((t) => t.p === me && t.place === 'track' && t.t === 0);
    if (!guarded) score -= W.startGuard;
  }

  // Raw progress, convex so the leading runner is pushed instead of the whole pack.
  score += W.progress * move.to + W.runner * (move.to / HOME_STEP) ** 2;

  if (level === 'hard') {
    score -= W.retaliation * retaliation(state, after, occAfter, me, blocksOn);
  }

  return score;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pick one of `moves` for the bot on turn.
 * @param {object} state engine State
 * @param {object[]} moves legal Move list from engine.legalMoves
 * @param {'easy'|'normal'|'hard'} level
 * @returns {object|null} always one of `moves`; null only for an empty list
 */
export function chooseMove(state, moves, level = 'normal') {
  if (!Array.isArray(moves) || moves.length === 0) return null;
  if (moves.length === 1) return moves[0];

  const rng = derivedRng(state);
  if (level === 'easy' && rng() < EASY_RANDOM_RATE) {
    const pick = Math.floor(rng() * moves.length);
    return moves[Math.min(pick, moves.length - 1)];
  }

  const me = moves[0].playerId;
  const tokens = snapshot(state);
  const occBefore = occupancy(tokens);
  const blocksOn = Boolean(state.rules && state.rules.blocks);
  const mine = tokens.filter((token) => token.p === me);
  const ctx = {
    tokens,
    occBefore,
    blocksOn,
    level,
    exposureBefore: exposure(tokens, occBefore, me, blocksOn),
    baseCount: mine.filter((token) => token.place === 'base').length,
    trackCount: mine.filter((token) => token.place === 'track').length,
  };

  let best = moves[0];
  let bestScore = -Infinity;
  for (const move of moves) {
    let score = scoreMove(state, move, ctx);
    if (level === 'normal') score += (rng() - 0.5) * W.noise;
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }
  return best;
}

/** Short human phrase for the move log, e.g. "goes for the capture". */
export function describeChoice(move) {
  if (!move) return 'has no move';
  if (move.to >= HOME_STEP) return 'sends a token to the goal';
  if (move.captures && move.captures.length > 0) return 'goes for the capture';
  if (move.kind === 'enterHome' || move.to >= RING) return 'runs for home';
  if (move.kind === 'exit') return 'breaks out of base';
  if (move.toCell && move.toCell.kind === 'ring' && isSafe(move.toCell.index)) {
    return 'ducks onto a safe square';
  }
  if (move.to >= RING - 12) return 'closes in on the home stretch';
  return 'edges a token forward';
}
