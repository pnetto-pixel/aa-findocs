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
//   1. ONE TIME, on the laptop, log in by hand into a persistent browser profile:
//          npm run login
//      Log in (username + password + 2FA) until you can see your portfolio, then come
//      back to the terminal and press Enter. The authenticated cookies are saved in the
//      profile dir.
//
//   2. Every sync run reuses that profile and goes STRAIGHT to the activity page — no
//      login step, so there is nothing for Akamai to flag. When the saved session
//      eventually expires, a run exits with a clear "session expired" message and you
//      just run `npm run login` again to refresh it.
//
// The profile dir lives OUTSIDE the repo workspace (default: ~/.fidelity-sync-profile)
// so `actions/checkout` cleaning the workspace never wipes the saved session. The manual
// login and the runner MUST run as the SAME Windows user so they share the profile.
//
// Env:
//   sync mode (workflow):  INGEST_TOKEN, INGEST_URL   (FIDELITY_* no longer needed)
//   login mode (`npm run login` on the laptop): none — you type credentials by hand
//   optional: FIDELITY_PROFILE_DIR to override where the session is stored
//
// Deps: playwright, papaparse

import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { parseFidelityCSV } from './parse-fidelity.mjs';

const LOGIN_MODE = process.argv.includes('--login') || process.env.MANUAL_LOGIN === '1';

const INGEST_URL = process.env.INGEST_URL;
const INGEST_TOKEN = (process.env.INGEST_TOKEN || '').trim();

const PROFILE_DIR =
  process.env.FIDELITY_PROFILE_DIR || path.join(os.homedir(), '.fidelity-sync-profile');

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

// --- ONE-TIME manual login: open headed, let the human log in, persist cookies. -------
async function loginMode() {
  console.log('Profile dir:', PROFILE_DIR);
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, LAUNCH);
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    page.setDefaultTimeout(60000);
    await page.goto(LOGIN_URL, { waitUntil: 'commit', timeout: 60000 });
    console.log('\n=== MANUAL LOGIN ===');
    console.log('Log in by hand in the browser window: username, password, 2FA.');
    console.log('When you can see your portfolio/positions, return here and press Enter.');
    await waitForEnter('\nPress Enter once you are fully logged in... ');
    // Cookies are persisted to PROFILE_DIR automatically by the persistent context.
  } finally {
    await ctx.close();
  }
  console.log('Session saved to', PROFILE_DIR, '— you can now run the sync.');
}

// --- Recurring sync: reuse the saved session, no login. -------------------------------
async function syncMode() {
  need('INGEST_TOKEN', INGEST_TOKEN);
  need('INGEST_URL', INGEST_URL);

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, LAUNCH);
  try {
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

    // Discovery: dump candidate download/export controls so we can confirm the exact
    // selector (Fidelity's DOM isn't public). Logged as status only.
    const candidates = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('a, button, [role="button"]'));
      return els
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 40),
          aria: el.getAttribute('aria-label') || '',
          id: el.id || '',
        }))
        .filter((e) => /download|export|csv/i.test(`${e.text} ${e.aria} ${e.id}`));
    });
    console.log('download candidates:', JSON.stringify(candidates));

    const dlLocator = page.locator(
      'a:has-text("Download"), button:has-text("Download"), [aria-label*="download" i], [aria-label*="export" i]'
    );
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      dlLocator.first().click(),                              // TODO: confirm selector
    ]);
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
