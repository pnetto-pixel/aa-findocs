// scrape.mjs
//
// Logs into Fidelity headlessly, generates the 2FA code from a stored TOTP secret,
// downloads the Accounts History CSV, parses it, and POSTs the parsed trades to the
// app's staging endpoint (/api/ingest-fidelity). Nothing is auto-applied — the user
// approves inside the app.
//
// READ-ONLY on Fidelity: it only navigates and downloads. There is no trade/transfer
// code path here, by design.
//
// Env (from GitHub Secrets):
//   FIDELITY_USER, FIDELITY_PASS, FIDELITY_TOTP_SECRET, INGEST_TOKEN, INGEST_URL
//
// ⚠️ SELECTORS: Fidelity's DOM is not public and changes over time. The selectors
// below are best-effort and MUST be validated on the first manual run (see README).
// Prefer text/role locators; when one breaks, fix just that line.
//
// Deps: playwright, otplib, papaparse

import { chromium } from 'playwright';
import { authenticator } from 'otplib';
import { readFile } from 'node:fs/promises';
import { parseFidelityCSV } from './parse-fidelity.mjs';

const {
  FIDELITY_USER,
  FIDELITY_PASS,
  FIDELITY_TOTP_SECRET,
  INGEST_TOKEN,
  INGEST_URL, // e.g. https://aa-findocs.vercel.app/api/ingest-fidelity
} = process.env;

function need(name, v) {
  if (!v) { console.error(`Missing env ${name}`); process.exit(1); }
}
need('FIDELITY_USER', FIDELITY_USER);
need('FIDELITY_PASS', FIDELITY_PASS);
need('FIDELITY_TOTP_SECRET', FIDELITY_TOTP_SECRET);
need('INGEST_TOKEN', INGEST_TOKEN);
need('INGEST_URL', INGEST_URL);

const LOGIN_URL = 'https://digital.fidelity.com/prgw/digital/login/full-page';
// Activity/History page that exposes the CSV download. Confirm the exact path on
// first run; Fidelity routes through digital.fidelity.com/ftgw/digital/portfolio/activity.
const ACTIVITY_URL = 'https://digital.fidelity.com/ftgw/digital/portfolio/activity';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    // --- Login -------------------------------------------------------------
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await page.fill('#dom-username-input', FIDELITY_USER);   // TODO: confirm selector
    await page.fill('#dom-pswd-input', FIDELITY_PASS);       // TODO: confirm selector
    await page.click('#dom-login-button');                    // TODO: confirm selector

    // --- 2FA via TOTP ------------------------------------------------------
    // Fidelity shows the authenticator-code field after submitting credentials.
    const otpField = page.locator('input[autocomplete="one-time-code"], #dom-otp-code-input');
    if (await otpField.first().isVisible({ timeout: 15000 }).catch(() => false)) {
      const code = authenticator.generate(FIDELITY_TOTP_SECRET);
      await otpField.first().fill(code);
      // Some flows offer "remember this device" — clicking it reduces future 2FA.
      await page.click('button:has-text("Continue"), #dom-otp-submit-button').catch(() => {});
    }

    await page.waitForLoadState('networkidle', { timeout: 30000 });
    console.log('login ok');

    // --- Download the Accounts History CSV --------------------------------
    await page.goto(ACTIVITY_URL, { waitUntil: 'domcontentloaded' });
    // The download control is usually a "Download" link/button on the activity page.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('text=/download/i'),                         // TODO: confirm selector
    ]);
    const csvPath = await download.path();
    const csvText = await readFile(csvPath, 'utf8');
    console.log('CSV downloaded');

    // --- Parse + POST to staging ------------------------------------------
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
    await browser.close();
  }
}

main().catch((err) => {
  console.error('scrape error:', err.message);
  process.exit(1);
});
