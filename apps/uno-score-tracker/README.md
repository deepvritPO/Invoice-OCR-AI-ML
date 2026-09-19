# UNO Scorekeeper

A single-file scoreboard for UNO nights: every player logs the points left in their
hand after each round, and whoever crosses the limit you set is out.

Open `index.html` in any browser — no build step, no dependencies, no server.

```bash
# from the repo root
open apps/uno-score-tracker/index.html        # macOS
xdg-open apps/uno-score-tracker/index.html    # Linux
```

## Scoring rule it assumes

Someone goes out, everyone else counts the cards still in their hand and enters
that number. Totals accumulate; the **maximum value** is the losing threshold.

| Card | Points |
| --- | --- |
| Number cards 0–9 | face value |
| Draw Two, Reverse, Skip | 20 |
| Wild, Wild Draw Four | 50 |
| The player who went out | 0 |

## Features

- **Losing limit** — set any threshold (200 / 300 / 500 / 1000 presets, or type your own).
- **Two end rules**
  - *Knockout*: a player who reaches the limit drops out, the rest play on, last one standing wins.
  - *Game over*: the moment anyone reaches the limit the game stops and the lowest total wins.
- **Per-player fuse bar** showing how close each player is to busting, turning red past 80%.
- **Card counter** — tap the cards left in a hand (0–9, action cards, wilds) and the
  points total is filled in for you.
- **"Who went out?"** shortcut scores a clean zero for the round winner.
- **Round history** table with per-round delete and an undo for the last round.
- **Players** — add, rename, recolour (red / yellow / green / blue) or remove at any time.
- Standings, eliminations and the winner are all derived from the round history, so
  deleting or undoing a round rolls the game state back correctly.
- Saves to `localStorage`, so a game survives a refresh. It is per-browser: the
  scoreboard is meant to be passed around one table, not synced between phones.
- Light and dark themes, sized for a phone screen first.

## Structure

Everything lives in `index.html` — markup, styles and logic. State is a small object:

```js
{ limit: 500, mode: "knockout", players: [{id, name, color}], rounds: [{id, points: {playerId: n}}] }
```

Totals, eliminations and the winner are computed from `rounds` on every render; nothing
derived is stored.

The file opens with a sample four-player game so the board is not empty on first run.
Any edit (scoring a round, changing the limit, touching a player) replaces it —
or use **Setup → New game** to clear it out immediately.
