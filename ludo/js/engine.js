/**
 * Pentagon Ludo — rules engine (section 3 of SPEC.md).
 *
 * Every export is pure: state is plain JSON, there is no DOM access, and the only
 * source of chance is the seeded mulberry32 cursor kept in `state.rngState`.
 * Transitions clone their input before touching anything, so a caller may hold on
 * to previous states for undo, replay or diffing.
 */
import {
  PLAYERS,
  RING,
  HOME_STEP,
  COLORS,
  startIndex,
  isSafe,
  progressToCell,
} from './geometry.js';

export const DEFAULT_RULES = {
  blocks: true,             // 2+ own tokens on a ring cell block opponents landing AND passing
  captureExtraTurn: true,
  homeExtraTurn: true,
  sixExtraTurn: true,
  threeSixesForfeit: true,  // third consecutive 6 -> turn forfeited, no move
  mustExitOnSix: false,     // if true a 6 must be used to leave base when possible
};

const DICE_FACES = 6;
const SIX = 6;
const MAX_SIX_STREAK = 3;
const TOKEN_COUNTS = [2, 3, 4];
const MULBERRY_INCREMENT = 0x6d2b79f5;

/* ------------------------------------------------------------------ *
 * Randomness — mulberry32, split so the cursor can live inside state.
 * ------------------------------------------------------------------ */

/** One mulberry32 step: takes a 32-bit cursor, returns the next cursor + value. */
function mulberryStep(cursor) {
  const next = (cursor + MULBERRY_INCREMENT) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { cursor: next, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
}

export function makeRng(seed) {
  let cursor = seed >>> 0;
  return () => {
    const step = mulberryStep(cursor);
    cursor = step.cursor;
    return step.value;
  };
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const deepClone =
  typeof structuredClone === 'function'
    ? (value) => structuredClone(value)
    : (value) => JSON.parse(JSON.stringify(value));

/** Ring index a token of `playerId` stands on at progress `t` (t must be < RING). */
function ringIndexFor(playerId, t) {
  return (startIndex(playerId) + t) % RING;
}

function rangeInclusive(from, to) {
  const out = [];
  for (let n = from; n <= to; n++) out.push(n);
  return out;
}

function ordinal(n) {
  return ['1st', '2nd', '3rd', '4th', '5th'][n - 1] ?? `${n}th`;
}

/**
 * The default human seat is named "You" (SPEC 6), so third-person verbs read
 * wrong for it. Agree the verb with the seat name instead.
 */
function isSecondPerson(player) {
  return String(player.name).trim().toLowerCase() === 'you';
}

function verb(player, third, second) {
  return isSecondPerson(player) ? second : third;
}

/**
 * How many log entries a state keeps. Unbounded, a long game reached ~3900 entries and
 * every persist() rewrote a ~260 KB localStorage payload. Trimming from the front is
 * safe: ids are derived from the last entry, so they stay monotonic and the UI's
 * seen-id de-duplication still works; the on-screen log only shows 80 lines anyway.
 */
const MAX_LOG = 200;

function pushLog(state, text, playerId = null) {
  const last = state.log[state.log.length - 1];
  state.log.push({ id: (last ? last.id : 0) + 1, text, playerId });
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}

/** Next player in seat order who is still racing; falls back to `from`. */
function nextActivePlayer(state, from) {
  for (let step = 1; step <= PLAYERS; step++) {
    const candidate = (from + step) % PLAYERS;
    if (!state.players[candidate].finished) return candidate;
  }
  return from;
}

/* ------------------------------------------------------------------ *
 * Blocks
 * ------------------------------------------------------------------ */

/**
 * Ring occupancy: ringIndex -> Map(playerId -> token count).
 * Only tokens actually standing on the ring count; home-column tokens (t >= RING)
 * are invisible to blocking and to capture.
 */
function ringOccupancy(state) {
  const occupancy = new Map();
  for (const player of state.players) {
    for (const token of player.tokens) {
      if (token.place !== 'track' || token.t >= RING) continue;
      const index = ringIndexFor(player.id, token.t);
      let cell = occupancy.get(index);
      if (!cell) {
        cell = new Map();
        occupancy.set(index, cell);
      }
      cell.set(player.id, (cell.get(player.id) ?? 0) + 1);
    }
  }
  return occupancy;
}

/** A ring cell blocks `playerId` when some OTHER player has 2+ tokens on it. */
function isBlockedFor(occupancy, ringIndex, playerId) {
  if (!occupancy) return false;
  const cell = occupancy.get(ringIndex);
  if (!cell) return false;
  for (const [owner, count] of cell) {
    if (owner !== playerId && count >= 2) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Game setup
 * ------------------------------------------------------------------ */

export function createGame(opts = {}) {
  const seats = opts.seats ?? [];
  if (!Array.isArray(seats) || seats.length !== PLAYERS) {
    throw new Error(`createGame needs exactly ${PLAYERS} seats`);
  }
  const tokensPerPlayer = opts.tokensPerPlayer ?? 4;
  if (!TOKEN_COUNTS.includes(tokensPerPlayer)) {
    throw new Error('tokensPerPlayer must be 2, 3 or 4');
  }
  const startingPlayer = opts.startingPlayer ?? 0;
  if (!Number.isInteger(startingPlayer) || startingPlayer < 0 || startingPlayer >= PLAYERS) {
    throw new Error(`startingPlayer must be 0..${PLAYERS - 1}`);
  }
  const seed = Number.isFinite(opts.seed) ? Math.trunc(opts.seed) >>> 0 : 12345;
  const rules = { ...DEFAULT_RULES, ...(opts.rules ?? {}) };

  const players = seats.map((seat, id) => ({
    id,
    name: (seat?.name ?? '').trim() || COLORS[id].name,
    kind: seat?.kind === 'ai' ? 'ai' : 'human',
    aiLevel: seat?.aiLevel ?? 'normal',
    color: COLORS[id].id,
    tokens: Array.from({ length: tokensPerPlayer }, (unused, index) => ({
      id: `p${id}t${index + 1}`,
      index,
      place: 'base',
      t: 0,
    })),
    finished: false,
    rank: null,
  }));

  const state = {
    version: 1,
    rules,
    tokensPerPlayer,
    seed,
    rngState: seed,
    players,
    turn: startingPlayer,
    phase: 'roll',
    dice: null,
    sixStreak: 0,
    extraTurn: false,
    finishedOrder: [],
    log: [],
    moveCount: 0,
    winner: null,
  };
  pushLog(
    state,
    `${players[startingPlayer].name} ${verb(players[startingPlayer], 'goes', 'go')} first`,
    startingPlayer,
  );
  return state;
}

export function currentPlayer(state) {
  return state.players[state.turn];
}

/* ------------------------------------------------------------------ *
 * Rolling
 * ------------------------------------------------------------------ */

/**
 * Roll for the player to move. `forced` (1..6) skips the RNG entirely — the
 * cursor is left untouched so forced rolls never disturb a seeded sequence.
 * Returns {state, roll, forfeited}; `forfeited` is true when this was a third
 * consecutive six, which resolves the whole turn here (no move is offered).
 */
export function rollDice(state, forced) {
  if (state.phase !== 'roll') {
    throw new Error(`rollDice requires phase 'roll' (got '${state.phase}')`);
  }
  const next = deepClone(state);
  const player = next.players[next.turn];

  let roll;
  if (forced === undefined || forced === null) {
    const step = mulberryStep(next.rngState);
    next.rngState = step.cursor;
    roll = 1 + Math.floor(step.value * DICE_FACES);
  } else {
    roll = Math.trunc(forced);
    if (!(roll >= 1 && roll <= DICE_FACES)) {
      throw new Error(`forced roll must be 1..${DICE_FACES}`);
    }
  }

  next.dice = roll;
  next.extraTurn = false;
  next.sixStreak = roll === SIX ? next.sixStreak + 1 : 0;
  pushLog(next, `${player.name} rolled a ${roll}`, player.id);

  if (next.rules.threeSixesForfeit && next.sixStreak >= MAX_SIX_STREAK) {
    pushLog(next, `${player.name} rolled three sixes in a row — turn forfeited`, player.id);
    // The turn is resolved here: no move is offered and the dice pass to the next player.
    next.sixStreak = 0;
    next.dice = null;
    next.phase = 'roll';
    next.turn = nextActivePlayer(next, next.turn);
    return { state: next, roll, forfeited: true };
  }

  next.phase = 'move';
  return { state: next, roll, forfeited: false };
}

/* ------------------------------------------------------------------ *
 * Legal moves
 * ------------------------------------------------------------------ */

/** Opponent tokens sitting on `ringIndex` that this landing would send home. */
function capturesAt(state, playerId, ringIndex) {
  if (isSafe(ringIndex)) return [];
  const victims = [];
  for (const other of state.players) {
    if (other.id === playerId) continue;
    for (const token of other.tokens) {
      if (token.place !== 'track' || token.t >= RING) continue;
      if (ringIndexFor(other.id, token.t) === ringIndex) victims.push(token.id);
    }
  }
  return victims;
}

function buildMove(state, player, token, from, to) {
  const captures = to < RING ? capturesAt(state, player.id, ringIndexFor(player.id, to)) : [];
  const kind =
    from === null ? 'exit' : to === HOME_STEP ? 'goal' : to >= RING ? 'enterHome' : 'advance';
  const grantsExtraTurn = Boolean(
    (state.dice === SIX && state.rules.sixExtraTurn) ||
      (captures.length > 0 && state.rules.captureExtraTurn) ||
      (kind === 'goal' && state.rules.homeExtraTurn),
  );
  return {
    tokenId: token.id,
    playerId: player.id,
    kind,
    from,
    to,
    fromCell: from === null ? null : progressToCell(player.id, from),
    toCell: progressToCell(player.id, to),
    captures,
    grantsExtraTurn,
    blocked: false,
  };
}

/** The single move this token could make with `roll`, or null if it has none. */
function tokenMove(state, player, token, roll, occupancy) {
  if (token.place === 'goal') return null;

  if (token.place === 'base') {
    // Base tokens only come out on a six, onto the player's start cell (t = 0).
    if (roll !== SIX) return null;
    if (isBlockedFor(occupancy, startIndex(player.id), player.id)) return null;
    return buildMove(state, player, token, null, 0);
  }

  const from = token.t;
  const to = from + roll;
  if (to > HOME_STEP) return null; // overshooting the goal is illegal

  // Walk every cell stepped onto: an opponent block stops the move whether it is
  // passed through or landed on. Home-column steps (t >= RING) are never blocked.
  for (let step = from + 1; step <= to; step++) {
    if (step >= RING) break;
    if (isBlockedFor(occupancy, ringIndexFor(player.id, step), player.id)) return null;
  }
  return buildMove(state, player, token, from, to);
}

export function legalMoves(state) {
  if (state.phase !== 'move' || state.dice === null) return [];
  const player = state.players[state.turn];
  if (!player || player.finished) return [];

  const roll = state.dice;
  const occupancy = state.rules.blocks ? ringOccupancy(state) : null;
  const moves = [];
  for (const token of player.tokens) {
    const move = tokenMove(state, player, token, roll, occupancy);
    if (move) moves.push(move);
  }

  if (state.rules.mustExitOnSix && roll === SIX) {
    const exits = moves.filter((move) => move.kind === 'exit');
    if (exits.length > 0) return exits;
  }
  return moves;
}

/* ------------------------------------------------------------------ *
 * Applying a move
 * ------------------------------------------------------------------ */

/** Seat names behind a list of victim token ids, in board order, without repeats. */
function victimNames(state, tokenIds) {
  const seats = new Set();
  for (const id of tokenIds) {
    const owner = (state.players || []).find((p) => p.tokens.some((t) => t.id === id));
    if (owner) seats.add(owner.name);
  }
  return [...seats];
}

/**
 * What a move actually DOES, as a short phrase — the label on a move-picker button
 * and, where a caller wants it, a log line. Pure: everything is read off the Move
 * the engine already returned, plus the state it came from (needed only to name a
 * capture's victim).
 *
 * The clauses are ordered by consequence, not by the shape of the Move: a move that
 * both enters the home run and reaches the goal says "home!", and a capture outranks
 * where the token came from. Only one fact fits on a button, so it has to be the one
 * that decides whether the player picks this move.
 */
export function describeMove(state, move) {
  if (!move) return '';
  if (move.kind === 'goal' || move.to >= HOME_STEP) return 'home!';

  if (move.captures && move.captures.length > 0) {
    const where = move.toCell && move.toCell.kind === 'ring' ? ` on cell ${move.toCell.index}` : '';
    const names = victimNames(state, move.captures);
    if (names.length === 1 && move.captures.length === 1) return `captures ${names[0]}${where}`;
    if (names.length === 1) return `captures ${move.captures.length} of ${names[0]}'s${where}`;
    return `captures ${move.captures.length} tokens${where}`;
  }

  const stepsLeft = HOME_STEP - move.to;
  const toGo = `${stepsLeft} step${stepsLeft === 1 ? '' : 's'} from home`;
  if (move.kind === 'enterHome') return `enters the home run · ${toGo}`;
  if (move.kind === 'exit') return 'leaves base';
  if (move.toCell && move.toCell.kind === 'home') return `up the home run · ${toGo}`;

  const safe = move.toCell && move.toCell.kind === 'ring' && isSafe(move.toCell.index);
  return `${move.from} → ${move.to}${safe ? ' · safe cell' : ''}`;
}

function moveText(player, move) {
  switch (move.kind) {
    case 'exit':
      return `${player.name} brought a token out onto cell ${move.toCell.index}`;
    case 'enterHome':
      return `${player.name} entered the home column — ${HOME_STEP - move.to} step${
        HOME_STEP - move.to === 1 ? '' : 's'
      } from home`;
    default:
      return `${player.name} moved a token to cell ${move.toCell.index}`;
  }
}

function finishPlayer(state, player, events) {
  player.finished = true;
  player.rank = state.finishedOrder.length + 1;
  state.finishedOrder.push(player.id);
  if (state.winner === null) state.winner = player.id;
  events.push({ type: 'finish', playerId: player.id, rank: player.rank });
  pushLog(state, `${player.name} finished ${ordinal(player.rank)}`, player.id);
}

function advanceTurn(state, events) {
  state.sixStreak = 0;
  state.extraTurn = false;
  state.dice = null;
  state.phase = 'roll';
  state.turn = nextActivePlayer(state, state.turn);
  events.push({ type: 'turn', playerId: state.turn });
}

export function applyMove(state, tokenId) {
  const move = legalMoves(state).find((candidate) => candidate.tokenId === tokenId);
  if (!move) throw new Error(`No legal move for token ${tokenId}`);

  const next = deepClone(state);
  const events = [];
  const player = next.players[next.turn];
  const token = player.tokens.find((candidate) => candidate.id === tokenId);

  // path excludes the origin and includes the destination; the UI animates it.
  const path = move.from === null ? [move.to] : rangeInclusive(move.from + 1, move.to);
  token.t = move.to;
  token.place = move.to === HOME_STEP ? 'goal' : 'track';
  next.moveCount += 1;
  events.push({
    type: 'move',
    playerId: player.id,
    tokenId,
    from: move.from,
    to: move.to,
    path,
  });

  for (const victimId of move.captures) {
    const victimOwner = next.players.find((p) => p.tokens.some((t) => t.id === victimId));
    const victim = victimOwner.tokens.find((t) => t.id === victimId);
    const fromCell = progressToCell(victimOwner.id, victim.t);
    victim.place = 'base';
    victim.t = 0;
    events.push({ type: 'capture', playerId: victimOwner.id, tokenId: victimId, fromCell });
    pushLog(
      next,
      `${player.name} captured ${victimOwner.name}'s token on cell ${fromCell.index}`,
      player.id,
    );
  }

  if (move.kind === 'goal') {
    events.push({ type: 'goal', playerId: player.id, tokenId });
    const remaining = player.tokens.filter((t) => t.place !== 'goal').length;
    pushLog(
      next,
      remaining === 0
        ? `${player.name} got the last token home`
        : `${player.name} brought a token home — ${remaining} to go`,
      player.id,
    );
  } else if (move.captures.length === 0) {
    pushLog(next, moveText(player, move), player.id);
  }

  if (player.tokens.every((t) => t.place === 'goal')) finishPlayer(next, player, events);

  // Once a single player is left racing they take the last rank and the game ends.
  const stillRacing = next.players.filter((p) => !p.finished);
  if (stillRacing.length <= 1) {
    for (const straggler of stillRacing) finishPlayer(next, straggler, events);
    next.phase = 'over';
    next.dice = null;
    next.extraTurn = false;
    next.sixStreak = 0;
    pushLog(next, `Game over — ${next.players[next.winner].name} wins`, next.winner);
    events.push({ type: 'gameOver', winner: next.winner, standings: standings(next) });
    return { state: next, events };
  }

  if (move.grantsExtraTurn && !player.finished) {
    next.extraTurn = true;
    next.dice = null;
    next.phase = 'roll';
    events.push({ type: 'extraTurn', playerId: player.id });
    pushLog(next, `${player.name} ${verb(player, 'takes', 'take')} another turn`, player.id);
  } else {
    advanceTurn(next, events);
  }
  return { state: next, events };
}

export function passTurn(state) {
  if (state.phase !== 'move') {
    throw new Error(`passTurn requires phase 'move' (got '${state.phase}')`);
  }
  if (legalMoves(state).length > 0) {
    throw new Error('passTurn called while legal moves are available');
  }
  const next = deepClone(state);
  const player = next.players[next.turn];
  pushLog(
    next,
    `${player.name} ${verb(player, 'has', 'have')} no legal move and ${verb(player, 'passes', 'pass')}`,
    player.id,
  );
  const events = [];
  advanceTurn(next, events);
  return { state: next, events };
}

/* ------------------------------------------------------------------ *
 * Reporting + persistence
 * ------------------------------------------------------------------ */

/** Ranked players first (by rank), then the racers ordered by how far along they are. */
export function standings(state) {
  const rows = state.players.map((player) => ({
    playerId: player.id,
    rank: player.rank,
    home: player.tokens.filter((t) => t.place === 'goal').length,
    progress: player.tokens.reduce((sum, t) => sum + (t.place === 'base' ? 0 : t.t), 0),
  }));
  rows.sort((a, b) => {
    if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
    if (a.rank !== null) return -1;
    if (b.rank !== null) return 1;
    return b.home - a.home || b.progress - a.progress || a.playerId - b.playerId;
  });
  return rows;
}

export function serialize(state) {
  return JSON.stringify(state);
}

export function deserialize(text) {
  const state = JSON.parse(text);
  if (!state || state.version !== 1) throw new Error('Unsupported saved game');
  return state;
}
