// ui.js — setup form, turn loop, persistence and keyboard wiring.
// Owns every DOM node outside the <svg id="board">, which belongs to render.js.

import { HOME_STEP, MAX_TOKENS } from './geometry.js';
import {
  DEFAULT_RULES,
  createGame,
  describeMove,
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

const SPEED_KEY = (typeof window !== 'undefined' && window.LUDO_SPEED_KEY) || `${SAVE_KEY}:speed`;

/**
 * Pace multipliers. A 4-token 5-player game is ~1200 moves; at 1x that is roughly
 * three quarters of an hour, which nobody sits through on a phone.
 *
 * This scales deliberate WAITING only — the bot's think-time, the pause before a turn
 * passes and the animation clock. No branch anywhere reads the speed, so the dice, the
 * bot's choice and the RNG cursor are untouched: the same seed replays the same game at
 * every setting. test/browser-a11y.mjs asserts that byte-for-byte.
 */
const SPEEDS = { normal: 1, fast: 1 / 3, instant: 0 };
const DEFAULT_SPEED = 'normal';

const BOT_THINK_MS = 550;   // pause before a bot rolls, so the table reads as turn-taking
const PASS_MS = 700;        // pause on "no legal moves" before the turn passes
const AUTO_MOVE_MS = 320;   // beat before the single forced move plays itself
const SELECT_FLASH_MS = 140;
const MAX_LOG_LINES = 80;
const REJECT_HOLD_MS = 2600;  // how long a rejection stays in #turn-detail before the guidance returns

const el = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every deliberate UI pause goes through here, so one control governs the pace. */
const pace = (ms) => Math.round(ms * (SPEEDS[speedMode] ?? 1));

/**
 * True on a device whose primary pointer is a finger and that cannot hover — i.e. a
 * phone or tablet, where there is no keyboard and "press 1-4" is a lie. Queried live
 * rather than cached: a tablet with a keyboard attached mid-game changes the answer.
 */
function touchPrimary() {
  try {
    return typeof window.matchMedia === 'function'
      && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  } catch {
    return false;
  }
}

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
let autoPickTimer = 0;    // the beat before a human's single forced move plays itself
let speedMode = DEFAULT_SPEED;

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

/* ── pace ────────────────────────────────────────────────────────────────────── */

function applySpeed(mode, { persist: save = true } = {}) {
  speedMode = Object.prototype.hasOwnProperty.call(SPEEDS, mode) ? mode : DEFAULT_SPEED;
  const control = el('speed-control');
  if (control) {
    for (const btn of control.querySelectorAll('.pace-btn')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.speed === speedMode));
    }
  }
  // The renderer may not exist yet on first load; ensureRenderer() re-applies it.
  if (renderer) renderer.setSpeed(SPEEDS[speedMode]);
  if (save) writeStore(SPEED_KEY, speedMode);
}

function initSpeed() {
  const stored = readStore(SPEED_KEY);
  applySpeed(stored, { persist: false });
  const control = el('speed-control');
  if (!control) return;
  control.addEventListener('click', (event) => {
    const btn = event.target.closest('.pace-btn');
    // Re-pressing the pressed button changed nothing but still burned an utterance,
    // so four taps on "Fast" spoke "Speed: Fast" four times over the game narration.
    if (!btn || btn.dataset.speed === speedMode) return;
    applySpeed(btn.dataset.speed);
    const said = `Speed: ${btn.textContent.trim()}`;
    // Speaking over an open pick left the prompt no longer the last thing heard.
    speak(moveResolver ? `${said}. ${pickPrompt()}` : said);
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
    renderer.setSpeed(SPEEDS[speedMode]);
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

/* ── the move picker ─────────────────────────────────────────────────────────── */

/**
 * One large, labelled button per legal move, rendered under the dice card.
 *
 * This is the primary input on a phone. The board's tap targets are a cell wide
 * (~17 CSS px at 390px, still under the WCAG 2.2 minimum of 24) and no amount of
 * scaling fixes that: a 24px cell needs a ~520px-wide board. So the board stays a
 * display and the picking happens here, on full-width 48px controls — which is also
 * the best route for a screen reader, since each button says what the move DOES
 * instead of making the player deduce it from a coloured disc.
 *
 * The buttons, the board tokens and the 1-4 keys are three routes to ONE pick: each
 * calls pickToken(), which resolves the turn loop's single promise and then clears
 * all three. Nothing here holds state of its own.
 */
function renderMovePicker(moves) {
  const card = el('move-picker');
  const list = el('move-picker-list');
  const note = el('move-picker-note');
  if (!card || !list) return;

  list.replaceChildren();
  for (const move of moves) {
    const number = Number(/t(\d+)$/.exec(move.tokenId)?.[1] || 1);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `move-btn p${move.playerId}`;
    btn.dataset.tokenId = move.tokenId;

    const swatch = document.createElement('span');
    swatch.className = 'move-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    swatch.textContent = String(number);

    const who = document.createElement('span');
    who.className = 'move-token';
    who.textContent = `Token ${number}`;

    // Decorative only: a screen reader reading "middle dot" between every clause
    // would be noise, and the accessible name is built from the visible text.
    const sep = document.createElement('span');
    sep.className = 'move-sep';
    sep.setAttribute('aria-hidden', 'true');
    sep.textContent = '·';

    const what = document.createElement('span');
    what.className = 'move-what';
    what.textContent = describeMove(game, move);

    btn.append(swatch, who, sep, what);
    list.append(btn);
  }

  const single = moves.length === 1;
  card.classList.toggle('move-picker--single', single);
  card.hidden = false;
  // "Tap the dice, then tap one of the move buttons" is roll-phase guidance, and the
  // dice is disabled by now. Dropping it while the picker is open shortens the turn
  // card by about a line, which is what stops the sticky picker overlapping it on a
  // phone — the picker was clipping the last line of the very hint it answers.
  const hint = el('dice-hint');
  if (hint) hint.hidden = true;
  // On desktop a stack of one button is clutter, and the turn loop plays a forced
  // move by itself anyway — so say so rather than pretending there is a choice.
  // (setPickerNote only writes into a visible card, hence the order.)
  if (note) setPickerNote(defaultPickerNote());

  // On a phone the panel starts below the board, so the picker can open just under
  // the fold. Sticky positioning (see styles.css) pins it to the bottom of the
  // viewport there; this only nudges the page when it genuinely is out of sight.
  scrollPickerIntoView(card);
}

/**
 * Nudge the page just far enough that the picker is not below the fold — and no
 * further. A plain scrollIntoView() answers "show me this" by scrolling the board
 * clean off the top of a 560px screen, which trades one buried thing for a worse
 * one. So the scroll is capped at the board's own headroom — the empty space ABOVE
 * it — and the board's top edge therefore never leaves the viewport. The exception is
 * the landscape layout, where the board is itself position: sticky and cannot be
 * scrolled away at all; there the cap lifts.
 *
 * Measured with a three-move picker, rolled from the keyboard so nothing auto-scrolls:
 * iPhone 12 board 71..430 / picker 442..654 of 664; Pixel 5 107..469 / 505..717 of 727;
 * 360x560 28..359 / 372..550; 320x480 0..295 / 307..485, i.e. 97% of the picker. The
 * sticky rule in styles.css is what keeps the remainder reachable as the player
 * scrolls; it does not lift the card on its own before then.
 */
function scrollPickerIntoView(card) {
  try {
    const fold = window.innerHeight || document.documentElement.clientHeight;
    const box = card.getBoundingClientRect();
    if (box.top >= 0 && box.bottom <= fold) return;
    const wanted = Math.ceil(box.bottom - fold) + 10;
    if (wanted <= 0) return;
    const board = document.querySelector('.board-wrap');
    const rect = board ? board.getBoundingClientRect() : null;
    // Free space above the board costs nothing to scroll away. Past that we would be
    // eating the board itself: the old budget also spent a third of the board, which
    // on a 320x480 phone scrolled 33% of it off the top — exactly the trade this
    // function exists to refuse. Headroom is the whole budget; whatever is still cut
    // off is answered by the sticky rule in styles.css, which pins the picker to the
    // bottom of the viewport.
    // ...unless the board is pinned. In the short-and-wide landscape layout it is
    // position: sticky, so scrolling cannot push its top edge off at all and there is
    // nothing left for the cap to protect.
    const pinned = board && getComputedStyle(board).position === 'sticky';
    const budget = pinned ? wanted : (rect ? Math.max(0, Math.floor(rect.top)) : wanted);
    const by = Math.min(wanted, budget);
    if (by > 0) window.scrollBy({ top: by, left: 0, behavior: 'instant' });
  } catch { /* older engines: the sticky fallback still keeps it reachable */ }
}

/**
 * The picker's own caption. On a phone the sticky picker covers #turn-detail, so a
 * message written only there is invisible to a sighted player — the reason for a
 * refused tap reached the screen reader and nothing else. Anything the player must
 * read while the picker is open goes here as well.
 */
function setPickerNote(text, { reject: isReject = false } = {}) {
  const note = el('move-picker-note');
  const card = el('move-picker');
  if (!note || !card || card.hidden) return;
  note.textContent = text || '';
  note.hidden = !text;
  note.classList.toggle('move-picker-note--reject', Boolean(text) && isReject);
  // The note makes the card taller; on a short phone that can push its foot under
  // the fold, so re-apply the same capped nudge the picker got when it opened.
  if (text) scrollPickerIntoView(card);
}

/** What the note says when nothing has been refused: the forced-move caption, or nothing. */
function defaultPickerNote() {
  const card = el('move-picker');
  return card && card.classList.contains('move-picker--single')
    ? 'Only one move — playing it.'
    : '';
}

function clearMovePicker() {
  const card = el('move-picker');
  const list = el('move-picker-list');
  const hint = el('dice-hint');
  if (hint) hint.hidden = false;
  if (list) list.replaceChildren();
  if (card) {
    card.hidden = true;
    card.classList.remove('move-picker--single');
  }
  const note = el('move-picker-note');
  if (note) {
    note.textContent = '';
    note.hidden = true;
    note.classList.remove('move-picker-note--reject');
  }
  if (renderer) renderer.highlightToken(null);
}

function initMovePicker() {
  const list = el('move-picker-list');
  if (!list) return;
  // Delegated, so the handlers survive every re-render of the button set.
  list.addEventListener('click', (event) => {
    const btn = event.target.closest('.move-btn');
    if (btn) pickToken(btn.dataset.tokenId);
  });
  const preview = (event) => {
    const btn = event.target.closest('.move-btn');
    if (renderer) renderer.highlightToken(btn ? btn.dataset.tokenId : null);
  };
  const clear = () => { if (renderer) renderer.highlightToken(null); };
  list.addEventListener('pointerover', preview);
  list.addEventListener('pointerout', clear);
  list.addEventListener('focusin', preview);
  list.addEventListener('focusout', clear);
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

/**
 * Write the turn banner, and optionally speak it.
 *
 * At Instant a whole bot lap lands in half a second: measured, 5 full sentences in
 * 528ms against 19 over 18.3s at Normal. A polite queue needs ~10-15s to drain that,
 * so from the first lap on the screen reader narrates a board that no longer exists —
 * including while the human is being asked to roll. When there is no deliberate pause
 * left to narrate, the bots' running commentary is dropped; #log-list (also
 * aria-live="polite") still carries every move, so nothing is actually lost.
 * The human's own prompts always speak.
 */
function announce(text, detail, { speakIt = true } = {}) {
  el('turn-banner').textContent = text;
  if (detail !== undefined) el('turn-detail').textContent = detail;
  if (speakIt) speak(detail ? `${text}. ${detail}` : text);
}

/** True when the pace still leaves room between utterances. */
const narrating = () => (SPEEDS[speedMode] ?? 1) !== 0;

/** announce() for a seat that may be a bot: silent for bots when there is no pace. */
function announceTurn(player, text, detail) {
  announce(text, detail, { speakIt: player.kind === 'human' || narrating() });
}

/** The guidance line shown while the human is choosing a token. */
function pickPrompt() {
  // A phone has no keyboard, so "press 1-4" is not a fallback there — it is a dead
  // end. The move buttons are named first on touch because they are the real target.
  if (touchPrimary()) return 'Pick a token — tap a move below, or tap it on the board.';
  return `Pick a token — press a move below, click it, or press 1–${game ? game.tokensPerPlayer : MAX_TOKENS}.`;
}

/**
 * The hint under the dice. The old copy hard-coded "Click the dice, or press Space…
 * pressing 1-4", every word of which is false on a phone. Rebuilt from the live
 * pointer type, and re-rendered when that changes (a tablet gaining a keyboard).
 */
function renderDiceHint() {
  const hint = el('dice-hint');
  if (!hint) return;
  const tokens = game ? game.tokensPerPlayer : MAX_TOKENS;
  hint.replaceChildren();
  if (touchPrimary()) {
    hint.append('Tap the dice, then tap one of the move buttons that appear — or tap a token on the board.');
    return;
  }
  const kbd = (text, id) => {
    const node = document.createElement('kbd');
    node.textContent = text;
    if (id) node.id = id;
    return node;
  };
  hint.append('Click the dice, or press ', kbd('Space'), '. Then pick a token by clicking it or pressing ',
    kbd('1'), '–', kbd(String(tokens), 'dice-hint-max'), '.');
}

/**
 * Say WHY a pick did nothing. Silence here is the single worst keyboard bug in the
 * app: a rejected key or click gave no banner, no log line and no live-region text.
 */
function reject(reason) {
  el('turn-detail').textContent = reason;
  // ...and again inside the picker, which is what a phone player can actually see.
  setPickerNote(reason, { reject: true });
  speak(reason);
  // One timer only: a second rejection must not be wiped by the first one's restore.
  if (rejectTimer) clearTimeout(rejectTimer);
  rejectTimer = 0;
  if (moveResolver) {
    rejectTimer = setTimeout(() => {
      rejectTimer = 0;
      if (!moveResolver) return;
      el('turn-detail').textContent = pickPrompt();
      setPickerNote(defaultPickerNote());
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
  const dice = el('dice');
  const hadDice = document.activeElement === dice;
  dice.disabled = busy || !game || game.phase !== 'roll';
  // Disabling the focused dice blurs it to <body>, and the ~580ms of dice tumble
  // before the picker opens was spent there — long enough that Arrow/Home/End on the
  // board did nothing for a keyboard player who had just pressed Space (SPEC 8).
  if (hadDice && dice.disabled) recoverFocus();
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
  clearAutoPick();
  clearMovePicker();
  if (roll) roll();
  if (move) move.resolve(null);
}

function clearAutoPick() {
  if (autoPickTimer) clearTimeout(autoPickTimer);
  autoPickTimer = 0;
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
    return sleep(pace(BOT_THINK_MS));
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
  renderMovePicker(moves);
  setBusy(false);
  // Focus stays on the board so the renderer's Arrow/Home/End roving is reachable
  // (SPEC 8); Tab from there walks straight into the picker buttons.
  focusToken(ids[0]);
  // A forced single move still plays itself after a beat — but it goes through the
  // same pickToken() route, so pressing the button just plays it sooner.
  clearAutoPick();
  if (moves.length === 1) {
    autoPickTimer = setTimeout(() => {
      autoPickTimer = 0;
      pickToken(ids[0]);
    }, Math.max(pace(AUTO_MOVE_MS), 0));
  }
  const tokenId = await new Promise((resolve) => { moveResolver = { ids, resolve }; });
  clearAutoPick();
  moveResolver = null;
  humanPick = null;
  // Emptying the picker removes whatever button the player just pressed, which would
  // otherwise drop focus on <body> (SPEC 8). Hand it to the token they chose — the
  // same place a click on the board would have left it.
  const list = el('move-picker-list');
  const cameFromPicker = Boolean(list && document.activeElement && list.contains(document.activeElement));
  renderer.clearPulse();
  clearMovePicker();
  if (cameFromPicker && tokenId) {
    const node = document.querySelector(`[data-token-id="${tokenId}"]`);
    if (node) node.focus({ preventScroll: true });
  }
  if (tokenId === null) return null;   // cancelled by New game / Rematch
  setBusy(true);
  syncBoard(ids, tokenId);          // flash the selection before the token starts moving
  await sleep(pace(SELECT_FLASH_MS));
  return tokenId;
}

/* ── the turn loop ───────────────────────────────────────────────────────────── */

async function playEvents(events, state) {
  for (const event of events) {
    if (event.type === 'move') await renderer.animateMove(event, state);
    else if (event.type === 'capture') await renderer.animateCapture(event, state);
  }
  recoverFocus();
}

/**
 * SPEC 8's "focus never parks on <body>", enforced after the fact.
 *
 * render.js now carries focus across the re-parent that raises the moving token (the
 * one bug that actually caused this), but an animation is the moment when the DOM
 * churns most, and a bot capturing the token the player had focused is a second way
 * to lose it. One cheap net after every animation batch: put focus back on the
 * board's current tab stop, which is where the Arrow/Home/End roving lives. It only
 * ever acts on focus that is already gone, so it cannot steal it from a live control.
 */
function recoverFocus() {
  const active = document.activeElement;
  const lost = !active
    || active === document.body
    || !active.isConnected
    || active.getClientRects().length === 0;
  if (!lost) return;
  const stop = document.querySelector('.token[tabindex="0"]');
  if (stop) { stop.focus({ preventScroll: true }); return; }
  const dice = el('dice');
  if (dice && !dice.disabled) dice.focus({ preventScroll: true });
}

async function runLoop() {
  const myLoop = ++loopId;
  const alive = () => myLoop === loopId && game != null;

  while (alive() && game.phase !== 'over') {
    const player = currentPlayer(game);

    if (game.phase === 'roll') {
      announceTurn(player, `${possessive(player)} turn`, player.kind === 'human' ? 'Roll the dice.' : 'Thinking…');
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
      announceTurn(player, `${player.name} rolled ${rolled.roll}`);
      drainEngineLog();

      // A third consecutive six forfeits the turn: the engine hands us back phase 'roll'.
      if (game.phase !== 'move') {
        announceTurn(player, `${player.name} rolled a third six`, 'Turn forfeited.');
        persist();
        await sleep(pace(PASS_MS));
        continue;
      }
    }

    const moves = legalMoves(game);

    if (moves.length === 0) {
      announceTurn(player, `${player.name} ${verb(player, 'has', 'have')} no legal move`, 'Passing…');
      syncBoard();
      await sleep(pace(PASS_MS));
      if (!alive()) return;
      const passed = passTurn(game);
      game = passed.state;
      await playEvents(passed.events, game);
      drainEngineLog();
      persist();
      continue;
    }

    let tokenId;
    if (player.kind === 'ai' && moves.length === 1) {
      announceTurn(player, `${player.name} ${verb(player, 'has', 'have')} one move`, 'Playing it.');
      syncBoard([moves[0].tokenId], moves[0].tokenId);
      await sleep(pace(AUTO_MOVE_MS));
      tokenId = moves[0].tokenId;
    } else if (player.kind === 'ai') {
      announceTurn(player, `${player.name} ${verb(player, 'is', 'are')} choosing`, `Rolled ${game.dice}.`);
      syncBoard(moves.map((m) => m.tokenId));
      await sleep(pace(BOT_THINK_MS));
      if (!alive()) return;
      const move = chooseMove(game, moves, player.aiLevel);
      pushLog(`${player.name} ${verbPhrase(player, describeChoice(move))}`, player.id);
      tokenId = move.tokenId;
    } else if (moves.length === 1) {
      // A human's forced move still goes through the picker, so the panel always
      // shows what is about to happen — and a tap plays it without the wait.
      announce(`${player.name} ${verb(player, 'has', 'have')} one move`, 'Playing it.');
      tokenId = await waitForTokenChoice(moves);
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
  // 2- and 3-token games. Both now read game.tokensPerPlayer — and the whole line is
  // rebuilt for the pointer type, so a phone is never told to press Space.
  renderDiceHint();
  clearMovePicker();
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
  clearAutoPick();
  clearMovePicker();
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

/**
 * A tablet that gains or loses a keyboard changes what the hint should say. Cheap to
 * watch, and it keeps the copy honest without caching the answer anywhere.
 */
function initPointerWatch() {
  try {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(hover: none) and (pointer: coarse)');
    const onChange = () => {
      renderDiceHint();
      if (moveResolver) el('turn-detail').textContent = pickPrompt();
    };
    if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange);
    else if (typeof query.addListener === 'function') query.addListener(onChange);
  } catch { /* no matchMedia — the desktop wording stands */ }
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
initSpeed();
initMovePicker();
initSetupForm();
initGameControls();
initResultsFocus();
initKeyboard();
initPointerWatch();
showScreen('setup');
offerResume();
