// scrape.mjs
//
// Downloads the Fidelity "Accounts History" CSV and POSTs the parsed trades to the
// app's staging endpoint (/api/ingest-fidelity). Nothing is auto-applied — the user
// approves inside the app. READ-ONLY on Fidelity: it only navigates and downloads.
//
// === Why session reuse (important) ===
// Fidelity sits behind Akamai Bot Manager, which blocks AUTOMATED LOGIN even from a
// residential IP on a self-hosted runner ("Sorry, we can't complete this action right
// now"). So we DON'T automate the login. Instead:
//
//   1. ONE TIME, on the laptop, log in by hand:
//          npm run login
//      Log in (username + password + 2FA) until you can see your portfolio, then come
//      back to the terminal and press Enter.
//
//   2. Every sync run reuses that session and goes STRAIGHT to the activity page — no
//      login step, so there is nothing for Akamai to flag. When the session eventually
//      expires, a run exits with a clear "session expired" message and you just run
//      `npm run login` again.
//
// === How the session is persisted (belt + suspenders) ===
// Fidelity's auth cookie is a SESSION cookie (lives only in browser memory). A plain
// persistent profile does NOT write session cookies to disk on close, so reusing the
// profile alone logs back out. Fix: also save Playwright `storageState` (which captures
// ALL cookies incl. session ones, plus localStorage) to a JSON file, and on sync we both
// reuse the persistent profile (fingerprint/localStorage) AND re-inject the saved cookies.
//
// Both files live OUTSIDE the repo workspace so `actions/checkout` cleaning never wipes
// them. The manual login and the runner MUST run as the SAME OS user so the paths match.
//
// Env:
//   sync mode (workflow):  INGEST_TOKEN, INGEST_URL   (FIDELITY_* no longer needed)
//   login mode (`npm run login` on the laptop): none — you type credentials by hand
//   optional: FIDELITY_PROFILE_DIR, FIDELITY_STATE_FILE to override storage locations
//
// Deps: playwright, papaparse

import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { parseFidelityCSV } from './parse-fidelity.mjs';

const LOGIN_MODE = process.argv.includes('--login') || process.env.MANUAL_LOGIN === '1';

const INGEST_URL = process.env.INGEST_URL;
const INGEST_TOKEN = (process.env.INGEST_TOKEN || '').trim();

const PROFILE_DIR =
  process.env.FIDELITY_PROFILE_DIR || path.join(os.homedir(), '.fidelity-sync-profile');
const STATE_FILE =
  process.env.FIDELITY_STATE_FILE || path.join(os.homedir(), '.fidelity-sync-state.json');

const LOGIN_URL = 'https://digital.fidelity.com/prgw/digital/login/full-page';
const ACTIVITY_URL = 'https://digital.fidelity.com/ftgw/digital/portfolio/activity';

// Headed + anti-automation flags + a real UA. launchPersistentContext takes both the
// browser-launch options (headless/args) and the context options (acceptDownloads/userAgent).
const LAUNCH = {
  headless: false,
  acceptDownloads: true,
  args: ['--disable-http2', '--disable-blink-features=AutomationControlled'],
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
};

function need(name, v) {
  if (!v) { console.error(`Missing env ${name}`); process.exit(1); }
}

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

// --- ONE-TIME manual login: open headed, let the human log in, save the session. ------
async function loginMode() {
  console.log('Profile dir:', PROFILE_DIR);
  console.log('State file :', STATE_FILE);
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, LAUNCH);
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    page.setDefaultTimeout(60000);
    await page.goto(LOGIN_URL, { waitUntil: 'commit', timeout: 60000 });
    console.log('\n=== MANUAL LOGIN ===');
    console.log('Log in by hand in the browser window: username, password, 2FA.');
    console.log('When you can see your portfolio/positions, return here and press Enter.');
    await waitForEnter('\nPress Enter once you are fully logged in... ');
    // storageState captures ALL cookies (incl. session cookies) + localStorage — the bit
    // a persistent profile alone would drop on close.
    const state = await ctx.storageState();
    await writeFile(STATE_FILE, JSON.stringify(state));
    console.log(`Saved ${state.cookies.length} cookies to`, STATE_FILE);
  } finally {
    await ctx.close();
  }
  console.log('Session saved — you can now run the sync.');
}

// --- Recurring sync: reuse the saved session, no login. -------------------------------
async function syncMode() {
  need('INGEST_TOKEN', INGEST_TOKEN);
  need('INGEST_URL', INGEST_URL);
  console.log('Profile dir:', PROFILE_DIR);
  console.log('State file :', STATE_FILE);

  if (!existsSync(STATE_FILE)) {
    console.error(`No saved session at ${STATE_FILE}. On the laptop run \`npm run login\` first.`);
    process.exit(2);
  }

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, LAUNCH);
  try {
    // Re-inject the saved cookies (incl. the session cookie the profile didn't keep).
    const state = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    if (Array.isArray(state.cookies) && state.cookies.length) {
      await ctx.addCookies(state.cookies);
      console.log(`re-injected ${state.cookies.length} cookies`);
    }

    const page = ctx.pages()[0] || (await ctx.newPage());
    page.setDefaultTimeout(60000);

    // Straight to the activity page using the saved session — no login attempt.
    await page.goto(ACTIVITY_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000); // let the SPA render the table + controls
    console.log('activity url:', page.url());
    await page.screenshot({ path: 'fidelity-activity.png', fullPage: true }).catch(() => {});

    // If the saved session expired, Fidelity bounces us back to a signin page.
    if (/\/login\/|\/signin\//i.test(page.url())) {
      await page.screenshot({ path: 'fidelity-session-expired.png' }).catch(() => {});
      console.error('Session expired (redirected to login). On the laptop run `npm run login` to refresh it.');
      process.exit(2);
    }

    // --- Download the CSV --------------------------------------------------
    // The "Download" control on the activity page opens an EXPORT DIALOG (format/date
    // range) instead of downloading immediately — the first click only opens it. Then a
    // "Download as CSV" button inside the dialog produces the file.
    const openBtn = page.locator(
      'button[aria-label="Download" i], [aria-label="Download" i], button:has-text("Download"), a:has-text("Download")'
    );
    await openBtn.first().click().catch((e) => console.log('open-download click note:', e.message));
    await page.waitForTimeout(3000); // let the dialog/menu render
    await page.screenshot({ path: 'fidelity-download-dialog.png', fullPage: true }).catch(() => {});

    // Dump interactive controls now visible (the dialog's options) so the log tells us
    // exactly what to click if the selector below ever drifts.
    const dialogControls = await page.evaluate(() => {
      const sel = 'button, a, [role="button"], [role="menuitem"], input, label, select, option';
      return Array.from(document.querySelectorAll(sel))
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || '',
          text: (el.textContent || '').trim().slice(0, 50),
          aria: el.getAttribute('aria-label') || '',
          id: el.id || '',
          name: el.getAttribute('name') || '',
        }))
        .filter(
          (e) =>
            (e.text || e.aria || e.id || e.name) &&
            /download|export|csv|spreadsheet|excel|comma|file|format|date|range|apply|confirm|\bok\b|\bgo\b/i.test(
              `${e.text} ${e.aria} ${e.id} ${e.name}`
            )
        );
    });
    console.log('dialog controls:', JSON.stringify(dialogControls));

    // Confirm: "Download as CSV" inside the dialog produces the file. Fall back to any
    // CSV/Download/Export control in a dialog/menu, then to the last Download-ish control.
    const csvBtn = page.getByRole('button', { name: /download as csv/i });
    const inDialog = page
      .locator('[role="dialog"] :is(button,a,[role="menuitem"]), [role="menu"] :is(button,a,[role="menuitem"])')
      .filter({ hasText: /download|csv|export/i });
    const clicker = (await csvBtn.count())
      ? csvBtn.first()
      : (await inDialog.count())
        ? inDialog.last()
        : page.locator('button:has-text("Download"), a:has-text("Download"), [aria-label="Download" i]').last();

    let download;
    try {
      [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 20000 }),
        clicker.click(),
      ]);
    } catch (e) {
      console.error('No download fired. See `dialog controls` above + the fidelity-download-dialog.png artifact to pick the exact confirm/CSV control.');
      process.exit(3);
    }
    const csvPath = await download.path();
    const csvText = await readFile(csvPath, 'utf8');
    console.log('CSV downloaded');

    const { transactions, bondIncome } = parseFidelityCSV(csvText);
    console.log(`parsed ${transactions.length} trades, ${bondIncome.length} income rows`);

    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-token': INGEST_TOKEN },
      body: JSON.stringify({ transactions, bondIncome }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`ingest failed ${res.status}: ${out.error || ''}`);
      process.exit(1);
    }
    // Status only — never log trade contents.
    console.log(`ingest ok: added=${out.added} alreadyLive=${out.alreadyLive} totalPending=${out.totalPending}`);
  } finally {
    await ctx.close();
  }
}

(LOGIN_MODE ? loginMode() : syncMode()).catch((err) => {
  console.error('scrape error:', err.message);
  process.exit(1);
});
