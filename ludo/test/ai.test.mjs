// AI suite — derived from SPEC.md section 4 only.
// The bot must pick from the moves it is handed, prefer the spec's ordering
// (finish > capture > ...) at the greedy levels, and be deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';

import * as AI from '../js/ai.js';
import * as E from '../js/engine.js';
import { HOME_STEP, RING, startIndex, progressToCell } from '../js/geometry.js';

const LEVELS = ['easy', 'normal', 'hard'];
const clone = (s) => JSON.parse(JSON.stringify(s));

function newGame(over = {}) {
  return E.createGame({
    seats: [0, 1, 2, 3, 4].map((i) => ({
      name: `P${i + 1}`,
      kind: i === 0 ? 'human' : 'ai',
      aiLevel: 'normal',
    })),
    tokensPerPlayer: 4,
    rules: { ...E.DEFAULT_RULES },
    seed: over.seed ?? 4242,
    startingPlayer: 0,
  });
}

/** progress value that puts player p on ring cell `index` */
const progressFor = (p, index) => (index - startIndex(p) + RING) % RING;

/** Build a spec-shaped Move without needing the engine to produce it. */
function move(playerId, tokenId, kind, from, to, extra = {}) {
  return {
    tokenId,
    playerId,
    kind,
    from,
    to,
    fromCell: from === null ? null : progressToCell(playerId, from),
    toCell: progressToCell(playerId, to),
    captures: [],
    grantsExtraTurn: false,
    blocked: false,
    ...extra,
  };
}

/** A state whose player-0 tokens sit at the given progress values. */
function stateWithTokens(progressList, opponents = {}) {
  const s = clone(newGame());
  s.phase = 'move';
  s.turn = 0;
  s.dice = 3;
  progressList.forEach((t, i) => {
    const tok = s.players[0].tokens[i];
    if (!tok) return;
    if (t === null) return; // stay in base
    tok.place = t === HOME_STEP ? 'goal' : 'track';
    tok.t = t;
  });
  for (const [pid, list] of Object.entries(opponents)) {
    list.forEach((t, i) => {
      const tok = s.players[Number(pid)].tokens[i];
      if (!tok || t === null) return;
      tok.place = 'track';
      tok.t = t;
    });
  }
  return s;
}

const isOneOf = (choice, moves) =>
  moves.some((m) => m.tokenId === choice.tokenId && m.to === choice.to && m.kind === choice.kind);

test('chooseMove always returns one of the supplied moves', () => {
  const s = stateWithTokens([2, 14, 30, null]);
  const moves = [
    move(0, 'p0t1', 'advance', 2, 5),
    move(0, 'p0t2', 'advance', 14, 17),
    move(0, 'p0t3', 'advance', 30, 33),
  ];
  for (const level of LEVELS) {
    for (let i = 0; i < 25; i++) {
      const picked = AI.chooseMove(clone(s), clone(moves), level);
      assert.ok(picked, `${level} returned nothing`);
      assert.ok(isOneOf(picked, moves), `${level} invented a move: ${JSON.stringify(picked)}`);
    }
  }
});

test('a single-move list leaves no choice', () => {
  const s = stateWithTokens([64, null, null, null]);
  const only = [move(0, 'p0t1', 'enterHome', 64, 67)];
  for (const level of LEVELS) {
    const picked = AI.chooseMove(clone(s), clone(only), level);
    assert.equal(picked.tokenId, 'p0t1');
    assert.equal(picked.to, 67);
  }
});

test('finishing a token beats every other option', () => {
  const s = stateWithTokens([67, 14, 30, 41]);
  const moves = [
    move(0, 'p0t2', 'advance', 14, 17),
    move(0, 'p0t3', 'advance', 30, 33),
    move(0, 'p0t1', 'goal', 67, HOME_STEP, { grantsExtraTurn: true }),
    move(0, 'p0t4', 'advance', 41, 44),
  ];
  const picked = AI.chooseMove(clone(s), clone(moves), 'hard');
  assert.equal(picked.kind, 'goal', 'hard must take the goal');
  assert.equal(picked.tokenId, 'p0t1');
});

test('a capture beats a longer plain advance', () => {
  // p0t2 is the token further from home, but its move captures; the spec ranks
  // capture above "advance the token nearest home", so the greedy bot must take it.
  const victimCell = 31; // plain ring cell: not safe, not a tip
  const capturingTo = progressFor(0, victimCell); // 24 for player 0
  const s = stateWithTokens([40, capturingTo - 4, null, null], {
    1: [progressFor(1, victimCell)],
  });
  const moves = [
    move(0, 'p0t1', 'advance', 40, 44),
    move(0, 'p0t2', 'advance', capturingTo - 4, capturingTo, {
      captures: ['p1t1'],
      grantsExtraTurn: true,
    }),
  ];
  const picked = AI.chooseMove(clone(s), clone(moves), 'hard');
  assert.equal(picked.tokenId, 'p0t2', 'hard must prefer the capture');
  assert.deepEqual(picked.captures, ['p1t1']);
});

test('chooseMove is deterministic for identical input', () => {
  const s = stateWithTokens([2, 14, 30, 41]);
  const moves = [
    move(0, 'p0t1', 'advance', 2, 5),
    move(0, 'p0t2', 'advance', 14, 17),
    move(0, 'p0t3', 'advance', 30, 33),
    move(0, 'p0t4', 'advance', 41, 44),
  ];
  for (const level of LEVELS) {
    const first = AI.chooseMove(clone(s), clone(moves), level);
    for (let i = 0; i < 5; i++) {
      const again = AI.chooseMove(clone(s), clone(moves), level);
      assert.equal(again.tokenId, first.tokenId, `${level} is not deterministic`);
      assert.equal(again.to, first.to);
    }
  }
});

test('a different rngState may change the pick but never the contract', () => {
  const base = stateWithTokens([2, 14, 30, 41]);
  const moves = [
    move(0, 'p0t1', 'advance', 2, 5),
    move(0, 'p0t2', 'advance', 14, 17),
    move(0, 'p0t3', 'advance', 30, 33),
  ];
  for (let i = 0; i < 10; i++) {
    const s = clone(base);
    s.rngState = (s.rngState ?? 0) + i * 7919;
    const picked = AI.chooseMove(s, clone(moves), 'easy');
    assert.ok(isOneOf(picked, moves), 'easy must still pick a legal move');
  }
});

test('chooseMove copes with a stripped-down state', () => {
  const s = clone(newGame());
  s.log = [];
  s.players.forEach((p) => { p.tokens = []; });
  const moves = [move(0, 'p0t1', 'exit', null, 0)];
  for (const level of LEVELS) {
    const picked = AI.chooseMove(s, clone(moves), level);
    assert.equal(picked.tokenId, 'p0t1');
  }
  // an unknown level must not blow up either
  assert.ok(AI.chooseMove(clone(newGame()), clone(moves), 'unheard-of'));
});

test('chooseMove never mutates the moves it is given', () => {
  const s = stateWithTokens([2, 14, null, null]);
  const moves = [move(0, 'p0t1', 'advance', 2, 5), move(0, 'p0t2', 'advance', 14, 17)];
  const before = JSON.stringify(moves);
  AI.chooseMove(clone(s), moves, 'hard');
  assert.equal(JSON.stringify(moves), before, 'the move list was mutated');
});

test('describeChoice returns a short human readable string', () => {
  const samples = [
    move(0, 'p0t1', 'exit', null, 0),
    move(0, 'p0t2', 'advance', 12, 16),
    move(0, 'p0t3', 'enterHome', 63, 66),
    move(0, 'p0t4', 'goal', 67, HOME_STEP, { grantsExtraTurn: true }),
    move(0, 'p0t1', 'advance', 3, 9, { captures: ['p2t3'], grantsExtraTurn: true }),
  ];
  for (const m of samples) {
    const text = AI.describeChoice(m);
    assert.equal(typeof text, 'string', `describeChoice(${m.kind}) must return a string`);
    assert.ok(text.length > 0 && text.length <= 120, `describeChoice(${m.kind}) length ${text.length}`);
  }
});

test('the bot can drive a whole game through the engine', () => {
  let s = newGame({ seed: 9001 });
  const BUDGET = 40000;
  let steps = 0;
  while (s.phase !== 'over' && steps < BUDGET) {
    steps++;
    if (s.phase === 'roll') { s = E.rollDice(s).state; continue; }
    const moves = E.legalMoves(s);
    if (moves.length === 0) { s = E.passTurn(s).state; continue; }
    const level = E.currentPlayer(s).aiLevel || 'normal';
    const picked = AI.chooseMove(s, moves, level);
    assert.ok(isOneOf(picked, moves), 'the bot picked a move that was not offered');
    s = E.applyMove(s, picked.tokenId).state;
  }
  assert.equal(s.phase, 'over', `bot game stalled after ${steps} steps`);
});
