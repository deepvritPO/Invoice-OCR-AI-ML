#!/usr/bin/env node
/**
 * browser-a11y.mjs — keyboard + screen-reader smoke check for the real page.
 *
 * NOT part of `node --test`: it needs Playwright and a browser, which the app itself
 * never depends on. Run it by hand:
 *
 *     NODE_PATH=$(npm root -g) node ludo/test/browser-a11y.mjs
 *
 * It boots serve.mjs itself on a free port, drives the page with the keyboard only,
 * and asserts the accessibility contract the board has to keep:
 *
 *   1. exactly one token tab stop outside the pick phase
 *   2. one tab stop per movable token during it
 *   3. aria-label carries the movability state, and non-controls are not role=button
 *   4. a rejected pick writes a changed, non-empty #announcer (and #turn-detail)
 *   5. the keyboard path works: Space rolls, 1-4 picks, Arrows/Home/End rove, Esc closes
 *   6. a corrupt localStorage save never produces a dead game screen
 *   7. zero console errors and zero uncaught page errors throughout
 *
 * Exits 0 on success, non-zero on the first failing assertion group.
 */

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVE = resolve(HERE, '..', 'serve.mjs');
const SAVE_KEY = 'pentagon-ludo:v1';

/* ── tiny assertion harness ──────────────────────────────────────────────────── */

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
  const mark = ok ? 'PASS' : 'FAIL';
  process.stdout.write(`  ${mark}  ${name}${detail ? `  — ${detail}` : ''}\n`);
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

/* ── server ──────────────────────────────────────────────────────────────────── */

async function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

async function startServer(port) {
  const child = spawn(process.execPath, [SERVE, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('serve.mjs did not start in 10s')), 10000);
    child.stdout.on('data', (buf) => {
      if (String(buf).includes('Pentagon Ludo on')) { clearTimeout(timer); done(); }
    });
    child.on('exit', (code) => { clearTimeout(timer); fail(new Error(`serve.mjs exited ${code}`)); });
  });
  return child;
}

/* ── page helpers ────────────────────────────────────────────────────────────── */

/** Timers are scaled and motion reduced, or one human turn takes real seconds. */
async function openPage(browser, url, { storage = null } = {}) {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const errors = [];
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  if (storage) {
    await page.addInitScript(([key, value]) => {
      try { localStorage.setItem(key, value); } catch { /* ignore */ }
    }, storage);
  }
  await page.goto(url, { waitUntil: 'load' });
  return { context, page, errors };
}

const tabStops = (page) => page.$$eval('.token[tabindex="0"]', (ns) => ns.map((n) => n.dataset.tokenId));

const tokenInfo = (page, id) => page.$eval(`[data-token-id="${id}"]`, (n) => ({
  label: n.getAttribute('aria-label'),
  role: n.getAttribute('role'),
  disabled: n.getAttribute('aria-disabled'),
  tabindex: n.getAttribute('tabindex'),
}));

const announcer = (page) => page.$eval('#announcer', (n) => n.textContent.trim());

/**
 * Record every write to #announcer while `act` runs. Polling the text is not enough:
 * a repeated rejection is cleared and re-set to the SAME string, which a poll misses.
 */
async function capturedAnnouncements(page, act) {
  await page.evaluate(() => {
    window.__seen = [];
    const node = document.getElementById('announcer');
    if (window.__obs) window.__obs.disconnect();
    window.__obs = new MutationObserver(() => window.__seen.push(node.textContent));
    window.__obs.observe(node, { childList: true, characterData: true, subtree: true });
  });
  await act();
  await page.waitForFunction(() => window.__seen.length >= 2, null, { timeout: 4000 }).catch(() => {});
  const seen = await page.evaluate(() => {
    if (window.__obs) window.__obs.disconnect();
    return window.__seen;
  });
  return seen;
}
const detail = (page) => page.$eval('#turn-detail', (n) => n.textContent.trim());
const focusedId = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return (a && a.getAttribute && a.getAttribute('data-token-id')) || (a && a.id) || (a && a.tagName) || null;
});

/** Start a 1-human / 4-bot game from the setup form, by keyboard-free clicking. */
async function startGame(page) {
  await page.click('#btn-start');
  await page.waitForFunction(() => document.body.dataset.screen === 'game');
  await page.waitForFunction(() => document.querySelectorAll('.token').length === 20);
}

/** Wait until it is the human seat's turn and the dice is live. */
async function waitForHumanRoll(page) {
  await page.waitForFunction(
    () => !document.getElementById('dice').disabled,
    null,
    { timeout: 60000 },
  );
}

/* ── the checks ──────────────────────────────────────────────────────────────── */

async function run() {
  // ESM `import` ignores NODE_PATH; require() honours it, which is how the globally
  // installed Playwright is reached without adding a dependency to this repo.
  const { chromium } = createRequire(import.meta.url)('playwright');
  const port = await freePort();
  const server = await startServer(port);
  const url = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch();
  let allErrors = [];

  try {
    /* ---------------------------------------------------------------- 1 & 3 */
    section('Tab stops and labels outside the pick phase');
    let { context, page, errors } = await openPage(browser, url);
    await startGame(page);

    let stops = await tabStops(page);
    check('exactly one token tab stop before rolling', stops.length === 1,
      `got ${stops.length} [${stops.join(', ')}]`);

    const own = await tokenInfo(page, 'p0t1');
    const other = await tokenInfo(page, 'p2t1');
    check("the human's own token is role=button", own.role === 'button', `role=${own.role}`);
    check('another seat\'s token is role=img, not a fake button',
      other.role === 'img' && other.disabled === null,
      `role=${other.role} aria-disabled=${other.disabled}`);
    check('no aria-disabled outside the pick phase',
      (await page.$$('.token[aria-disabled]')).length === 0);

    /* -------------------------------------------------------------------- 5 */
    section('Roving the tab stop with the arrow keys');
    await page.focus(`[data-token-id="${stops[0]}"]`);
    await page.keyboard.press('ArrowRight');
    const afterRight = await focusedId(page);
    check('ArrowRight moves focus to the next token', afterRight === 'p0t2', `focus=${afterRight}`);
    check('the tab stop follows the focus',
      (await tabStops(page)).join() === 'p0t2', (await tabStops(page)).join());
    await page.keyboard.press('End');
    check('End jumps to the last token', (await focusedId(page)) === 'p4t4',
      await focusedId(page));
    await page.keyboard.press('Home');
    check('Home jumps back to the first', (await focusedId(page)) === 'p0t1',
      await focusedId(page));
    check('still exactly one tab stop after roving', (await tabStops(page)).length === 1);

    /* ---------------------------------------------------------------- 2,3,4 */
    section('The pick phase: tab stops, labels and rejections');
    await waitForHumanRoll(page);
    // Roll until the human actually gets a choice of two or more tokens.
    let pickPhase = false;
    for (let attempt = 0; attempt < 60 && !pickPhase; attempt += 1) {
      await waitForHumanRoll(page);
      await page.keyboard.press('Space');
      try {
        await page.waitForFunction(
          () => document.querySelectorAll('.token--movable').length > 1
            && document.getElementById('turn-detail').textContent.includes('Pick a token'),
          null,
          { timeout: 4000 },
        );
        pickPhase = true;
      } catch {
        // No move, one forced move, or a bot lap — let the loop come back round.
        await page.waitForFunction(() => document.body.dataset.screen === 'game');
      }
    }
    check('reached a human pick phase with a real choice', pickPhase);

    if (pickPhase) {
      const movable = await page.$$eval('.token--movable', (ns) => ns.map((n) => n.dataset.tokenId));
      stops = await tabStops(page);
      check('one tab stop per movable token during the pick',
        stops.length === movable.length && stops.every((id) => movable.includes(id)),
        `stops=[${stops.join(', ')}] movable=[${movable.join(', ')}]`);

      const movableInfo = await tokenInfo(page, movable[0]);
      check('a movable token says so in its aria-label',
        /ready to move$/.test(movableInfo.label || ''), movableInfo.label);

      const frozen = await page.$$eval('.token[data-player="0"]', (ns, live) => ns
        .map((n) => n.dataset.tokenId)
        .filter((id) => !live.includes(id)), movable);
      if (frozen.length) {
        const info = await tokenInfo(page, frozen[0]);
        check('a non-movable own token is aria-disabled and says why in its label',
          info.disabled === 'true' && /cannot move this turn$/.test(info.label || ''),
          `${info.label} (aria-disabled=${info.disabled})`);
      } else {
        check('a non-movable own token is aria-disabled and says why in its label', true,
          'skipped — every token was movable this turn');
      }

      // --- rejection: another player's token -------------------------------
      const before = await announcer(page);
      await page.click('[data-token-id="p2t1"]');
      await page.waitForFunction((prev) => {
        const t = document.getElementById('announcer').textContent.trim();
        return t.length > 0 && t !== prev;
      }, before, { timeout: 4000 }).catch(() => {});
      const afterOther = await announcer(page);
      check("clicking another seat's token is announced, not silent",
        afterOther.length > 0 && afterOther !== before && /token/i.test(afterOther), afterOther);
      check('the rejection also reaches sighted keyboard users in #turn-detail',
        (await detail(page)) === afterOther, await detail(page));

      // --- rejection: repeated identical message must re-announce -----------
      const seen = await capturedAnnouncements(page,
        () => page.click('[data-token-id="p2t1"]'));
      check('a repeated identical rejection is re-announced (cleared then re-set)',
        seen.length >= 2 && seen.includes('') && seen[seen.length - 1].length > 0,
        JSON.stringify(seen));

      // --- rejection: own non-movable token, by number ----------------------
      if (frozen.length) {
        const n = Number(frozen[0].slice(-1));
        await capturedAnnouncements(page, () => page.keyboard.press(String(n)));
        const msg = await announcer(page);
        check('pressing the number of a stuck token says WHY',
          msg.length > 0 && /need a 6|already home|overshoot|blocked|base/i.test(msg), msg);
      } else {
        check('pressing the number of a stuck token says WHY', true, 'skipped — none stuck');
      }

      // --- the happy keyboard path ------------------------------------------
      const pickNumber = Number(movable[0].slice(-1));
      await page.keyboard.press(String(pickNumber));
      const moved = await page.waitForFunction(
        (id) => !document.querySelector(`[data-token-id="${id}"]`).classList.contains('token--movable'),
        movable[0],
        { timeout: 15000 },
      ).then(() => true).catch(() => false);
      check('picking a movable token by number plays the move', moved);
      check('tab stops collapse back to one after the pick',
        (await tabStops(page)).length === 1, String((await tabStops(page)).length));
    }

    allErrors = allErrors.concat(errors);
    await context.close();

    /* ------------------------------------------------------- 2,3,4 (exact) */
    section('A deterministic mixed pick: two movable, two stuck in base');
    const mixed = await openPage(browser, url);
    const mixedSave = await mixed.page.evaluate(async () => {
      const eng = await import('./js/engine.js');
      const seats = [
        { name: 'You', kind: 'human', aiLevel: 'normal' },
        { name: 'Aarav', kind: 'ai', aiLevel: 'normal' },
        { name: 'Priya', kind: 'ai', aiLevel: 'normal' },
        { name: 'Rohan', kind: 'ai', aiLevel: 'normal' },
        { name: 'Meera', kind: 'ai', aiLevel: 'normal' },
      ];
      const g = eng.createGame({ seats, tokensPerPlayer: 4, seed: 7, startingPlayer: 0 });
      g.players[0].tokens[0].place = 'track';
      g.players[0].tokens[0].t = 5;
      g.players[0].tokens[1].place = 'track';
      g.players[0].tokens[1].t = 12;
      g.turn = 0;
      g.phase = 'move';   // straight into the pick, with a 4 on the dice
      g.dice = 4;
      return JSON.stringify({ state: eng.serialize(g), seats, savedAt: Date.now() });
    });
    allErrors = allErrors.concat(mixed.errors);
    await mixed.context.close();

    const pick = await openPage(browser, url, { storage: [SAVE_KEY, mixedSave] });
    await pick.page.click('#btn-resume');
    await pick.page.waitForFunction(
      () => document.getElementById('turn-detail').textContent.includes('Pick a token'),
      null, { timeout: 15000 },
    );

    const mixedStops = await tabStops(pick.page);
    check('only the two movable tokens are tab stops',
      mixedStops.join() === 'p0t1,p0t2', `[${mixedStops.join(', ')}]`);

    const live = await tokenInfo(pick.page, 'p0t1');
    const stuck = await tokenInfo(pick.page, 'p0t3');
    const rival = await tokenInfo(pick.page, 'p2t1');
    check('the movable token reads "ready to move"',
      live.label === 'You token 1, 5 steps along, ready to move' && live.disabled === null,
      `${live.label} / aria-disabled=${live.disabled}`);
    check('the stuck own token is aria-disabled and reads "cannot move this turn"',
      stuck.disabled === 'true' && stuck.label === 'You token 3, in base, cannot move this turn'
        && stuck.tabindex === '-1',
      `${stuck.label} / aria-disabled=${stuck.disabled} / tabindex=${stuck.tabindex}`);
    check('a rival token stays role=img with a plain label',
      rival.role === 'img' && rival.disabled === null && !/move/.test(rival.label || ''),
      `${rival.label} / role=${rival.role}`);

    // Pressing the number of a base token has to say exactly why it cannot move.
    const baseSeen = await capturedAnnouncements(pick.page,
      () => pick.page.keyboard.press('3'));
    const baseMsg = await announcer(pick.page);
    check('pressing 3 writes a fresh, non-empty #announcer',
      baseSeen.length >= 2 && baseSeen[baseSeen.length - 1].trim().length > 0,
      JSON.stringify(baseSeen));
    check('pressing 3 for a base token explains the 6 it needs',
      baseMsg === 'Token 3 is in base — you need a 6.', baseMsg);
    check('the same reason is written to #turn-detail',
      (await detail(pick.page)) === baseMsg, await detail(pick.page));

    // Arrow to a stuck token and activate it: still rejected, still spoken.
    await pick.page.focus('[data-token-id="p0t1"]');
    await pick.page.keyboard.press('ArrowRight');
    await pick.page.keyboard.press('ArrowRight');
    check('arrows reach a non-tab-stop token during the pick',
      (await focusedId(pick.page)) === 'p0t3', await focusedId(pick.page));
    check('roving during the pick does not add a tab stop',
      (await tabStops(pick.page)).join() === 'p0t1,p0t2', (await tabStops(pick.page)).join());
    const enterSeen = await capturedAnnouncements(pick.page,
      () => pick.page.keyboard.press('Enter'));
    check('Enter on a stuck token is re-announced, not swallowed as an unchanged string',
      enterSeen.includes('') && enterSeen[enterSeen.length - 1] === 'Token 3 is in base — you need a 6.',
      JSON.stringify(enterSeen));
    const stillPicking = {
      detail: await detail(pick.page),
      movable: (await pick.page.$$('.token--movable')).length,
      stops: (await tabStops(pick.page)).join(),
    };
    check('a rejected activation does not end the pick phase',
      stillPicking.detail.includes('you need a 6') && stillPicking.movable === 2
        && stillPicking.stops === 'p0t1,p0t2',
      JSON.stringify(stillPicking));

    // And the real pick still works from the keyboard.
    await pick.page.keyboard.press('1');
    check('pressing 1 plays the movable token', await pick.page.waitForFunction(
      () => document.getElementById('turn-banner').textContent !== 'You rolled 4',
      null, { timeout: 15000 },
    ).then(() => true).catch(() => false));
    allErrors = allErrors.concat(pick.errors);
    await pick.context.close();

    /* -------------------------------------------------------------------- 5 */
    section('A real game over: Escape closes the dialog and parks focus');
    const over = await openPage(browser, url);
    // Build a genuine one-move-from-over state with the app's own engine, so the
    // dialog is opened by endGame() exactly as it is in play (with #dice disabled).
    const endSave = await over.page.evaluate(async () => {
      const eng = await import('./js/engine.js');
      const seats = [
        { name: 'You', kind: 'human', aiLevel: 'normal' },
        { name: 'Aarav', kind: 'ai', aiLevel: 'normal' },
        { name: 'Priya', kind: 'ai', aiLevel: 'normal' },
        { name: 'Rohan', kind: 'ai', aiLevel: 'normal' },
        { name: 'Meera', kind: 'ai', aiLevel: 'normal' },
      ];
      const g = eng.createGame({ seats, tokensPerPlayer: 2, seed: 4242, startingPlayer: 0 });
      for (let i = 1; i < 5; i += 1) {
        const p = g.players[i];
        for (const t of p.tokens) { t.place = 'goal'; t.t = 70; }
        p.finished = true;
        p.rank = i;
        g.finishedOrder.push(i);
      }
      g.winner = 1;
      g.players[0].tokens[0].place = 'goal';
      g.players[0].tokens[0].t = 70;
      g.players[0].tokens[1].place = 'track';
      g.players[0].tokens[1].t = 10;
      g.turn = 0;
      g.phase = 'roll';
      g.dice = null;
      return JSON.stringify({ state: eng.serialize(g), seats, savedAt: Date.now() });
    });
    allErrors = allErrors.concat(over.errors);
    await over.context.close();

    const endGame = await openPage(browser, url, { storage: [SAVE_KEY, endSave] });
    await endGame.page.click('#btn-resume');
    await endGame.page.waitForFunction(() => document.querySelectorAll('.token').length === 10,
      null, { timeout: 15000 });
    await endGame.page.waitForFunction(() => !document.getElementById('dice').disabled,
      null, { timeout: 15000 });
    await endGame.page.keyboard.press('Space');
    const dialogOpened = await endGame.page
      .waitForFunction(() => document.getElementById('results').open, null, { timeout: 20000 })
      .then(() => true).catch(() => false);
    check('finishing the game opens the results dialog', dialogOpened);
    if (dialogOpened) {
      const diceOff = await endGame.page.$eval('#dice', (d) => d.disabled);
      check('the dice is disabled at game over (why focus is stranded)', diceOff);
      await endGame.page.keyboard.press('Escape');
      await endGame.page.waitForFunction(() => !document.getElementById('results').open,
        null, { timeout: 5000 });
      // The dialog's `close` event is asynchronous, so let the focus move settle.
      await endGame.page
        .waitForFunction(() => document.activeElement && document.activeElement.id === 'btn-rematch',
          null, { timeout: 3000 })
        .catch(() => {});
      const parked = await focusedId(endGame.page);
      const settled = parked !== 'BODY';
      check('Escape does not strand focus on <body>', settled && parked !== 'BODY', `focus=${parked}`);
      check('focus is parked on Rematch', parked === 'btn-rematch', `focus=${parked}`);
    }
    allErrors = allErrors.concat(endGame.errors);
    await endGame.context.close();

    /* -------------------------------------------------------------------- 6 */
    section('A corrupt save never produces a dead game screen');
    const payloads = {
      'empty players': '{"state":"{\\"version\\":1,\\"players\\":[]}","seats":[],"savedAt":1}',
      'turn out of range': JSON.stringify({
        state: JSON.stringify({
          version: 1, phase: 'roll', turn: 9, tokensPerPlayer: 4,
          players: Array.from({ length: 5 }, (_, i) => ({
            id: i, name: `P${i}`, kind: 'ai', aiLevel: 'normal',
            tokens: Array.from({ length: 4 }, (_, k) => ({ id: `p${i}t${k + 1}`, place: 'base', t: 0 })),
          })),
        }),
        seats: [],
      }),
      'junk string': 'not json at all {{{',
      'bad place value': JSON.stringify({
        state: JSON.stringify({
          version: 1, phase: 'move', turn: 0, tokensPerPlayer: 4, dice: 6,
          players: Array.from({ length: 5 }, (_, i) => ({
            id: i, name: `P${i}`, kind: 'ai', aiLevel: 'normal',
            tokens: Array.from({ length: 4 }, (_, k) => ({ id: `p${i}t${k + 1}`, place: 'nowhere', t: 0 })),
          })),
        }),
        seats: [],
      }),
    };

    for (const [name, raw] of Object.entries(payloads)) {
      const session = await openPage(browser, url, { storage: [SAVE_KEY, raw] });
      const offered = await session.page.$eval('#resume-card', (n) => !n.hidden);
      if (offered) {
        await session.page.click('#btn-resume');
        await session.page.waitForTimeout(400);
      }
      const state = await session.page.evaluate((key) => ({
        screen: document.body.dataset.screen,
        tokens: document.querySelectorAll('.token').length,
        stored: localStorage.getItem(key),
        errorShown: !document.getElementById('resume-error').hidden,
      }), SAVE_KEY);
      const dead = state.screen === 'game' && state.tokens === 0;
      check(`corrupt save (${name}): no dead screen`, !dead,
        `screen=${state.screen} tokens=${state.tokens}`);
      check(`corrupt save (${name}): the poison entry is cleared`, state.stored === null,
        String(state.stored).slice(0, 40));
      allErrors = allErrors.concat(session.errors);
      await session.context.close();
    }

    /* -------------------------------------------------------------------- 6b */
    section('A genuine save still resumes');
    const good = await openPage(browser, url);
    await startGame(good.page);
    await good.page.waitForFunction(() => localStorage.getItem('pentagon-ludo:v1') !== null);
    const savedRaw = await good.page.evaluate((k) => localStorage.getItem(k), SAVE_KEY);
    allErrors = allErrors.concat(good.errors);
    await good.context.close();

    const resumed = await openPage(browser, url, { storage: [SAVE_KEY, savedRaw] });
    const offered = await resumed.page.$eval('#resume-card', (n) => !n.hidden);
    check('a real save is offered for resume', offered);
    if (offered) {
      await resumed.page.click('#btn-resume');
      await resumed.page.waitForFunction(() => document.querySelectorAll('.token').length === 20,
        null, { timeout: 15000 });
      check('resuming a real save rebuilds all 20 tokens', true);
      check('the resumed board keeps exactly one tab stop',
        (await tabStops(resumed.page)).length === 1);
    }
    allErrors = allErrors.concat(resumed.errors);
    await resumed.context.close();

    /* -------------------------------------------------------------------- 7 */
    section('Heading structure and console hygiene');
    const heads = await openPage(browser, url);
    await startGame(heads.page);
    const h1 = await heads.page.$$eval('h1', (ns) => ns
      .filter((n) => n.getClientRects().length > 0 || n.className.includes('sr-only'))
      .filter((n) => !n.closest('[hidden]'))
      .map((n) => n.textContent.trim()));
    check('the game screen exposes exactly one h1', h1.length === 1, JSON.stringify(h1));
    allErrors = allErrors.concat(heads.errors);
    await heads.context.close();

    check('zero console errors and uncaught page errors', allErrors.length === 0,
      allErrors.slice(0, 5).join(' | '));
  } finally {
    await browser.close();
    server.kill();
  }

  /* ── summary ──────────────────────────────────────────────────────────────── */
  const passed = results.length - failures;
  process.stdout.write(`\n${'─'.repeat(64)}\n`);
  process.stdout.write(`browser-a11y: ${passed}/${results.length} checks passed\n`);
  if (failures) {
    process.stdout.write('\nFAILED:\n');
    for (const r of results) if (!r.ok) process.stdout.write(`  · ${r.name}${r.detail ? ` — ${r.detail}` : ''}\n`);
  }
  process.stdout.write(`${'─'.repeat(64)}\n`);
  process.exit(failures ? 1 : 0);
}

run().catch((err) => {
  process.stderr.write(`browser-a11y crashed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(2);
});
