// Engine suite — derived from SPEC.md section 3 only.
// Scenarios are built by hand-editing a fresh game state, which is legal
// because the spec guarantees State is plain, structured-cloneable JSON.
import test from 'node:test';
import assert from 'node:assert/strict';

import * as E from '../js/engine.js';
import { HOME_STEP, RING, PLAYERS, startIndex, entryIndex, isSafe, progressToCell } from '../js/geometry.js';

const SEATS = [
  { name: 'You', kind: 'human', aiLevel: 'normal' },
  { name: 'Bot 2', kind: 'ai', aiLevel: 'normal' },
  { name: 'Bot 3', kind: 'ai', aiLevel: 'easy' },
  { name: 'Bot 4', kind: 'ai', aiLevel: 'hard' },
  { name: 'Bot 5', kind: 'ai', aiLevel: 'normal' },
];

const clone = (s) => JSON.parse(JSON.stringify(s));
const snap = (s) => JSON.stringify(s);

function newGame(over = {}) {
  return E.createGame({
    seats: SEATS.map((s) => ({ ...s })),
    tokensPerPlayer: over.tokensPerPlayer ?? 4,
    rules: { ...E.DEFAULT_RULES, ...(over.rules || {}) },
    seed: over.seed ?? 20240919,
    startingPlayer: over.startingPlayer ?? 0,
  });
}

// Whatever the engine uses for `t` while a token is parked in base.
const BASE_T = newGame().players[0].tokens[0].t;

const onTrack = (t) => ({ place: 'track', t });
const inBase = () => ({ place: 'base', t: BASE_T });
const atGoal = () => ({ place: 'goal', t: HOME_STEP });

/** Build a state with the given board position. `tokens` maps playerId -> position[]. */
function scenario({ turn = 0, phase = 'move', dice = null, sixStreak = 0, tokens = {}, rules = {}, tokensPerPlayer = 4 }) {
  const s = clone(newGame({ rules, tokensPerPlayer, startingPlayer: turn }));
  s.turn = turn;
  s.phase = phase;
  s.dice = dice;
  s.sixStreak = sixStreak;
  for (const [pid, positions] of Object.entries(tokens)) {
    const player = s.players[Number(pid)];
    positions.forEach((pos, i) => {
      if (!player.tokens[i]) return;
      player.tokens[i].place = pos.place;
      player.tokens[i].t = pos.t;
    });
  }
  return s;
}

/** The progress value that puts player `p` on ring cell `index`. */
function progressFor(p, index) {
  const t = (index - startIndex(p) + RING) % RING;
  return t;
}

/** A ring cell that is not safe and is not anybody's tip, for capture tests. */
const PLAIN_CELL = 10; // 13*0 + 10
const SAFE_CELL = 15; // 13*1 + 2

test('createGame yields a well formed opening position', () => {
  const s = newGame();
  assert.equal(s.version, 1);
  assert.equal(s.players.length, PLAYERS);
  assert.equal(s.phase, 'roll');
  assert.equal(s.turn, 0);
  assert.equal(s.dice, null);
  assert.equal(s.sixStreak, 0);
  assert.deepEqual(s.finishedOrder, []);
  assert.equal(s.winner, null);
  assert.equal(s.moveCount, 0);
  s.players.forEach((p, i) => {
    assert.equal(p.id, i);
    assert.equal(p.finished, false);
    assert.equal(p.rank, null);
    assert.equal(p.tokens.length, 4);
    p.tokens.forEach((tok, k) => {
      assert.equal(tok.id, `p${i}t${k + 1}`, 'token ids follow the pNtM shape');
      assert.equal(tok.place, 'base');
    });
  });
  assert.equal(E.currentPlayer(s).id, 0);
  assert.equal(newGame({ tokensPerPlayer: 2 }).players[0].tokens.length, 2);
  assert.equal(newGame({ tokensPerPlayer: 3 }).players[3].tokens.length, 3);
});

test('tokens leave base only on a six, landing on t = 0', () => {
  for (const roll of [1, 2, 3, 4, 5]) {
    const s = scenario({ dice: roll });
    assert.deepEqual(E.legalMoves(s), [], `roll ${roll} must not let a token out of base`);
  }
  const six = scenario({ dice: 6 });
  const moves = E.legalMoves(six);
  assert.ok(moves.length > 0, 'a six must offer an exit');
  for (const m of moves) {
    assert.equal(m.kind, 'exit');
    assert.equal(m.to, 0);
    assert.equal(m.from, null);
    assert.equal(m.playerId, 0);
    assert.equal(m.toCell.kind, 'ring');
    assert.equal(m.toCell.index, startIndex(0));
  }
  const after = E.applyMove(six, moves[0].tokenId).state;
  const moved = after.players[0].tokens.find((t) => t.id === moves[0].tokenId);
  assert.equal(moved.place, 'track');
  assert.equal(moved.t, 0);
});

test('reaching the goal needs an exact roll; overshoot is rejected', () => {
  const base = { turn: 0, dice: 3, tokens: { 0: [onTrack(67), atGoal(), atGoal(), atGoal()] } };
  const exact = scenario(base);
  const moves = E.legalMoves(exact);
  assert.equal(moves.length, 1, 'exactly one token can still move');
  assert.equal(moves[0].kind, 'goal');
  assert.equal(moves[0].to, HOME_STEP);
  assert.equal(moves[0].toCell.kind, 'goal');
  const after = E.applyMove(exact, moves[0].tokenId).state;
  assert.equal(after.players[0].tokens[0].place, 'goal');
  assert.equal(after.players[0].tokens[0].t, HOME_STEP);

  for (const over of [4, 5, 6]) {
    const s = scenario({ ...base, dice: over });
    const overshoot = E.legalMoves(s).filter((m) => m.tokenId === 'p0t1');
    assert.deepEqual(overshoot, [], `t=67 + ${over} overshoots HOME_STEP and must be illegal`);
  }
});

test('a move onto the home column is kind enterHome', () => {
  const s = scenario({ turn: 0, dice: 2, tokens: { 0: [onTrack(64), atGoal(), atGoal(), atGoal()] } });
  const moves = E.legalMoves(s);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].to, 66);
  assert.equal(moves[0].kind, 'enterHome');
  assert.equal(moves[0].toCell.kind, 'home');
  assert.equal(moves[0].toCell.index, 1);
});

test('landing on a plain ring cell captures every opponent token there', () => {
  const target = PLAIN_CELL;
  assert.equal(isSafe(target), false, 'test fixture must use an unsafe cell');
  // two victims from DIFFERENT players: two tokens of one player would be a
  // block and could not be landed on at all.
  const s = scenario({
    turn: 0,
    dice: 3,
    tokens: {
      0: [onTrack(progressFor(0, target) - 3), atGoal(), atGoal(), atGoal()],
      1: [onTrack(progressFor(1, target)), inBase(), inBase(), inBase()],
      2: [onTrack(progressFor(2, target)), inBase(), inBase(), inBase()],
    },
  });
  const move = E.legalMoves(s).find((m) => m.tokenId === 'p0t1');
  assert.ok(move, 'the advancing token must have a legal move');
  assert.deepEqual([...move.captures].sort(), ['p1t1', 'p2t1']);
  assert.equal(move.grantsExtraTurn, true, 'captureExtraTurn is on by default');

  const { state, events } = E.applyMove(s, 'p0t1');
  assert.equal(state.players[1].tokens[0].place, 'base', 'captured tokens go back to base');
  assert.equal(state.players[2].tokens[0].place, 'base', 'captured tokens go back to base');
  assert.equal(state.players[0].tokens[0].t, progressFor(0, target));
  const captures = events.filter((e) => e.type === 'capture');
  assert.equal(captures.length, 2);
  assert.deepEqual(captures.map((e) => e.tokenId).sort(), ['p1t1', 'p2t1']);
  assert.deepEqual(captures.map((e) => e.playerId).sort(), [1, 2], 'capture events carry the victim ids');
  assert.equal(state.turn, 0, 'a capture grants an extra turn');
  assert.equal(state.phase, 'roll');
});

test('a safe cell never captures', () => {
  const target = SAFE_CELL;
  assert.equal(isSafe(target), true, 'test fixture must use a safe cell');
  const s = scenario({
    turn: 0,
    dice: 3,
    tokens: {
      0: [onTrack(progressFor(0, target) - 3), atGoal(), atGoal(), atGoal()],
      1: [onTrack(progressFor(1, target)), inBase(), inBase(), inBase()],
    },
  });
  const move = E.legalMoves(s).find((m) => m.tokenId === 'p0t1');
  assert.ok(move, 'landing on a safe cell shared with an opponent is legal');
  assert.deepEqual(move.captures, []);
  const { state, events } = E.applyMove(s, 'p0t1');
  assert.equal(state.players[1].tokens[0].place, 'track', 'the occupant stays put');
  assert.equal(state.players[1].tokens[0].t, progressFor(1, target));
  assert.equal(events.some((e) => e.type === 'capture'), false);
});

test('own tokens stack freely on the same cell', () => {
  const target = PLAIN_CELL;
  const s = scenario({
    turn: 0,
    dice: 3,
    tokens: { 0: [onTrack(progressFor(0, target)), onTrack(progressFor(0, target) - 3), atGoal(), atGoal()] },
  });
  const move = E.legalMoves(s).find((m) => m.tokenId === 'p0t2');
  assert.ok(move, 'a token may join its own token');
  assert.deepEqual(move.captures, []);
  const state = E.applyMove(s, 'p0t2').state;
  assert.equal(state.players[0].tokens[0].t, progressFor(0, target));
  assert.equal(state.players[0].tokens[1].t, progressFor(0, target));
});

test('an opponent block cannot be landed on', () => {
  const target = PLAIN_CELL;
  const s = scenario({
    turn: 0,
    dice: 3,
    tokens: {
      0: [onTrack(progressFor(0, target) - 3), atGoal(), atGoal(), atGoal()],
      1: [onTrack(progressFor(1, target)), onTrack(progressFor(1, target)), inBase(), inBase()],
    },
  });
  assert.deepEqual(E.legalMoves(s), [], 'a 2-token block blocks landing');
});

test('an opponent block cannot be passed through', () => {
  const target = PLAIN_CELL;
  const s = scenario({
    turn: 0,
    dice: 5,
    tokens: {
      0: [onTrack(progressFor(0, target) - 3), atGoal(), atGoal(), atGoal()],
      1: [onTrack(progressFor(1, target)), onTrack(progressFor(1, target)), inBase(), inBase()],
    },
  });
  assert.deepEqual(E.legalMoves(s), [], 'a block stops a token trying to jump over it');
});

test('a player own block never obstructs that player', () => {
  const target = PLAIN_CELL;
  const s = scenario({
    turn: 0,
    dice: 5,
    tokens: {
      0: [
        onTrack(progressFor(0, target)),
        onTrack(progressFor(0, target)),
        onTrack(progressFor(0, target) - 3),
        atGoal(),
      ],
    },
  });
  const move = E.legalMoves(s).find((m) => m.tokenId === 'p0t3');
  assert.ok(move, 'own tokens are passed through freely');
  assert.equal(move.to, progressFor(0, target) + 2);
});

test('with rules.blocks off a stack is just two capturable tokens', () => {
  const target = PLAIN_CELL;
  const s = scenario({
    turn: 0,
    dice: 3,
    rules: { blocks: false },
    tokens: {
      0: [onTrack(progressFor(0, target) - 3), atGoal(), atGoal(), atGoal()],
      1: [onTrack(progressFor(1, target)), onTrack(progressFor(1, target)), inBase(), inBase()],
    },
  });
  const move = E.legalMoves(s).find((m) => m.tokenId === 'p0t1');
  assert.ok(move, 'without blocks the cell is reachable');
  assert.equal(move.captures.length, 2);
});

test('home-column cells are never blocks', () => {
  // Two of player 1's tokens sit deep in their own home column; player 0 walks
  // past the same progress values on the ring and must be unaffected.
  const s = scenario({
    turn: 0,
    dice: 4,
    tokens: {
      0: [onTrack(66), atGoal(), atGoal(), atGoal()],
      1: [onTrack(67), onTrack(67), inBase(), inBase()],
    },
  });
  const move = E.legalMoves(s).find((m) => m.tokenId === 'p0t1');
  assert.ok(move, 'another player home column must not block ours');
  assert.equal(move.to, 70);
  assert.equal(move.kind, 'goal');
});

test('three consecutive sixes forfeit the turn', () => {
  const s = scenario({
    turn: 0,
    phase: 'roll',
    sixStreak: 2,
    tokens: { 0: [onTrack(5), inBase(), inBase(), inBase()] },
  });
  const { state, roll } = E.rollDice(s, 6);
  assert.equal(roll, 6);
  assert.equal(state.sixStreak, 0, 'the streak resets');
  assert.equal(state.phase, 'roll', 'no move is offered');
  assert.equal(state.turn, 1, 'the turn passes on');

  // the same streak with the rule disabled keeps playing
  const lenient = scenario({
    turn: 0,
    phase: 'roll',
    sixStreak: 2,
    rules: { threeSixesForfeit: false },
    tokens: { 0: [onTrack(5), inBase(), inBase(), inBase()] },
  });
  const after = E.rollDice(lenient, 6).state;
  assert.equal(after.phase, 'move');
  assert.equal(after.turn, 0);
});

test('a six streak builds up across an extra-turn chain', () => {
  let s = scenario({ turn: 0, phase: 'roll', tokens: { 0: [inBase(), inBase(), inBase(), inBase()] } });
  let r = E.rollDice(s, 6);
  assert.equal(r.state.sixStreak, 1);
  assert.equal(r.state.phase, 'move');
  s = E.applyMove(r.state, E.legalMoves(r.state)[0].tokenId).state;
  assert.equal(s.turn, 0, 'a six grants an extra turn');
  assert.equal(s.phase, 'roll');

  r = E.rollDice(s, 6);
  assert.equal(r.state.sixStreak, 2);
  s = E.applyMove(r.state, E.legalMoves(r.state)[0].tokenId).state;
  assert.equal(s.turn, 0);

  r = E.rollDice(s, 6);
  assert.equal(r.state.sixStreak, 0, 'the third six forfeits and resets');
  assert.equal(r.state.phase, 'roll');
  assert.equal(r.state.turn, 1);

  // a non-six clears the streak
  const cleared = E.rollDice(scenario({ turn: 0, phase: 'roll', sixStreak: 2 }), 3).state;
  assert.equal(cleared.sixStreak, 0);
});

test('extra turn on a six', () => {
  const s = scenario({ turn: 0, phase: 'roll', tokens: { 0: [onTrack(0), atGoal(), atGoal(), atGoal()] } });
  const rolled = E.rollDice(s, 6).state;
  assert.equal(rolled.phase, 'move');
  const move = E.legalMoves(rolled).find((m) => m.tokenId === 'p0t1');
  assert.equal(move.grantsExtraTurn, true);
  const { state, events } = E.applyMove(rolled, 'p0t1');
  assert.equal(state.turn, 0);
  assert.equal(state.phase, 'roll');
  assert.equal(state.extraTurn, true);
  assert.ok(events.some((e) => e.type === 'extraTurn' && e.playerId === 0));
});

test('extra turn on reaching the goal', () => {
  const s = scenario({ turn: 0, dice: 3, tokens: { 0: [onTrack(67), onTrack(10), inBase(), inBase()] } });
  const move = E.legalMoves(s).find((m) => m.tokenId === 'p0t1');
  assert.equal(move.kind, 'goal');
  assert.equal(move.grantsExtraTurn, true);
  const { state, events } = E.applyMove(s, 'p0t1');
  assert.ok(events.some((e) => e.type === 'goal' && e.tokenId === 'p0t1'));
  assert.equal(state.turn, 0, 'reaching the goal keeps the turn');
  assert.equal(state.phase, 'roll');
  assert.equal(state.players[0].finished, false, 'three tokens are still out');
});

test('no extra turn for an ordinary advance', () => {
  const s = scenario({ turn: 0, phase: 'roll', tokens: { 0: [onTrack(0), atGoal(), atGoal(), atGoal()] } });
  const rolled = E.rollDice(s, 3).state;
  const move = E.legalMoves(rolled).find((m) => m.tokenId === 'p0t1');
  assert.equal(move.kind, 'advance');
  assert.equal(move.grantsExtraTurn, false);
  const state = E.applyMove(rolled, 'p0t1').state;
  assert.equal(state.turn, 1);
  assert.equal(state.phase, 'roll');
});

test('the move event reports the full stepped path', () => {
  const s = scenario({ turn: 0, dice: 4, tokens: { 0: [onTrack(5), atGoal(), atGoal(), atGoal()] } });
  const { events } = E.applyMove(s, 'p0t1');
  const move = events.find((e) => e.type === 'move');
  assert.ok(move, 'applyMove emits a move event');
  assert.equal(move.tokenId, 'p0t1');
  assert.equal(move.from, 5);
  assert.equal(move.to, 9);
  assert.ok(Array.isArray(move.path) && move.path.length > 0);
  assert.equal(move.path.at(-1), 9, 'the path ends on the destination');
  for (let i = 1; i < move.path.length; i++) {
    assert.equal(move.path[i], move.path[i - 1] + 1, 'the path steps one cell at a time');
  }
});

test('passTurn hands over when there are no legal moves, skipping finished players', () => {
  const stuck = scenario({ turn: 0, dice: 3 });
  assert.deepEqual(E.legalMoves(stuck), []);
  const { state, events } = E.passTurn(stuck);
  assert.equal(state.turn, 1);
  assert.equal(state.phase, 'roll');
  assert.ok(events.some((e) => e.type === 'turn' && e.playerId === 1));

  const withFinisher = scenario({ turn: 0, dice: 3 });
  withFinisher.players[1].finished = true;
  withFinisher.players[1].rank = 1;
  withFinisher.players[1].tokens.forEach((t) => { t.place = 'goal'; t.t = HOME_STEP; });
  withFinisher.finishedOrder = [1];
  withFinisher.winner = 1;
  assert.equal(E.passTurn(withFinisher).state.turn, 2, 'finished players are skipped');
});

test('turn rotation wraps from player 4 back to player 0', () => {
  const s = scenario({ turn: 4, dice: 3 });
  assert.equal(E.passTurn(s).state.turn, 0);
});

test('finishing assigns ranks in finish order and sets the winner', () => {
  const first = scenario({ turn: 0, dice: 3, tokens: { 0: [onTrack(67), atGoal(), atGoal(), atGoal()] } });
  const { state, events } = E.applyMove(first, 'p0t1');
  assert.equal(state.players[0].finished, true);
  assert.equal(state.players[0].rank, 1);
  assert.deepEqual(state.finishedOrder, [0]);
  assert.equal(state.winner, 0);
  assert.ok(events.some((e) => e.type === 'finish' && e.playerId === 0 && e.rank === 1));
  assert.notEqual(state.phase, 'over', 'four players are still racing');

  // second finisher takes rank 2
  const second = clone(state);
  second.turn = 2;
  second.phase = 'move';
  second.dice = 3;
  second.players[2].tokens.forEach((t, i) => {
    if (i === 0) { t.place = 'track'; t.t = 67; } else { t.place = 'goal'; t.t = HOME_STEP; }
  });
  const after = E.applyMove(second, 'p2t1').state;
  assert.equal(after.players[2].rank, 2);
  assert.deepEqual(after.finishedOrder, [0, 2]);
  assert.equal(after.winner, 0, 'the winner is the first finisher');
});

test('the game is over once a single player is left, and that player takes the last rank', () => {
  const s = scenario({ turn: 0, dice: 3, tokens: { 0: [onTrack(67), atGoal(), atGoal(), atGoal()] } });
  [1, 2, 3].forEach((pid, i) => {
    const p = s.players[pid];
    p.finished = true;
    p.rank = i + 1;
    p.tokens.forEach((t) => { t.place = 'goal'; t.t = HOME_STEP; });
  });
  s.finishedOrder = [1, 2, 3];
  s.winner = 1;

  const { state, events } = E.applyMove(s, 'p0t1');
  assert.equal(state.players[0].rank, 4);
  assert.equal(state.phase, 'over');
  assert.equal(state.players[4].rank, 5, 'the straggler takes the last rank');
  assert.equal(state.winner, 1, 'the winner is still the first finisher');
  const over = events.find((e) => e.type === 'gameOver');
  assert.ok(over, 'a gameOver event is emitted');
  assert.equal(over.winner, 1);
  assert.ok(Array.isArray(over.standings));
});

test('standings reports one entry per player', () => {
  const s = newGame();
  const table = E.standings(s);
  assert.equal(table.length, PLAYERS);
  for (const row of table) {
    assert.equal(typeof row.playerId, 'number');
    assert.ok('rank' in row);
    assert.equal(typeof row.home, 'number');
    assert.equal(typeof row.progress, 'number');
  }
  assert.deepEqual(table.map((r) => r.playerId).sort(), [0, 1, 2, 3, 4]);
});

test('rollDice, applyMove and passTurn never mutate their input', () => {
  const rollIn = scenario({ turn: 0, phase: 'roll', tokens: { 0: [onTrack(5), inBase(), inBase(), inBase()] } });
  const rollSnap = snap(rollIn);
  E.rollDice(rollIn, 4);
  assert.equal(snap(rollIn), rollSnap, 'rollDice mutated its input');

  const moveIn = scenario({
    turn: 0,
    dice: 3,
    tokens: {
      0: [onTrack(progressFor(0, PLAIN_CELL) - 3), atGoal(), atGoal(), atGoal()],
      1: [onTrack(progressFor(1, PLAIN_CELL)), inBase(), inBase(), inBase()],
    },
  });
  const moveSnap = snap(moveIn);
  E.applyMove(moveIn, 'p0t1');
  assert.equal(snap(moveIn), moveSnap, 'applyMove mutated its input');

  const passIn = scenario({ turn: 0, dice: 3 });
  const passSnap = snap(passIn);
  E.passTurn(passIn);
  assert.equal(snap(passIn), passSnap, 'passTurn mutated its input');

  const movesIn = scenario({ turn: 0, dice: 6 });
  const movesSnap = snap(movesIn);
  E.legalMoves(movesIn);
  assert.equal(snap(movesIn), movesSnap, 'legalMoves mutated its input');
});

test('serialize / deserialize round-trips a mid-game state', () => {
  let s = newGame({ seed: 7 });
  for (let i = 0; i < 40 && s.phase !== 'over'; i++) {
    if (s.phase === 'roll') { s = E.rollDice(s).state; continue; }
    const moves = E.legalMoves(s);
    s = moves.length ? E.applyMove(s, moves[0].tokenId).state : E.passTurn(s).state;
  }
  const text = E.serialize(s);
  assert.equal(typeof text, 'string');
  assert.deepEqual(E.deserialize(text), s);
});

test('makeRng is a deterministic seeded stream in [0,1)', () => {
  const a = E.makeRng(12345);
  const b = E.makeRng(12345);
  const c = E.makeRng(54321);
  const seqA = Array.from({ length: 20 }, () => a());
  const seqB = Array.from({ length: 20 }, () => b());
  const seqC = Array.from({ length: 20 }, () => c());
  assert.deepEqual(seqA, seqB, 'same seed, same stream');
  assert.notDeepEqual(seqA, seqC, 'different seeds differ');
  for (const v of seqA) assert.ok(v >= 0 && v < 1, `${v} outside [0,1)`);
});

test('a seeded all-bot game always reaches phase "over" inside the move budget', () => {
  const BUDGET = 40000;
  for (const seed of [1, 1337, 20240919]) {
    let s = newGame({ seed });
    const pick = E.makeRng(seed ^ 0x5f3759df);
    let steps = 0;
    while (s.phase !== 'over' && steps < BUDGET) {
      steps++;
      if (s.phase === 'roll') { s = E.rollDice(s).state; continue; }
      const moves = E.legalMoves(s);
      if (moves.length === 0) { s = E.passTurn(s).state; continue; }
      const m = moves[Math.floor(pick() * moves.length)];
      s = E.applyMove(s, m.tokenId).state;
    }
    assert.equal(s.phase, 'over', `seed ${seed} did not finish within ${BUDGET} steps`);
    assert.notEqual(s.winner, null);
    const ranks = s.players.map((p) => p.rank).sort((a, b) => a - b);
    assert.deepEqual(ranks, [1, 2, 3, 4, 5], `seed ${seed} left ranks ${JSON.stringify(ranks)}`);
    assert.equal(s.finishedOrder[0], s.winner);
    assert.equal(E.standings(s).length, PLAYERS);
    // four of the five players must have every token home
    const done = s.players.filter((p) => p.tokens.every((t) => t.place === 'goal')).length;
    assert.ok(done >= PLAYERS - 1, `only ${done} players got every token home`);
  }
});

/* ── describeMove: the label the move picker puts on its buttons ───────────── */

test('describeMove names the most consequential fact about a move', () => {
  // exit
  const exit = scenario({ turn: 0, dice: 6, tokens: { 0: [inBase(), inBase()] } });
  assert.equal(E.describeMove(exit, E.legalMoves(exit)[0]), 'leaves base');

  // plain advance: from -> to, in progress coordinates
  const walk = scenario({ turn: 0, dice: 5, tokens: { 0: [onTrack(12)] } });
  const walkMove = E.legalMoves(walk).find((m) => m.tokenId === 'p0t1');
  assert.equal(E.describeMove(walk, walkMove), '12 → 17');

  // a landing on a safe cell says so
  const safeT = progressFor(0, SAFE_CELL);
  const safe = scenario({ turn: 0, dice: 3, tokens: { 0: [onTrack(safeT - 3)] } });
  const safeMove = E.legalMoves(safe).find((m) => m.tokenId === 'p0t1');
  assert.ok(isSafe(safeMove.toCell.index));
  assert.equal(E.describeMove(safe, safeMove), `${safeT - 3} → ${safeT} · safe cell`);

  // entering the home run counts down to the goal
  const enter = scenario({ turn: 0, dice: 3, tokens: { 0: [onTrack(RING - 1)] } });
  const enterMove = E.legalMoves(enter).find((m) => m.tokenId === 'p0t1');
  assert.equal(enterMove.kind, 'enterHome');
  assert.equal(E.describeMove(enter, enterMove), 'enters the home run · 3 to go');

  // a further step inside the home run, singular this time
  const inHome = scenario({ turn: 0, dice: 1, tokens: { 0: [onTrack(HOME_STEP - 2)] } });
  const inHomeMove = E.legalMoves(inHome).find((m) => m.tokenId === 'p0t1');
  assert.equal(E.describeMove(inHome, inHomeMove), 'up the home run · 1 to go');

  // the goal outranks everything else
  const goal = scenario({ turn: 0, dice: 4, tokens: { 0: [onTrack(HOME_STEP - 4)] } });
  const goalMove = E.legalMoves(goal).find((m) => m.tokenId === 'p0t1');
  assert.equal(goalMove.kind, 'goal');
  assert.equal(E.describeMove(goal, goalMove), 'home!');
});

test('describeMove names the victim of a capture, and outranks the plain advance', () => {
  const attacker = progressFor(0, PLAIN_CELL) - 4;
  const victim = progressFor(2, PLAIN_CELL);
  const s = scenario({
    turn: 0, dice: 4,
    tokens: { 0: [onTrack(attacker)], 2: [onTrack(victim)] },
  });
  const move = E.legalMoves(s).find((m) => m.tokenId === 'p0t1');
  assert.deepEqual(move.captures, ['p2t1']);
  assert.equal(E.describeMove(s, move), `captures Bot 3 on cell ${PLAIN_CELL}`);

  // Two victims on the same cell, one owner — which is a block, so the rule has to
  // be off for the move to exist at all.
  const two = scenario({
    turn: 0, dice: 4, rules: { blocks: false },
    tokens: { 0: [onTrack(attacker)], 2: [onTrack(victim), onTrack(victim)] },
  });
  const twoMove = E.legalMoves(two).find((m) => m.tokenId === 'p0t1');
  assert.equal(twoMove.captures.length, 2);
  assert.equal(E.describeMove(two, twoMove), `captures 2 of Bot 3's on cell ${PLAIN_CELL}`);

  // two owners on the same cell
  const both = scenario({
    turn: 0, dice: 4,
    tokens: {
      0: [onTrack(attacker)],
      2: [onTrack(victim)],
      3: [onTrack(progressFor(3, PLAIN_CELL))],
    },
  });
  const bothMove = E.legalMoves(both).find((m) => m.tokenId === 'p0t1');
  assert.equal(bothMove.captures.length, 2);
  assert.equal(E.describeMove(both, bothMove), `captures 2 tokens on cell ${PLAIN_CELL}`);
});

test('describeMove is pure and total: every legal move of a played-out game gets a label', () => {
  let s = newGame({ seed: 4242 });
  const pick = E.makeRng(99);
  const kinds = new Set();
  for (let step = 0; step < 4000 && s.phase !== 'over'; step++) {
    if (s.phase === 'roll') { s = E.rollDice(s).state; continue; }
    const moves = E.legalMoves(s);
    if (moves.length === 0) { s = E.passTurn(s).state; continue; }
    const before = snap(s);
    for (const m of moves) {
      const text = E.describeMove(s, m);
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 0 && text.length < 60, `bad label ${JSON.stringify(text)}`);
      kinds.add(m.kind);
    }
    assert.equal(snap(s), before, 'describeMove mutated the state');
    const m = moves[Math.floor(pick() * moves.length)];
    s = E.applyMove(s, m.tokenId).state;
  }
  // a real game exercises every branch the picker can show
  assert.deepEqual([...kinds].sort(), ['advance', 'enterHome', 'exit', 'goal']);
  assert.equal(E.describeMove(s, null), '');
});

test('a seeded game replays identically, so wall-clock pace cannot change it', () => {
  // The speed control scales setTimeout and the animation clock only. This is the
  // engine half of that promise: nothing in a transition reads a wall clock, so the
  // same seed and the same choices produce the same state every time, at any pace.
  const replay = (seed) => {
    let s = newGame({ seed });
    const pick = E.makeRng(seed ^ 0x9e3779b9);
    const trace = [];
    for (let step = 0; step < 6000 && s.phase !== 'over'; step++) {
      if (s.phase === 'roll') {
        const rolled = E.rollDice(s);
        s = rolled.state;
        trace.push(`r${rolled.roll}`);
        continue;
      }
      const moves = E.legalMoves(s);
      if (moves.length === 0) { s = E.passTurn(s).state; trace.push('pass'); continue; }
      const m = moves[Math.floor(pick() * moves.length)];
      trace.push(`${m.tokenId}:${m.from}->${m.to}`);
      s = E.applyMove(s, m.tokenId).state;
    }
    return { trace: trace.join('|'), final: E.serialize(s) };
  };
  const a = replay(777);
  const b = replay(777);
  assert.equal(a.trace, b.trace);
  assert.equal(a.final, b.final);
  assert.notEqual(a.trace, replay(778).trace);
});

test('the ring walk really is 65 cells long for every player', () => {
  for (let p = 0; p < PLAYERS; p++) {
    const seen = new Set();
    for (let t = 0; t <= 64; t++) seen.add(progressToCell(p, t).index);
    assert.equal(seen.size, RING, `player ${p} does not visit all 65 cells`);
    assert.equal(progressToCell(p, 64).index, entryIndex(p));
  }
});
