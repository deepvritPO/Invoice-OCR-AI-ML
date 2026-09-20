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
 *   8. the move picker: labelled buttons, real tap targets, in the tab order
 *   9. the three pick routes (board, digits, picker) agree and cancel each other
 *  10. the speed control persists, and does not change a seeded game
 *  11. a real touch device can play a whole turn by tap alone
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
const SPEED_KEY = 'pentagon-ludo:v1:speed';
/** Filled from Playwright's own device registry once the require() lands in run(). */
let DEVICES = {};

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
async function openPage(browser, url, { storage = null, device = null, viewport = null, motion = false } = {}) {
  const context = await browser.newContext({
    // Reduced motion by default, or one human turn takes real seconds. `motion: true`
    // opts back in: render.js returns BEFORE its re-parenting when motion is reduced,
    // so the focus checks below would test nothing without a real animation.
    ...(motion ? {} : { reducedMotion: 'reduce' }),
    ...(device ? DEVICES[device] : {}),
    ...(viewport ? { viewport } : {}),
  });
  const errors = [];
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  if (storage) {
    // One [key, value] pair, or a list of them.
    const pairs = typeof storage[0] === 'string' ? [storage] : storage;
    await page.addInitScript((entries) => {
      for (const [key, value] of entries) {
        try { localStorage.setItem(key, value); } catch { /* ignore */ }
      }
    }, pairs);
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
  const { chromium, devices } = createRequire(import.meta.url)('playwright');
  DEVICES = devices;
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

    /* -------------------------------------------------------------------- 8 */
    section('The move picker: labelled buttons with real tap targets');
    // Same deterministic position as above: p0t1 on t=5, p0t2 on t=12, a 4 on the
    // dice — exactly two legal moves, so the picker has to offer exactly two buttons.
    const mp = await openPage(browser, url, { storage: [SAVE_KEY, mixedSave] });
    await mp.page.click('#btn-resume');
    await mp.page.waitForFunction(() => !document.getElementById('move-picker').hidden,
      null, { timeout: 15000 });

    const buttons = await mp.page.$$eval('.move-btn', (ns) => ns.map((n) => {
      const box = n.getBoundingClientRect();
      return {
        id: n.dataset.tokenId,
        text: n.textContent.replace(/\s+/g, ' ').trim(),
        width: Math.round(box.width),
        height: Math.round(box.height),
        tabindex: n.getAttribute('tabindex'),
        disabled: n.disabled,
      };
    }));
    check('the picker offers one button per legal move',
      buttons.length === 2 && buttons.map((b) => b.id).join() === 'p0t1,p0t2',
      JSON.stringify(buttons.map((b) => b.id)));
    check('every picker button clears the 44px minimum target size',
      buttons.length > 0 && buttons.every((b) => b.height >= 44 && b.width >= 200),
      buttons.map((b) => `${b.width}x${b.height}`).join(' '));
    check('no picker button is removed from the tab order',
      buttons.every((b) => b.tabindex === null && !b.disabled),
      JSON.stringify(buttons.map((b) => b.tabindex)));

    // The accessible name is what a screen reader announces: the token number plus
    // what the move DOES, with the decorative swatch digit and separator excluded.
    const names = await mp.page.evaluate(async () => {
      const out = [];
      for (const btn of document.querySelectorAll('.move-btn')) {
        out.push(btn.textContent.replace(/\s+/g, ' ').trim());
      }
      return out;
    });
    const snapshot = await mp.page.accessibility.snapshot();
    const collect = (node, out = []) => {
      if (node.role === 'button' && /^Token \d/.test(node.name || '')) out.push(node.name);
      for (const kid of node.children || []) collect(kid, out);
      return out;
    };
    const accNames = collect(snapshot);
    check('each button is exposed as a button named "Token N <what it does>"',
      accNames.length === 2
        && accNames.every((n) => /^Token [12] \d+ → \d+$/.test(n)),
      JSON.stringify(accNames));
    check('the decorative swatch digit is kept out of the accessible name',
      accNames.every((n) => !/^\d/.test(n)), JSON.stringify(accNames));
    check('the label describes the move, not just the token',
      names.every((n) => n.replace(/^\d/, '').includes('→')), JSON.stringify(names));

    // Focusing a button has to point at the same token on the board.
    await mp.page.focus('.move-btn[data-token-id="p0t2"]');
    check('focusing a picker button highlights that token on the board',
      (await mp.page.$$eval('.token--preview', (ns) => ns.map((n) => n.dataset.tokenId))).join() === 'p0t2',
      (await mp.page.$$eval('.token--preview', (ns) => ns.map((n) => n.dataset.tokenId))).join());
    check('the highlight is decorative — it adds no tab stop and no aria-disabled',
      (await tabStops(mp.page)).join() === 'p0t1,p0t2'
        && (await mp.page.$$('.token--preview[aria-disabled]')).length === 0,
      (await tabStops(mp.page)).join());

    // Tab must reach the picker from the board without hunting.
    await mp.page.focus('[data-token-id="p0t1"]');
    let hops = 0;
    let landed = null;
    for (; hops < 10; hops += 1) {
      await mp.page.keyboard.press('Tab');
      landed = await mp.page.evaluate(() => {
        const a = document.activeElement;
        return a && a.classList && a.classList.contains('move-btn') ? a.dataset.tokenId : null;
      });
      if (landed) break;
    }
    check('Tab from the board reaches the picker in a sane number of hops',
      landed !== null && hops <= 4, `${hops + 1} hops, landed on ${landed}`);

    allErrors = allErrors.concat(mp.errors);
    await mp.context.close();

    /* -------------------------------------------------------------------- 9 */
    section('Three routes to one pick: board, digits and picker agree');
    // Token 2 sits on t=12 and the dice shows 4, so whichever route fires, the move
    // has to be 12 -> 16, i.e. ring cell (startIndex(0) + 16) % 65 = 23.
    const EXPECT = 'You moved a token to cell 23';
    const WRONG = 'You moved a token to cell 16';   // what token 1 would have done
    const routes = {
      'the board token': async (page) => page.click('.token[data-token-id="p0t2"]'),
      'the 2 key': async (page) => page.keyboard.press('2'),
      'the picker button': async (page) => page.click('.move-btn[data-token-id="p0t2"]'),
    };
    for (const [label, act] of Object.entries(routes)) {
      const r = await openPage(browser, url, { storage: [SAVE_KEY, mixedSave] });
      await r.page.click('#btn-resume');
      await r.page.waitForFunction(() => !document.getElementById('move-picker').hidden,
        null, { timeout: 15000 });
      await act(r.page);
      const played = await r.page.waitForFunction(
        (want) => [...document.querySelectorAll('.log-line')].some((n) => n.textContent === want),
        EXPECT, { timeout: 15000 },
      ).then(() => true).catch(() => false);
      check(`picking through ${label} plays token 2's move`, played, EXPECT);
      const after = await r.page.evaluate((wrong) => ({
        pickerHidden: document.getElementById('move-picker').hidden,
        buttons: document.querySelectorAll('.move-btn').length,
        movable: document.querySelectorAll('.token--movable').length,
        wrongPlayed: [...document.querySelectorAll('.log-line')].some((n) => n.textContent === wrong),
      }), WRONG);
      check(`${label} cancels the other two routes`,
        after.pickerHidden && after.buttons === 0 && after.movable === 0 && !after.wrongPlayed,
        JSON.stringify(after));
      // A second activation must be rejected with a reason, never played.
      const late = await capturedAnnouncements(r.page, () => r.page.keyboard.press('1'));
      check(`a late press after ${label} is rejected, not played`,
        !(await r.page.evaluate((wrong) => [...document.querySelectorAll('.log-line')]
          .some((n) => n.textContent === wrong), WRONG))
        && late[late.length - 1] && late[late.length - 1].trim().length > 0,
        JSON.stringify(late.slice(-1)));
      allErrors = allErrors.concat(r.errors);
      await r.context.close();
    }

    /* ------------------------------------------------------------------- 10 */
    section('The speed control');
    const sp = await openPage(browser, url);
    await startGame(sp.page);
    const defaultPressed = await sp.page.$eval('.pace-btn[data-speed="normal"]',
      (n) => n.getAttribute('aria-pressed'));
    check('the speed control starts on Normal', defaultPressed === 'true', defaultPressed);
    await sp.page.click('.pace-btn[data-speed="instant"]');
    const stored = await sp.page.evaluate((k) => localStorage.getItem(k), SPEED_KEY);
    check('choosing a speed writes it to localStorage', stored === 'instant', String(stored));
    const pressed = await sp.page.$$eval('.pace-btn',
      (ns) => ns.map((n) => `${n.dataset.speed}:${n.getAttribute('aria-pressed')}`).join(' '));
    check('exactly one speed button is aria-pressed',
      pressed === 'normal:false fast:false instant:true', pressed);
    allErrors = allErrors.concat(sp.errors);
    await sp.context.close();

    const sp2 = await openPage(browser, url, { storage: [SPEED_KEY, 'fast'] });
    const restored = await sp2.page.$$eval('.pace-btn',
      (ns) => ns.map((n) => `${n.dataset.speed}:${n.getAttribute('aria-pressed')}`).join(' '));
    check('a stored speed is restored on the next visit',
      restored === 'normal:false fast:true instant:false', restored);
    allErrors = allErrors.concat(sp2.errors);
    await sp2.context.close();

    // The whole promise of the control: it changes the clock, nothing else.
    section('The same seed replays the same game at Normal and at Instant');
    const LOG_PREFIX = 36;
    const replay = async (speed) => {
      const r = await openPage(browser, url, { storage: [SPEED_KEY, speed] });
      await r.page.selectOption('#seat-0-kind', 'ai');   // five bots, no human to wait for
      await r.page.fill('#seed-input', '424242');
      await r.page.click('#btn-start');
      await r.page.waitForFunction((n) => {
        try {
          const raw = localStorage.getItem('pentagon-ludo:v1');
          if (!raw) return false;
          return JSON.parse(JSON.parse(raw).state).log.length >= n;
        } catch { return false; }
      }, LOG_PREFIX, { timeout: 180000 });
      const log = await r.page.evaluate((n) => JSON.parse(JSON.parse(
        localStorage.getItem('pentagon-ludo:v1')).state).log
        .slice(0, n).map((e) => `${e.id}:${e.playerId}:${e.text}`), LOG_PREFIX);
      allErrors = allErrors.concat(r.errors);
      await r.context.close();
      return log;
    };
    const fastLog = await replay('instant');
    const slowLog = await replay('normal');
    check(`the first ${LOG_PREFIX} engine log entries are identical at both speeds`,
      fastLog.length === LOG_PREFIX && fastLog.join('\n') === slowLog.join('\n'),
      fastLog.join('\n') === slowLog.join('\n')
        ? `${fastLog.length} entries matched`
        : `first divergence: ${fastLog.find((line, i) => line !== slowLog[i])} vs ${slowLog.find((line, i) => line !== fastLog[i])}`);

    /* ------------------------------------------------------------------- 11 */
    section('Playing by tap alone on a real touch device');
    // A deterministic opening so the touch runs need no lucky dice: the human seat is
    // up, in phase 'roll', with three tokens on the track. Every face of the dice then
    // gives that seat a genuine choice, so one tap on the dice opens the picker.
    const touchStart = await openPage(browser, url);
    const touchSave = await touchStart.page.evaluate(async () => {
      const eng = await import('./js/engine.js');
      const seats = [
        { name: 'You', kind: 'human', aiLevel: 'normal' },
        { name: 'Aarav', kind: 'ai', aiLevel: 'normal' },
        { name: 'Priya', kind: 'ai', aiLevel: 'normal' },
        { name: 'Rohan', kind: 'ai', aiLevel: 'normal' },
        { name: 'Meera', kind: 'ai', aiLevel: 'normal' },
      ];
      const g = eng.createGame({ seats, tokensPerPlayer: 4, seed: 31337, startingPlayer: 0 });
      [5, 12, 20].forEach((t, i) => {
        g.players[0].tokens[i].place = 'track';
        g.players[0].tokens[i].t = t;
      });
      g.turn = 0;
      g.phase = 'roll';
      g.dice = null;
      return JSON.stringify({ state: eng.serialize(g), seats, savedAt: Date.now() });
    });
    allErrors = allErrors.concat(touchStart.errors);
    await touchStart.context.close();

    for (const deviceName of ['iPhone 12', 'Pixel 5']) {
      const t = await openPage(browser, url, {
        device: deviceName,
        storage: [[SAVE_KEY, touchSave], [SPEED_KEY, 'instant']],
      });
      const size = t.page.viewportSize();
      check(`${deviceName}: the page reports a coarse, hoverless pointer`,
        await t.page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches),
        `${size.width}x${size.height}`);

      await t.page.locator('#btn-resume').tap();
      await t.page.waitForFunction(() => document.querySelectorAll('.token').length === 20,
        null, { timeout: 15000 });

      const hint = await t.page.$eval('#dice-hint', (n) => n.textContent.trim());
      check(`${deviceName}: the dice hint drops the click/keyboard wording`,
        /tap/i.test(hint) && !/Space|press/i.test(hint), hint);

      const targets = await t.page.evaluate(() => {
        const box = (sel) => {
          const n = document.querySelector(sel);
          if (!n) return null;
          const r = n.getBoundingClientRect();
          return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
        };
        return { disc: box('.token-disc'), hit: box('.token-hit'), dice: box('#dice') };
      });
      check(`${deviceName}: the token tap target is ${targets.hit.w}px, up from the ${targets.disc.w}px disc`,
        targets.hit && targets.disc && targets.hit.w > targets.disc.w * 1.3,
        `hit ${targets.hit.w}px vs disc ${targets.disc.w}px`);
      check(`${deviceName}: the dice keeps a 44px target`,
        targets.dice.w >= 44 && targets.dice.h >= 44,
        `${targets.dice.w}x${targets.dice.h}`);

      // --- turn one, played entirely on the picker -------------------------
      await t.page.waitForFunction(() => !document.getElementById('dice').disabled,
        null, { timeout: 20000 });
      await t.page.locator('#dice').tap();
      const offered = await t.page
        .waitForFunction(() => document.querySelectorAll('.move-btn').length >= 2,
          null, { timeout: 15000 })
        .then(() => true).catch(() => false);
      check(`${deviceName}: one tap on the dice opens a real choice`, offered,
        `${(await t.page.$$('.move-btn')).length} buttons`);

      if (offered) {
        const geom = await t.page.evaluate(() => {
          const card = document.getElementById('move-picker').getBoundingClientRect();
          const btn = document.querySelector('.move-btn').getBoundingClientRect();
          return {
            button: { w: +btn.width.toFixed(1), h: +btn.height.toFixed(1) },
            visible: card.top >= 0 && card.bottom <= window.innerHeight,
            card: [Math.round(card.top), Math.round(card.bottom)],
            board: (() => {
              const b = document.querySelector('.board-wrap').getBoundingClientRect();
              return [Math.round(b.top), Math.round(b.bottom)];
            })(),
            fold: window.innerHeight,
          };
        });
        check(`${deviceName}: picker buttons measure ${geom.button.w}x${geom.button.h} CSS px`,
          geom.button.h >= 44 && geom.button.w >= 240,
          `${geom.button.w}x${geom.button.h}`);
        check(`${deviceName}: the picker is on screen after the roll, no hunting`,
          geom.visible, `picker ${geom.card.join('..')}, board ${geom.board.join('..')}, fold ${geom.fold}`);
        check(`${deviceName}: and it does not cover the board to get there`,
          geom.card[0] >= geom.board[1],
          `picker top ${geom.card[0]} vs board bottom ${geom.board[1]}`);

        const pickedId = await t.page.$eval('.move-btn', (n) => n.dataset.tokenId);
        await t.page.locator('.move-btn').first().tap();
        check(`${deviceName}: tapping a picker button plays that move`,
          await t.page.waitForFunction(
            (id) => document.getElementById('move-picker').hidden
              && !document.querySelector(`[data-token-id="${id}"]`).classList.contains('token--movable'),
            pickedId, { timeout: 15000 },
          ).then(() => true).catch(() => false));
      }

      // --- turn two, played on the board itself ----------------------------
      const cameRound = await t.page.waitForFunction(
        () => !document.getElementById('dice').disabled && !document.getElementById('results').open,
        null, { timeout: 30000 },
      ).then(() => true).catch(() => false);
      check(`${deviceName}: the turn comes back round to the human seat`, cameRound);

      let boardTap = false;
      if (cameRound) {
        await t.page.locator('#dice').tap();
        const live = await t.page
          .waitForFunction(() => document.querySelectorAll('.move-btn').length >= 1,
            null, { timeout: 15000 })
          .then(() => true).catch(() => false);
        if (live) {
          const id = await t.page.$eval('.move-btn', (n) => n.dataset.tokenId).catch(() => null);
          if (id) {
            // Both the board token and its picker button carry data-token-id, so the
            // board one has to be named explicitly — this check is about the board.
            await t.page.locator(`.token[data-token-id="${id}"]`).tap();
            boardTap = await t.page.waitForFunction(
              (tid) => !document.querySelector(`[data-token-id="${tid}"]`)
                .classList.contains('token--movable'),
              id, { timeout: 15000 },
            ).then(() => true).catch(() => false);
          }
        }
      }
      check(`${deviceName}: tapping the token on the board plays it too`, boardTap);

      const overflow = await t.page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`${deviceName}: no horizontal scroll`, overflow === 0, `${overflow}px`);

      allErrors = allErrors.concat(t.errors);
      await t.context.close();
    }

    /* ------------------------------------------------------------------- 12 */
    section('Focus never parks on <body> (SPEC 8), animations and all');
    {
      // Real motion: render.js raises the moving token by re-appending its <g>, which
      // Chrome implements as remove+insert and which used to blur it to <body> for the
      // whole bot lap (measured single stretches of 14.8s).
      const f = await openPage(browser, url, { storage: [SAVE_KEY, touchSave], motion: true });
      await f.page.click('#btn-resume');
      await f.page.waitForFunction(() => document.querySelectorAll('.token').length === 20);
      await waitForHumanRoll(f.page);
      await f.page.evaluate(() => {
        window.__focus = [];
        window.__focusTimer = setInterval(() => {
          const a = document.activeElement;
          window.__focus.push(!a ? 'NULL'
            : (a.getAttribute && a.getAttribute('data-token-id')) || a.id || a.tagName);
        }, 20);
      });
      await f.page.click('#dice');
      await f.page.waitForFunction(() => document.querySelectorAll('.move-btn').length >= 1,
        null, { timeout: 15000 });
      await f.page.locator('.move-btn').first().click();
      // …and on through a whole bot lap, back to the human seat.
      await waitForHumanRoll(f.page);
      await f.page.waitForTimeout(400);
      const trace = await f.page.evaluate(() => {
        clearInterval(window.__focusTimer);
        return window.__focus;
      });
      let worst = 0; let run = 0; let parked = 0;
      for (const v of trace) {
        if (v === 'BODY' || v === 'NULL') { run += 1; parked += 1; worst = Math.max(worst, run); }
        else run = 0;
      }
      check('focus is never on <body> across a human move and the bot lap after it',
        parked === 0,
        `${parked}/${trace.length} samples on <body>, longest run ${worst * 20}ms, ` +
        `seen: ${[...new Set(trace)].slice(0, 6).join(', ')}`);
      check('and it lands somewhere the keyboard can use',
        trace.length > 20 && trace.every((v) => v === 'dice' || /^p\d+t\d+$/.test(v) || v === 'BUTTON'),
        [...new Set(trace)].join(', '));
      allErrors = allErrors.concat(f.errors);
      await f.context.close();
    }

    /* ------------------------------------------------------------------- 13 */
    section('A refused tap is VISIBLE on a phone, not just spoken');
    for (const deviceName of ['iPhone 12', 'iPhone SE']) {
      const r = await openPage(browser, url, {
        device: deviceName,
        storage: [[SAVE_KEY, touchSave], [SPEED_KEY, 'instant']],
      });
      await r.page.locator('#btn-resume').tap();
      await r.page.waitForFunction(() => document.querySelectorAll('.token').length === 20);
      await waitForHumanRoll(r.page);
      await r.page.locator('#dice').tap();
      await r.page.waitForFunction(() => document.querySelectorAll('.move-btn').length >= 1,
        null, { timeout: 15000 });
      await r.page.locator('.token[data-token-id="p2t1"]').tap();   // another seat's token
      await r.page.waitForTimeout(250);
      const seen = await r.page.evaluate(() => {
        const note = document.getElementById('move-picker-note');
        const box = note.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
          text: note.textContent.trim(),
          hidden: note.hidden,
          onTop: note === hit || note.contains(hit),
          inView: box.top >= 0 && box.bottom <= window.innerHeight,
          announced: document.getElementById('announcer').textContent.trim(),
        };
      });
      check(`${deviceName}: the reason for a refused tap is shown inside the picker`,
        !seen.hidden && /Priya/.test(seen.text), `note="${seen.text}" hidden=${seen.hidden}`);
      check(`${deviceName}: and it is on screen and not covered by anything`,
        seen.onTop && seen.inView, `onTop=${seen.onTop} inView=${seen.inView}`);
      check(`${deviceName}: the screen reader still gets it too`,
        seen.announced === seen.text, seen.announced);

      await r.page.locator('.move-btn').first().tap();
      await r.page.waitForTimeout(300);
      const cleared = await r.page.$eval('#move-picker-note',
        (n) => n.hidden && n.textContent === '');
      check(`${deviceName}: the reason clears once a real move is played`, cleared);
      allErrors = allErrors.concat(r.errors);
      await r.context.close();
    }

    /* ------------------------------------------------------------------- 14 */
    section('Short and small screens: the board never scrolls off to reveal the picker');
    for (const [label, viewport] of [
      ['320x480', { width: 320, height: 480 }],
      ['360x560', { width: 360, height: 560 }],
    ]) {
      const v = await openPage(browser, url, { viewport, storage: [SAVE_KEY, touchSave] });
      await v.page.click('#btn-resume');
      await v.page.waitForFunction(() => document.querySelectorAll('.token').length === 20);
      await waitForHumanRoll(v.page);
      // Roll with the keyboard: Playwright's tap()/click() scroll the target into view
      // by themselves, which would forge the very number this check is about.
      await v.page.evaluate(() => window.scrollTo(0, 0));
      await v.page.keyboard.press(' ');
      await v.page.waitForFunction(() => document.querySelectorAll('.move-btn').length >= 1,
        null, { timeout: 15000 });
      const geom = await v.page.evaluate(() => {
        const b = document.querySelector('.board-wrap').getBoundingClientRect();
        const p = document.getElementById('move-picker').getBoundingClientRect();
        const shown = (r) => Math.round(
          Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) / r.height * 100);
        return {
          boardTop: Math.round(b.top), boardShown: shown(b), pickShown: shown(p),
          pickTop: Math.round(p.top), fold: innerHeight,
        };
      });
      check(`${label}: the board's top edge stays on screen when the picker opens`,
        geom.boardTop >= 0, `board top ${geom.boardTop}, ${geom.boardShown}% of it visible`);
      check(`${label}: and the picker is essentially all there`,
        geom.pickShown >= 95, `${geom.pickShown}% visible, top ${geom.pickTop} of ${geom.fold}`);
      allErrors = allErrors.concat(v.errors);
      await v.context.close();
    }

    /* ------------------------------------------------------------------- 15 */
    section('Landscape: the board and the move choices share the screen');
    for (const deviceName of ['iPhone 12 landscape', 'Pixel 5 landscape']) {
      const l = await openPage(browser, url, {
        device: deviceName,
        storage: [[SAVE_KEY, touchSave], [SPEED_KEY, 'instant']],
      });
      const size = l.page.viewportSize();
      await l.page.locator('#btn-resume').tap();
      await l.page.waitForFunction(() => document.querySelectorAll('.token').length === 20);
      await waitForHumanRoll(l.page);
      await l.page.evaluate(() => window.scrollTo(0, 0));
      await l.page.keyboard.press(' ');
      await l.page.waitForFunction(() => document.querySelectorAll('.move-btn').length >= 1,
        null, { timeout: 15000 });
      const land = await l.page.evaluate(() => {
        const shown = (r) => Math.round(
          Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) / r.height * 100);
        const b = document.querySelector('.board-wrap');
        const p = document.getElementById('move-picker');
        return {
          columns: getComputedStyle(document.querySelector('.screen-game')).gridTemplateColumns
            .split(' ').length,
          board: shown(b.getBoundingClientRect()),
          pick: shown(p.getBoundingClientRect()),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      check(`${deviceName}: the panel moves beside the board instead of under it`,
        land.columns === 2, `${land.columns} column(s), ${size.width}x${size.height}`);
      check(`${deviceName}: board and picker are both fully visible at once`,
        land.board === 100 && land.pick === 100, `board ${land.board}%, picker ${land.pick}%`);
      check(`${deviceName}: no horizontal scroll`, land.overflow === 0, `${land.overflow}px`);
      allErrors = allErrors.concat(l.errors);
      await l.context.close();
    }

    /* ------------------------------------------------------------------- 16 */
    section('The live region stays drainable');
    {
      const q = await openPage(browser, url, { storage: [SAVE_KEY, touchSave] });
      await q.page.click('#btn-resume');
      await q.page.waitForFunction(() => document.querySelectorAll('.token').length === 20);
      const watch = () => q.page.evaluate(() => {
        window.__said = [];
        const node = document.getElementById('announcer');
        if (window.__sObs) window.__sObs.disconnect();
        window.__sObs = new MutationObserver(() => {
          const t = node.textContent.trim();
          if (t) window.__said.push([performance.now(), t]);
        });
        window.__sObs.observe(node, { childList: true, characterData: true, subtree: true });
      });

      // …re-pressing the pressed pace button changes nothing, so it must say nothing.
      await watch();
      await q.page.click('.pace-btn[data-speed="fast"]');
      await q.page.waitForTimeout(200);
      for (let i = 0; i < 4; i += 1) {
        await q.page.click('.pace-btn[data-speed="fast"]');
        await q.page.waitForTimeout(100);
      }
      const spoken = await q.page.evaluate(() =>
        window.__said.map((e) => e[1]).filter((t) => /^Speed:/.test(t)));
      check('one real speed change speaks once; four no-op presses stay silent',
        spoken.length === 1, JSON.stringify(spoken));

      // …and at Instant the bots stop narrating, because nothing is left to narrate.
      await q.page.click('.pace-btn[data-speed="instant"]');
      await waitForHumanRoll(q.page);
      await watch();
      await q.page.click('#dice');
      await q.page.waitForFunction(() => document.querySelectorAll('.move-btn').length >= 1,
        null, { timeout: 15000 });
      await q.page.locator('.move-btn').first().click();
      await waitForHumanRoll(q.page);
      await q.page.waitForTimeout(300);
      const burst = await q.page.evaluate(() => {
        const said = window.__said;
        let peak = 0;
        for (const [t0] of said) {
          peak = Math.max(peak, said.filter(([t]) => t >= t0 && t < t0 + 1000).length);
        }
        return { n: said.length, peak, texts: said.map((e) => e[1]) };
      });
      check('at Instant a whole bot lap does not flood the polite live region',
        burst.peak <= 3 && burst.texts.every((t) => !/Thinking|choosing|no legal move/.test(t)),
        `${burst.n} messages, peak ${burst.peak}/s: ${JSON.stringify(burst.texts.slice(0, 6))}`);
      allErrors = allErrors.concat(q.errors);
      await q.context.close();
    }

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
