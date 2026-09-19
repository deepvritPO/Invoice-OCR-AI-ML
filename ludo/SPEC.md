# Pentagon Ludo — 5 Player Edition · Implementation Contract

A dependency-free, no-build, ES-module browser game. Every module below is written
against THIS contract. Do not change exported names or shapes.

## 0. Files

```
ludo/
  index.html          markup + module bootstrap
  css/styles.css      all styling (light + dark)
  js/geometry.js      pure board math + layout data   (no imports)
  js/engine.js        pure rules engine               (imports geometry.js only)
  js/ai.js            bot move selection              (imports geometry.js only)
  js/render.js        SVG drawing + animation         (imports geometry.js only)
  js/ui.js            wiring: engine + render + DOM   (imports all)
  test/*.test.mjs     `node --test` suites, zero deps
  serve.mjs           tiny static server (node, no deps)
  README.md
```

## 1. Board geometry (the 5-player generalisation)

Classic Ludo = 4 arms x 13 ring cells = 52. We generalise to **5 arms x 13 = 65**.

* `PLAYERS = 5`, `ARM_CELLS = 13`, `RING = 65`, `HOME_COLUMN = 5`, `HOME_STEP = 70`.
* Arm `i` owns ring indices `13i .. 13i+12`, laid out in a local frame where
  `u` = outward along the arm axis, `v` = perpendicular:
  * `13i+0 .. 13i+5` — outward column, `v = -w`, `u = u1..u6`
  * `13i+6`          — **tip**, `v = 0`, `u = u7`
  * `13i+7 .. 13i+12` — inward column, `v = +w`, `u = u6..u1`
  * The arm's middle column (`v = 0`, `u = u6..u2`, 5 cells) is player `i`'s **home column**.
* Arm `i` is rotated by `-90deg + i*72deg` about the board centre. Cell `13i+12`
  (u1, +w) sits next to cell `13(i+1)+0` (u1, -w) of the next arm, so the ring closes.
* `startIndex(p) = 13p + 7` — first cell of arm p's inward column (outer end, next to p's base).
* `entryIndex(p) = 13p + 6` — arm p's tip; the last ring cell before p's home column.
* A token therefore walks all 65 ring cells: from `startIndex(p)`, 64 steps lands on `entryIndex(p)`.
* **Safe cells**: `{13k+2, 13k+7 : k in 0..4}` — ten in total, two per arm. Every start cell
  is safe; the other is the classic "star" 8 steps ahead of each start. Tips are NOT safe.

### Progress coordinate
A token on the board has integer progress `t`:
* `t = 0..64` -> ring cell `(startIndex(p) + t) % 65`
* `t = 65..69` -> home column cell `t - 65` (0 = outermost, 4 = innermost)
* `t = 70` (`HOME_STEP`) -> the goal (centre). Requires an exact roll; overshoot is illegal.

## 2. `js/geometry.js` — exports (pure, no side effects)

```js
export const PLAYERS, ARM_CELLS, RING, HOME_COLUMN, HOME_STEP, MAX_TOKENS;
export const COLORS;          // 5 entries: {id, name, hex, dark, light, text}
export const SAFE_CELLS;      // Set<number>
export function startIndex(p);        // number
export function entryIndex(p);        // number
export function isSafe(ringIndex);    // boolean
export function progressToCell(p, t); // {kind:'ring',index} | {kind:'home',index} | {kind:'goal'}
export function cellCenter(p, t);     // {x, y} in board units — works for every t incl. goal
export function baseSlot(p, slot);    // {x, y} parking spot `slot` (0..3) in player p's base
export const layout;                  // fully pre-computed, see below
```

`layout` shape (board units, square viewBox):
```js
{
  size: 1000, viewBox: '0 0 1000 1000', center: {x:500, y:500}, cell: 46,   // cell edge length
  ring: [ {index, x, y, rot, arm, safe, tip, startFor|null} x65 ],          // rot in degrees
  homes: [ [ {x,y,rot,step} x5 ] x5 ],                                      // homes[p][0..4]
  bases: [ {p, x, y, r, slots:[{x,y} x4], gateFrom:{x,y}, gateTo:{x,y}} x5 ],
  goal:  { x, y, r, wedges:[ {p, d} x5 ] },                                 // d = SVG path
  armOutlines: [ {p, d} x5 ],                                               // decorative arm plate
  goalSlots: [ [ {x,y} x4 ] x5 ]                                            // parked-at-goal spots
}
```
Rules: no Math.random, no Date. Deterministic. Cells must not overlap; the ring must be
visually continuous (adjacent indices within ~1.6 cell widths of each other).

## 3. `js/engine.js` — pure rules (imports geometry only)

State is plain JSON (structured-cloneable, no class instances, no functions).

```js
export const DEFAULT_RULES = {
  blocks: true,             // 2+ own tokens on a ring cell block opponents landing AND passing
  captureExtraTurn: true,
  homeExtraTurn: true,
  sixExtraTurn: true,
  threeSixesForfeit: true,  // third consecutive 6 -> turn forfeited, no move
  mustExitOnSix: false,     // if true a 6 must be used to leave base when possible
};

export function makeRng(seed);                 // -> () => float in [0,1)  (mulberry32)
export function createGame(opts);              // see below -> State
export function currentPlayer(state);          // player object
export function rollDice(state, forced?);      // -> {state, roll}  phase 'roll' -> 'move'|'roll'
export function legalMoves(state);             // -> Move[]   (phase 'move'; [] means none)
export function applyMove(state, tokenId);     // -> {state, events}
export function passTurn(state);               // -> {state, events} when legalMoves is empty
export function standings(state);              // -> [{playerId, rank, home, progress}]
export function serialize(state) / deserialize(str);
```

`createGame(opts)`:
```js
{
  seats: [ {name, kind:'human'|'ai', aiLevel:'easy'|'normal'|'hard'} x5 ],  // exactly 5
  tokensPerPlayer: 4,        // 2 | 3 | 4
  rules: {...DEFAULT_RULES},
  seed: 12345,
  startingPlayer: 0,
}
```

`State`:
```js
{
  version:1, rules, tokensPerPlayer, seed, rngState,
  players: [ { id:0..4, name, kind, aiLevel, color,     // color = COLORS[id].id
               tokens: [ {id:'p0t1', index, place:'base'|'track'|'goal', t} ],
               finished:boolean, rank:number|null } x5 ],
  turn: 0..4,
  phase: 'roll'|'move'|'over',
  dice: number|null,
  sixStreak: 0..3,
  extraTurn: boolean,
  finishedOrder: [playerId...],
  log: [ {id, text, playerId|null} ],   // newest last, human readable
  moveCount, winner: playerId|null,
}
```

`Move`:
```js
{ tokenId, playerId, kind:'exit'|'advance'|'enterHome'|'goal',
  from: t|null, to: t, fromCell, toCell,          // cells from progressToCell
  captures: [tokenId...], grantsExtraTurn:boolean, blocked:false }
```

Rule details (implement exactly):
1. `phase:'roll'` -> `rollDice` sets `state.dice`. A 6 increments `sixStreak`, else resets to 0.
2. `threeSixesForfeit` && `sixStreak === 3` -> turn forfeits immediately: no move is offered,
   `sixStreak` resets, turn advances, phase back to `'roll'`.
3. Tokens in base may only exit on a 6, onto `startIndex(p)` (`t = 0`).
4. `t + roll <= HOME_STEP` required; a move landing exactly on `HOME_STEP` is `kind:'goal'`.
5. Capture: landing on a ring cell that is NOT safe and holds opponent tokens sends every
   opponent token on that cell back to base (`place:'base'`). Safe cells never capture.
6. Blocks (when `rules.blocks`): a ring cell holding >= 2 tokens of one player is a block.
   An opponent may neither land on nor pass through it. Own tokens pass freely.
   Home-column cells are never blocks.
7. Extra turn when: roll === 6 (`sixExtraTurn`), or the move captured (`captureExtraTurn`),
   or the move reached the goal (`homeExtraTurn`). Extra turn keeps `turn` unchanged and
   sets phase back to `'roll'`. Three-six forfeit overrides.
8. `legalMoves` empty -> UI calls `passTurn`.
9. A player whose every token is at the goal is `finished`, gets the next `rank`,
   is pushed to `finishedOrder` and is skipped in the rotation.
   First finisher sets `winner`. `phase` becomes `'over'` when only one unfinished player
   remains (that player takes the last rank).
10. `applyMove` must never mutate the input state (clone first). Same for `rollDice`/`passTurn`.

`events` entries (consumed by the UI for animation, in order):
```js
{type:'move', playerId, tokenId, from, to, path:[t...]}   // path = every t stepped through
{type:'capture', playerId, tokenId, fromCell}             // the VICTIM's ids
{type:'goal', playerId, tokenId}
{type:'finish', playerId, rank}
{type:'extraTurn', playerId}
{type:'turn', playerId}
{type:'gameOver', winner, standings}
```

## 4. `js/ai.js`

```js
export function chooseMove(state, moves, level);  // -> Move  (never null when moves.length)
export function describeChoice(move);             // -> short string for the log
```
Deterministic given `state.rngState` (use `makeRng` off a derived seed, never `Math.random`).
Heuristic weights: finish a token > capture (weighted by victim progress) > exit base when
base is crowded or the start is threatened > escape a cell under threat (opponent within 1..6
behind on the ring) > form a block > advance the token nearest home. `easy` picks a random
legal move 60% of the time; `normal` uses the heuristic with mild noise; `hard` is greedy
plus one-ply retaliation check.

## 5. `js/render.js`

```js
export function createRenderer(svgEl, opts);   // opts: {onTokenClick(tokenId), onCellHover?}
// returns:
{
  mount(),                                      // draw static board once
  sync(state, {movableTokenIds, selectedTokenId, activePlayer}),  // reposition all tokens
  animateMove(event, state) -> Promise,         // steps a token along event.path
  animateCapture(event, state) -> Promise,
  pulseTokens(tokenIds), clearPulse(),
  setDice(value, {rolling}), shakeDice() -> Promise,
  destroy()
}
```
Tokens are `<g class="token" data-token-id>` elements translated to `cellCenter`. Movement
animation steps cell-to-cell (~90ms per cell, honouring `prefers-reduced-motion` by jumping).
All colours come from CSS custom properties `--p0..--p4` so themes work.

## 6. `js/ui.js` + `index.html`

* Setup screen: 5 seats (name + Human/Bot + bot level), tokens per player (2/3/4),
  rule toggles, seed field, Start. Defaults: seat 1 human "You", seats 2-5 bots, 4 tokens.
* Game screen: SVG board, 5 player cards (colour, name, tokens home, turn indicator),
  dice button (Space / click), move log, New game, and a rules `<details>` panel.
* Flow: roll -> if no moves, toast + auto pass after 700ms -> else highlight movable tokens;
  human clicks a token (or presses 1..4), bot auto-plays after ~550ms.
* Keyboard: Space/Enter rolls, 1-4 select token, Esc closes dialogs. Everything focusable
  has a visible focus ring. `aria-live="polite"` region announces every turn.
* Responsive: board scales to `min(92vw, 78vh)`; panels stack under 900px. Dark mode via
  `prefers-color-scheme` plus a manual toggle persisted in `localStorage` (wrapped in try/catch).
* Game state persisted to `localStorage` after each move; offer "Resume game" if present.

## 7. Tests (`node --test ludo/test`)

Cover: ring closure & geometry adjacency, start/entry offsets, safe-cell set, progress mapping,
exit-on-six only, exact-roll-to-goal, capture + no-capture-on-safe, blocks (land + pass),
three-sixes forfeit, extra-turn cases, finish/rank ordering, full seeded 5-bot game reaching
`phase:'over'` within a sane move budget, and state immutability.
