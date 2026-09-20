// ui.js — setup form, turn loop, persistence and keyboard wiring.
// Owns every DOM node outside the <svg id="board">, which belongs to render.js.

import { HOME_STEP, MAX_TOKENS } from './geometry.js';
import {
  DEFAULT_RULES,
  createGame,
  currentPlayer,
  rollDice,
  legalMoves,
  applyMove,
  passTurn,
  standings,
  serialize,
  deserialize,
} from './engine.js';
import { chooseMove, describeChoice } from './ai.js';
import { createRenderer } from './render.js';

const SAVE_KEY = 'pentagon-ludo:v1';
// index.html has to read this before the first paint, long before this module loads,
// so the literal lives there and is published on window. Derived fallback only.
const THEME_KEY = (typeof window !== 'undefined' && window.LUDO_THEME_KEY) || `${SAVE_KEY}:theme`;

const DEFAULT_NAMES = ['You', 'Aarav', 'Priya', 'Rohan', 'Meera'];
const SEAT_COUNT = 5;

const BOT_THINK_MS = 550;   // pause before a bot rolls, so the table reads as turn-taking
const PASS_MS = 700;        // pause on "no legal moves" before the turn passes
const AUTO_MOVE_MS = 320;   // beat before the single forced move plays itself
const SELECT_FLASH_MS = 140;
const MAX_LOG_LINES = 80;
const REJECT_HOLD_MS = 2600;  // how long a rejection stays in #turn-detail before the guidance returns

const el = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── storage: every access is best-effort, the page works fine without it ────── */

function readStore(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, value); } catch { /* quota or blocked — ignore */ }
}
function dropStore(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

/* ── mutable session state ───────────────────────────────────────────────────── */

let game = null;          // engine State
let config = null;        // {seats, tokensPerPlayer, rules} — persisted and replayed by Rematch
let renderer = null;
let loopId = 0;           // bumped to abandon an in-flight turn loop
let rollResolver = null;  // set while waiting for a human to roll
let moveResolver = null;  // {ids, resolve} while waiting for a human to pick a token
let humanPick = null;     // {ids, playerId} while a human is choosing — drives token a11y
let seenLogIds = new Set();
let announceFrame = 0;
let rejectTimer = 0;

/* ── theme ───────────────────────────────────────────────────────────────────── */

function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') {
    document.documentElement.dataset.theme = mode;
  } else {
    delete document.documentElement.dataset.theme;
  }
  for (const btn of el('theme-toggle').querySelectorAll('.theme-btn')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.themeMode === mode));
  }
  writeStore(THEME_KEY, mode);
}

function initTheme() {
  const stored = readStore(THEME_KEY);
  applyTheme(stored === 'light' || stored === 'dark' ? stored : 'auto');
  el('theme-toggle').addEventListener('click', (event) => {
    const btn = event.target.closest('.theme-btn');
    if (btn) applyTheme(btn.dataset.themeMode);
  });
}

/* ── setup form ──────────────────────────────────────────────────────────────── */

function seatControls(i) {
  return { name: el(`seat-${i}-name`), kind: el(`seat-${i}-kind`), level: el(`seat-${i}-level`) };
}

function syncSeatDisabledState() {
  for (let i = 0; i < SEAT_COUNT; i += 1) {
    const c = seatControls(i);
    c.level.disabled = c.kind.value !== 'ai';
  }
}

function readSeats() {
  const list = [];
  for (let i = 0; i < SEAT_COUNT; i += 1) {
    const c = seatControls(i);
    list.push({
      name: c.name.value.trim() || DEFAULT_NAMES[i],
      kind: c.kind.value === 'human' ? 'human' : 'ai',
      aiLevel: c.level.value,
    });
  }
  return list;
}

function readRules() {
  return {
    ...DEFAULT_RULES,
    blocks: el('rule-blocks').checked,
    captureExtraTurn: el('rule-capture').checked,
    threeSixesForfeit: el('rule-threesixes').checked,
  };
}

function readTokensPerPlayer() {
  const checked = document.querySelector('input[name="tokens"]:checked');
  return checked ? Number(checked.value) : 4;
}

function readSeed() {
  const raw = Number.parseInt(el('seed-input').value, 10);
  return Number.isFinite(raw) ? Math.abs(raw) : randomSeed();
}

function randomSeed() {
  return Math.floor(Math.random() * 1e9);
}

/* ── screens ─────────────────────────────────────────────────────────────────── */

// Leaving the game screen otherwise drops focus on <body>: the control that was
// clicked is hidden by the swap. Called from the handlers, never on first paint.
function focusSetup() {
  const target = el('seat-0-name');
  if (target && target.getClientRects().length > 0) target.focus({ preventScroll: true });
}

function showScreen(which) {
  el('screen-setup').hidden = which !== 'setup';
  el('screen-game').hidden = which !== 'game';
  document.body.dataset.screen = which;
  // On a phone the Start button sits well below the fold, so the new screen would
  // otherwise open scrolled past the board.
  try { window.scrollTo({ top: 0, behavior: 'instant' }); } catch { window.scrollTo(0, 0); }
}

function ensureRenderer() {
  if (!renderer) {
    renderer = createRenderer(el('board'), { onTokenClick: pickToken });
    renderer.mount();
  }
  return renderer;
}

/* ── panel rendering ─────────────────────────────────────────────────────────── */

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th'];

function renderPlayerCards() {
  for (let i = 0; i < SEAT_COUNT; i += 1) {
    const player = game.players[i];
    const card = el(`card-${i}`);
    el(`card-${i}-name`).textContent = player.name;
    el(`card-${i}-kind`).textContent =
      player.kind === 'human' ? 'Human' : `Bot · ${player.aiLevel}`;
    const home = player.tokens.filter((t) => t.place === 'goal').length;
    el(`card-${i}-home`).textContent = `${home}/${game.tokensPerPlayer} home`;
    el(`card-${i}-rank`).textContent =
      player.rank != null ? ORDINALS[player.rank - 1] || `#${player.rank}` : '';
    card.classList.toggle('player-card--active', game.phase !== 'over' && game.turn === i);
    card.classList.toggle('player-card--done', Boolean(player.finished));
  }
}

function pushLog(text, playerId) {
  const list = el('log-list');
  const li = document.createElement('li');
  li.className = 'log-line';
  if (playerId != null) li.classList.add(`p${playerId}`, 'log-line--player');
  li.textContent = text;
  list.append(li);
  while (list.children.length > MAX_LOG_LINES) list.firstElementChild.remove();
  list.scrollTop = list.scrollHeight;
}

// The engine writes the authoritative narration; mirror any entries we have not shown yet.
function drainEngineLog() {
  for (const entry of game.log || []) {
    if (seenLogIds.has(entry.id)) continue;
    seenLogIds.add(entry.id);
    pushLog(entry.text, entry.playerId);
  }
}

/* The default human seat is named "You" (SPEC 6): agree verbs and possessives. */
const isSecondPerson = (player) => String(player.name).trim().toLowerCase() === 'you';
const possessive = (player) => (isSecondPerson(player) ? 'Your' : `${player.name}'s`);
const verb = (player, third, second) => (isSecondPerson(player) ? second : third);

// describeChoice() narrates in the third person ("edges a token forward"); the seat
// named "You" needs the base form. Unknown verbs fall through unchanged.
const BASE_FORM = new Map([
  ['sends', 'send'], ['goes', 'go'], ['runs', 'run'], ['breaks', 'break'],
  ['ducks', 'duck'], ['closes', 'close'], ['edges', 'edge'], ['has', 'have'],
]);
function verbPhrase(player, phrase) {
  if (!isSecondPerson(player)) return phrase;
  const [first, ...rest] = String(phrase).split(' ');
  return [BASE_FORM.get(first) ?? first, ...rest].join(' ');
}

/**
 * #announcer is aria-live="polite": writing the same string twice is a no-op for most
 * screen readers, so clear it and set it on the next frame. Rejecting the same token
 * twice has to be spoken twice.
 */
function speak(text) {
  const node = el('announcer');
  if (announceFrame) cancelAnimationFrame(announceFrame);
  node.textContent = '';
  const say = () => { announceFrame = 0; node.textContent = text; };
  if (typeof requestAnimationFrame === 'function') announceFrame = requestAnimationFrame(say);
  else say();
}

function announce(text, detail) {
  el('turn-banner').textContent = text;
  if (detail !== undefined) el('turn-detail').textContent = detail;
  speak(detail ? `${text}. ${detail}` : text);
}

/** The guidance line shown while the human is choosing a token. */
function pickPrompt() {
  return `Pick a token — click it, or press 1–${game ? game.tokensPerPlayer : MAX_TOKENS}.`;
}

/**
 * Say WHY a pick did nothing. Silence here is the single worst keyboard bug in the
 * app: a rejected key or click gave no banner, no log line and no live-region text.
 */
function reject(reason) {
  el('turn-detail').textContent = reason;
  speak(reason);
  // One timer only: a second rejection must not be wiped by the first one's restore.
  if (rejectTimer) clearTimeout(rejectTimer);
  rejectTimer = 0;
  if (moveResolver) {
    rejectTimer = setTimeout(() => {
      rejectTimer = 0;
      if (moveResolver) el('turn-detail').textContent = pickPrompt();
    }, REJECT_HOLD_MS);
  }
}

/** Why this particular token cannot be played right now, in the player's words. */
function rejectReason(tokenId) {
  if (!game) return 'No game in progress.';
  const player = currentPlayer(game);
  const who = player ? player.name : 'another player';
  if (!moveResolver) {
    if (player && player.kind !== 'human') return `It's ${who}'s turn — wait for the bot.`;
    if (game.phase === 'roll') return 'Nothing to pick yet — roll the dice first.';
    return 'Nothing to pick right now.';
  }

  const parsed = /^p(\d+)t(\d+)$/.exec(String(tokenId || ''));
  if (!parsed) return 'That is not a token you can play.';
  const owner = Number(parsed[1]);
  const number = Number(parsed[2]);
  if (owner !== game.turn) {
    const other = game.players[owner];
    return other ? `That's ${other.name}'s token.` : 'That is not your token.';
  }
  const token = player.tokens.find((t) => t.id === tokenId);
  if (!token) {
    return `There is no token ${number} — press 1–${game.tokensPerPlayer}.`;
  }

  const roll = game.dice;
  if (token.place === 'goal') return `Token ${number} is already home.`;
  if (token.place === 'base') {
    return roll === 6
      ? `Token ${number} is in base and the start cell is blocked.`
      : `Token ${number} is in base — you need a 6.`;
  }
  if (token.t + roll > HOME_STEP) {
    return `Token ${number} can't move ${roll} without overshooting home.`;
  }
  // A 6 with a token waiting in base: the engine forces the exit and nothing else.
  if (roll === 6 && legalMoves(game).every((m) => m.kind === 'exit')) {
    return `On a 6 you must bring a token out of base first.`;
  }
  return `Token ${number} is blocked — an opponent block is in the way.`;
}

function setBusy(busy) {
  document.body.classList.toggle('is-busy', busy);
  el('dice').disabled = busy || !game || game.phase !== 'roll';
}

/** The seat this browser's user plays, so the renderer knows whose tokens are controls. */
function humanSeat() {
  if (humanPick) return humanPick.playerId;
  if (!game) return null;
  const seat = game.players.findIndex((p) => p.kind === 'human');
  return seat < 0 ? null : seat;
}

function syncBoard(movableTokenIds = [], selectedTokenId = null) {
  renderer.sync(game, {
    movableTokenIds,
    selectedTokenId,
    activePlayer: game.turn,
    pickPhase: humanPick !== null,
    humanSeat: humanSeat(),
  });
  renderPlayerCards();
  drainEngineLog();
}

/* ── human input ─────────────────────────────────────────────────────────────── */

/**
 * Abandon whatever the turn loop is awaiting. Nulling the resolvers without calling
 * them left the old loop suspended forever, pinning its game state; resolving with a
 * cancel sentinel lets it reach its next alive() check and return.
 */
function cancelPendingInput() {
  const roll = rollResolver;
  const move = moveResolver;
  rollResolver = null;
  moveResolver = null;
  humanPick = null;
  if (roll) roll();
  if (move) move.resolve(null);
}

function requestRoll() {
  if (!rollResolver) return;
  const resolve = rollResolver;
  rollResolver = null;
  resolve();
}

function pickToken(tokenId) {
  if (!moveResolver || !moveResolver.ids.includes(tokenId)) {
    reject(rejectReason(tokenId));
    return;
  }
  const { resolve } = moveResolver;
  moveResolver = null;
  resolve(tokenId);
}

function pickTokenByNumber(n) {
  if (!game) { reject('No game in progress.'); return; }
  pickToken(`p${game.turn}t${n}`);
}

function waitForRoll(player) {
  if (player.kind === 'ai') {
    setBusy(true);
    return sleep(BOT_THINK_MS);
  }
  setBusy(false);
  focusDice();
  return new Promise((resolve) => { rollResolver = resolve; });
}

// Hand focus to the dice when the human is up, unless they are busy with another control.
function focusDice() {
  const active = document.activeElement;
  // Leave focus alone only when it sits on a control the player can actually still
  // use: the just-clicked Start button is hidden by now, so it must not hold focus.
  const parked = !active
    || active === document.body
    || !active.isConnected
    || active.closest('.token') !== null
    || active.closest('[hidden]') !== null
    || active.getClientRects().length === 0;
  if (!parked) return;
  el('dice').focus({ preventScroll: true });
}

/**
 * Park focus on a token when the pick opens. Disabling the dice at roll time blurs it
 * to <body>, and <body> is not a `.token`, so the renderer's Arrow/Home/End roving was
 * unreachable for the whole pick phase. Same "only if the user is not busy" rule as
 * focusDice(), minus the `.token` clause — a token already focused is where we want it.
 */
function focusToken(tokenId) {
  const node = document.querySelector(`[data-token-id="${tokenId}"]`);
  if (!node) return;
  const active = document.activeElement;
  const parked = !active
    || active === document.body
    || !active.isConnected
    || active.closest('[hidden]') !== null
    || active.getClientRects().length === 0;
  if (!parked) return;
  node.focus({ preventScroll: true });
}

async function waitForTokenChoice(moves) {
  const ids = moves.map((m) => m.tokenId);
  humanPick = { ids, playerId: game.turn };
  syncBoard(ids, null);
  renderer.pulseTokens(ids);
  setBusy(false);
  focusToken(ids[0]);
  const tokenId = await new Promise((resolve) => { moveResolver = { ids, resolve }; });
  moveResolver = null;
  humanPick = null;
  renderer.clearPulse();
  if (tokenId === null) return null;   // cancelled by New game / Rematch
  setBusy(true);
  syncBoard(ids, tokenId);          // flash the selection before the token starts moving
  await sleep(SELECT_FLASH_MS);
  return tokenId;
}

/* ── the turn loop ───────────────────────────────────────────────────────────── */

async function playEvents(events, state) {
  for (const event of events) {
    if (event.type === 'move') await renderer.animateMove(event, state);
    else if (event.type === 'capture') await renderer.animateCapture(event, state);
  }
}

async function runLoop() {
  const myLoop = ++loopId;
  const alive = () => myLoop === loopId && game != null;

  while (alive() && game.phase !== 'over') {
    const player = currentPlayer(game);

    if (game.phase === 'roll') {
      announce(`${possessive(player)} turn`, player.kind === 'human' ? 'Roll the dice.' : 'Thinking…');
      syncBoard();
      renderer.setDice(game.dice, { rolling: false });
      await waitForRoll(player);
      if (!alive()) return;

      setBusy(true);
      renderer.setDice(null, { rolling: true });
      await renderer.shakeDice();
      if (!alive()) return;

      const rolled = rollDice(game);
      game = rolled.state;
      renderer.setDice(rolled.roll, { rolling: false });
      announce(`${player.name} rolled ${rolled.roll}`);
      drainEngineLog();

      // A third consecutive six forfeits the turn: the engine hands us back phase 'roll'.
      if (game.phase !== 'move') {
        announce(`${player.name} rolled a third six`, 'Turn forfeited.');
        persist();
        await sleep(PASS_MS);
        continue;
      }
    }

    const moves = legalMoves(game);

    if (moves.length === 0) {
      announce(`${player.name} ${verb(player, 'has', 'have')} no legal move`, 'Passing…');
      syncBoard();
      await sleep(PASS_MS);
      if (!alive()) return;
      const passed = passTurn(game);
      game = passed.state;
      await playEvents(passed.events, game);
      drainEngineLog();
      persist();
      continue;
    }

    let tokenId;
    if (moves.length === 1) {
      announce(`${player.name} ${verb(player, 'has', 'have')} one move`, 'Playing it.');
      syncBoard([moves[0].tokenId], moves[0].tokenId);
      await sleep(AUTO_MOVE_MS);
      tokenId = moves[0].tokenId;
    } else if (player.kind === 'ai') {
      announce(`${player.name} ${verb(player, 'is', 'are')} choosing`, `Rolled ${game.dice}.`);
      syncBoard(moves.map((m) => m.tokenId));
      await sleep(BOT_THINK_MS);
      if (!alive()) return;
      const move = chooseMove(game, moves, player.aiLevel);
      pushLog(`${player.name} ${verbPhrase(player, describeChoice(move))}`, player.id);
      tokenId = move.tokenId;
    } else {
      announce(`${player.name} rolled ${game.dice}`, pickPrompt());
      tokenId = await waitForTokenChoice(moves);
    }
    if (!alive()) return;

    const applied = applyMove(game, tokenId);
    game = applied.state;
    drainEngineLog();
    await playEvents(applied.events, game);
    if (!alive()) return;
    syncBoard();
    persist();
  }

  if (alive() && game.phase === 'over') endGame();
}

/* ── game lifecycle ──────────────────────────────────────────────────────────── */

function beginGame(state, seatList) {
  loopId += 1;              // abandon any loop still awaiting input
  cancelPendingInput();
  if (renderer) renderer.cancelAnimations();
  game = state;
  config = { seats: seatList, tokensPerPlayer: state.tokensPerPlayer, rules: state.rules };
  seenLogIds = new Set();
  el('log-list').replaceChildren();
  el('resume-error').hidden = true;   // a fresh table clears the "save discarded" notice
  ensureRenderer();
  showScreen('game');
  closeResults();
  // The static hint used to say "1-4" in every game, contradicting pickPrompt() in
  // 2- and 3-token games. Both now read game.tokensPerPlayer.
  const hintMax = el('dice-hint-max');
  if (hintMax) hintMax.textContent = String(game.tokensPerPlayer);
  syncBoard();
  renderer.setDice(game.dice, { rolling: false });
  persist();
  // runLoop() is async: a failure here lands in a detached promise that no try/catch
  // around beginGame() could ever see, so it has to be caught at the source.
  runLoop().catch(abandonGame);
}

function startFromForm(seed) {
  const seatList = readSeats();
  beginGame(
    createGame({
      seats: seatList,
      tokensPerPlayer: readTokensPerPlayer(),
      rules: readRules(),
      seed,
      startingPlayer: 0,
    }),
    seatList,
  );
}

// Same table, same rules, fresh dice.
function rematch() {
  const seed = randomSeed();
  el('seed-input').value = String(seed);
  if (!config) { startFromForm(seed); return; }
  beginGame(createGame({ ...config, seed, startingPlayer: 0 }), config.seats);
}

function endGame() {
  dropStore(SAVE_KEY);
  setBusy(false);
  announce('Game over', 'Final standings are in.');
  syncBoard();
  showResults();
}

let resultsDismissHandled = false;

/**
 * Deliberate closes hand focus on themselves; a bare Escape does not, because
 * endGame() disables #dice before showModal() and the dialog then has nothing to
 * restore focus to — it lands on <body>.
 */
function closeResults({ restoreFocus = false } = {}) {
  const dialog = el('results');
  if (!dialog.open) return;   // close() on a shut dialog fires no event: do not strand the flag
  resultsDismissHandled = !restoreFocus;
  dialog.close();
}

function initResultsFocus() {
  el('results').addEventListener('close', () => {
    const handled = resultsDismissHandled;
    resultsDismissHandled = false;
    if (handled) return;
    const target = el('btn-rematch');
    if (target && !target.disabled && target.getClientRects().length > 0) {
      target.focus({ preventScroll: true });
    }
  });
}

function showResults() {
  const rows = standings(game)
    .slice()
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || b.progress - a.progress);
  const list = el('results-list');
  list.replaceChildren();
  rows.forEach((row, i) => {
    const player = game.players[row.playerId];
    const li = document.createElement('li');
    li.className = `results-row p${row.playerId}`;
    const place = document.createElement('span');
    place.className = 'results-place';
    place.textContent = ORDINALS[(row.rank ?? i + 1) - 1] || `#${row.rank}`;
    const name = document.createElement('span');
    name.className = 'results-name';
    name.textContent = player.name;
    const detail = document.createElement('span');
    detail.className = 'results-detail';
    detail.textContent = `${row.home}/${game.tokensPerPlayer} home`;
    li.append(place, name, detail);
    list.append(li);
  });
  if (!el('results').open) el('results').showModal();
}

/* ── persistence ─────────────────────────────────────────────────────────────── */

function persist() {
  if (!game) return;
  if (game.phase === 'over') { dropStore(SAVE_KEY); return; }
  writeStore(SAVE_KEY, JSON.stringify({
    state: serialize(game),
    seats: config ? config.seats : [],
    savedAt: Date.now(),
  }));
}

const PLACES = new Set(['base', 'track', 'goal']);   // the only values engine.js writes
const PHASES = new Set(['roll', 'move']);            // 'over' is "nothing to resume"
const TOKEN_COUNTS = [2, 3, 4];                      // must match engine.js

/**
 * A save only has to survive JSON.parse and a version check to reach us; past that
 * it is hostile input. Every field the game screen indexes into is checked here,
 * before the resume card is offered — a half-written entry used to brick the app.
 */
function isPlayableState(state) {
  if (!state || typeof state !== 'object') return false;
  if (!PHASES.has(state.phase)) return false;
  if (!TOKEN_COUNTS.includes(state.tokensPerPlayer)) return false;
  if (!Number.isInteger(state.turn) || state.turn < 0 || state.turn >= SEAT_COUNT) return false;
  if (!Array.isArray(state.players) || state.players.length !== SEAT_COUNT) return false;
  return state.players.every((p, i) => p
    && typeof p === 'object'
    && p.id === i
    && typeof p.name === 'string'
    && Array.isArray(p.tokens)
    && p.tokens.length === state.tokensPerPlayer
    && p.tokens.every((t, k) => t
      && typeof t === 'object'
      && t.id === `p${i}t${k + 1}`   // pickTokenByNumber() addresses tokens by this exact id
      && PLACES.has(t.place)
      && Number.isInteger(t.t)));
}

function loadSave() {
  const raw = readStore(SAVE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const state = deserialize(parsed.state);
    if (!isPlayableState(state)) { dropStore(SAVE_KEY); return null; }
    return { state, seats: parsed.seats || state.players.map((p) => ({ name: p.name, kind: p.kind, aiLevel: p.aiLevel })) };
  } catch {
    dropStore(SAVE_KEY);   // pure junk used to linger forever and be re-parsed on every load
    return null;
  }
}

/**
 * Last line of defence: whatever slips past validation must not leave a half-built
 * game screen behind with a dead dice button. Tear the session down to a clean setup.
 */
function abandonGame(err) {
  console.warn('Saved game could not be loaded', err);
  loopId += 1;
  cancelPendingInput();
  if (renderer) renderer.cancelAnimations();
  game = null;
  config = null;
  dropStore(SAVE_KEY);
  el('resume-card').hidden = true;
  el('resume-error').hidden = false;
  closeResults();
  showScreen('setup');
  focusSetup();
}

function offerResume() {
  const saved = loadSave();
  if (!saved) return;
  const names = saved.state.players.map((p) => p.name).join(', ');
  el('resume-summary').textContent = `Move ${saved.state.moveCount} · ${names}`;
  el('resume-card').hidden = false;
  el('btn-resume').addEventListener('click', () => {
    el('resume-card').hidden = true;
    try {
      beginGame(saved.state, saved.seats);
    } catch (err) {
      abandonGame(err);
    }
  });
  el('btn-discard').addEventListener('click', () => {
    dropStore(SAVE_KEY);
    el('resume-card').hidden = true;
  });
}

/* ── wiring ──────────────────────────────────────────────────────────────────── */

function initSetupForm() {
  for (let i = 0; i < SEAT_COUNT; i += 1) {
    seatControls(i).kind.addEventListener('change', syncSeatDisabledState);
  }
  syncSeatDisabledState();

  el('btn-random-seed').addEventListener('click', () => {
    el('seed-input').value = String(randomSeed());
  });

  el('setup-form').addEventListener('submit', (event) => {
    event.preventDefault();
    startFromForm(readSeed());
  });
}

function initGameControls() {
  el('dice').addEventListener('click', requestRoll);

  el('btn-new-game').addEventListener('click', () => {
    loopId += 1;
    cancelPendingInput();
    if (renderer) renderer.cancelAnimations();   // stop any hop/capture still in flight
    closeResults();
    showScreen('setup');
    focusSetup();
  });

  el('btn-rematch').addEventListener('click', rematch);

  el('btn-play-again').addEventListener('click', () => {
    closeResults();
    rematch();
  });

  el('btn-new-setup').addEventListener('click', () => {
    closeResults();
    showScreen('setup');
    focusSetup();
  });
}

function initKeyboard() {
  document.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    if (event.key === 'Escape') {
      closeResults({ restoreFocus: true });
      return;
    }
    if (document.body.dataset.screen !== 'game') return;

    const target = event.target;
    const tag = target instanceof HTMLElement ? target.tagName : '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    const isActivate = event.key === ' ' || event.key === 'Enter';
    // A focused token only swallows Space/Enter while we are actually waiting for a pick,
    // otherwise the key falls through and rolls — a token keeps focus after it is played.
    const tokenEl = target instanceof Element ? target.closest('.token') : null;
    if (tokenEl && isActivate && moveResolver) {
      event.preventDefault();
      pickToken(tokenEl.dataset.tokenId);
      return;
    }
    if (isActivate) {
      // Let a focused button, summary or link handle its own activation key.
      if (target instanceof Element && target.closest('button, summary, a[href]')) return;
      event.preventDefault();
      requestRoll();
      return;
    }
    // Every digit is answered, whatever holds focus: 1..tokensPerPlayer plays,
    // anything else gets a spoken reason from rejectReason().
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      pickTokenByNumber(Number(event.key));
    }
  });
}

initTheme();
initSetupForm();
initGameControls();
initResultsFocus();
initKeyboard();
showScreen('setup');
offerResume();
