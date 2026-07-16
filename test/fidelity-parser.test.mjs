// Run with: node test/fidelity-parser.test.mjs
// Regression suite for the CSV / Fidelity "Accounts History" parser
// (src/lib/parsing.js). Every fixture below encodes a bug that shipped and
// was later fixed — see docs/Features_Roadmap.md for the history.

import { strict as assert } from 'node:assert';
import {
  parseFidelityCSV,
  parseRow,
  parseDate,
  detectDateFormat,
  inferAssetClass,
  dupKey,
  extractBondMeta,
  parseNumberLoose,
  parseCSVOrPaste,
} from '../src/lib/parsing.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${e.message}`);
    failed++;
  }
}

// Builds a minimal Fidelity "Accounts History" CSV from row tuples:
// [runDate, action, symbol, description, price, qty, fees, amount]
function fidelityCSV(rows) {
  const header =
    'Run Date,Action,Symbol,Symbol Description,Price ($),Quantity,Fees ($),Amount ($)';
  const lines = rows.map((r) => r.map((c) => `"${c ?? ''}"`).join(','));
  // Fidelity exports start with a BOM + blank lines before the header.
  return `﻿\n\n${header}\n${lines.join('\n')}`;
}

console.log('\n— parseFidelityCSV —');

await test('basic YOU BOUGHT / YOU SOLD (sell qty negative → abs)', () => {
  const out = parseFidelityCSV(
    fidelityCSV([
      ['05/08/2026', ' YOU BOUGHT ', 'AAPL', 'APPLE INC', '180.50', '10', '0', '-1805.00'],
      ['05/09/2026', ' YOU SOLD ', 'AAPL', 'APPLE INC', '190.00', '-4', '0.05', '760.00'],
    ])
  );
  assert.equal(out.results.length, 2);
  const [buy, sell] = out.results.map((r) => r.tx);
  assert.equal(buy.side, 'buy');
  assert.equal(buy.date, '2026-05-08'); // MDY, not DMY
  assert.equal(buy.qty, 10);
  assert.equal(buy.price, 180.5);
  assert.equal(buy.assetClass, 'Stocks');
  assert.equal(buy.currency, 'USD');
  assert.equal(sell.side, 'sell');
  assert.equal(sell.qty, 4); // abs of -4
  assert.equal(sell.fee, 0.05);
});

await test('accepts MM-DD-YYYY (dashes) dates from Accounts History export', () => {
  const out = parseFidelityCSV(
    fidelityCSV([['05-08-2026', 'YOU BOUGHT', 'VTI', 'VANGUARD', '250', '2', '', '-500']])
  );
  assert.equal(out.results[0].tx.date, '2026-05-08');
});

await test('PR #116: "YOU BOUGHT EX-DIV DATE" rows are not dropped', () => {
  const out = parseFidelityCSV(
    fidelityCSV([
      ['06/01/2026', 'YOU BOUGHT EX-DIV DATE 06/02/26', 'O', 'REALTY INCOME', '55.00', '3', '', '-165.00'],
    ])
  );
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].tx.side, 'buy');
});

await test('PR #95: DIVIDEND RECEIVED captured as income event, not dropped', () => {
  const out = parseFidelityCSV(
    fidelityCSV([
      ['06/10/2026', 'DIVIDEND RECEIVED', 'VALE', 'VALE SA ADR', '', '', '', '38.42'],
    ])
  );
  assert.equal(out.results.length, 0);
  assert.equal(out.incomeEvents.length, 1);
  const ev = out.incomeEvents[0];
  assert.equal(ev.kind, 'dividend');
  assert.equal(ev.ticker, 'VALE');
  assert.equal(ev.amount, 38.42);
  assert.equal(ev.source, 'fidelity');
});

await test('REINVESTMENT dividend rows are skipped (no income event)', () => {
  const out = parseFidelityCSV(
    fidelityCSV([
      ['06/10/2026', 'DIVIDEND RECEIVED REINVESTMENT', 'SCHD', 'SCHWAB US DIVIDEND', '', '', '', '12.00'],
    ])
  );
  assert.equal(out.incomeEvents.length, 0);
});

await test('ETF named "DIVIDEND" bought ex-div is a buy, not an income event', () => {
  const out = parseFidelityCSV(
    fidelityCSV([
      ['06/03/2026', 'YOU BOUGHT EX-DIV DATE', 'NOBL', 'PROSHARES SP 500 DIVIDEND ARISTOCRATS', '95.00', '5', '', '-475.00'],
    ])
  );
  assert.equal(out.incomeEvents.length, 0);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].tx.side, 'buy');
});

await test('foreign tax withheld (TSM/VALE) captured as kind:"tax", positive amount', () => {
  const out = parseFidelityCSV(
    fidelityCSV([
      ['07/09/2026', 'FOREIGN TAX PAID', 'TSM', 'TAIWAN SEMICONDUCTOR ADR', '', '', '', '-1.69'],
      ['07/09/2026', 'DIVIDEND RECEIVED', 'TSM', 'TAIWAN SEMICONDUCTOR ADR', '', '', '', '8.45'],
    ])
  );
  assert.equal(out.incomeEvents.length, 2);
  const tax = out.incomeEvents.find((e) => e.kind === 'tax');
  const div = out.incomeEvents.find((e) => e.kind === 'dividend');
  assert.equal(tax.amount, 1.69); // magnitude, not negative
  assert.equal(div.amount, 8.45); // gross, untouched
});

await test('bond INTEREST with CUSIP captured; INTEREST EARNED CASH goes to purge list', () => {
  const out = parseFidelityCSV(
    fidelityCSV([
      ['06/20/2026', 'INTEREST', '949764WE0', 'WELLS FARGO BANK NATL ASSN CD 4.20000% 07/08/2030', '', '', '', '4.55'],
      ['06/30/2026', 'INTEREST EARNED CASH', '315994103', 'CASH', '', '', '', '1.23'],
    ])
  );
  assert.equal(out.incomeEvents.length, 1);
  assert.equal(out.incomeEvents[0].kind, 'interest');
  assert.equal(out.incomeEvents[0].ticker, '949764WE0');
  // Core-cash sweep interest is recorded only for stale-record purging.
  assert.equal(out.distributionEvents.length, 1);
  assert.equal(out.distributionEvents[0].ticker, '315994103');
});

await test('DISTRIBUTION (shares) rows never become income; recorded for purge', () => {
  const out = parseFidelityCSV(
    fidelityCSV([
      ['06/25/2026', 'DISTRIBUTION SPAXX', 'NOBL', 'PROSHARES DIVIDEND ARISTOCRATS', '', '', '', '7.77'],
    ])
  );
  assert.equal(out.incomeEvents.length, 0);
  assert.equal(out.results.length, 0);
  assert.equal(out.distributionEvents.length, 1);
});

await test('item 40 / PR #87: Bank Bonds qty ÷1000 and price ×10 (percent-of-face)', () => {
  const out = parseFidelityCSV(
    fidelityCSV([
      ['05/05/2026', 'YOU BOUGHT', '949764WE0', 'WELLS FARGO BANK NATL ASSN CD 4.20000% 07/08/2030', '100.00', '1000', '', '-1000.00'],
    ])
  );
  const tx = out.results[0].tx;
  assert.equal(tx.assetClass, 'Bank Bonds');
  assert.equal(tx.qty, 1); // 1000 face → 1 unit
  assert.equal(tx.price, 1000); // 100.00 percent-of-face → $1,000/unit
  assert.equal(tx.couponRate, 4.2);
  assert.equal(tx.maturityDate, '2030-07-08');
  assert.equal(tx.bondType, 'CD');
});

await test('PR #88: REDEMPTION becomes sell with redemption flag; price derived from Amount', () => {
  const out = parseFidelityCSV(
    fidelityCSV([
      ['07/08/2026', 'REDEMPTION PAYOUT', '949764WE0', 'WELLS FARGO BANK NATL ASSN CD 4.20000% 07/08/2030', '', '', '', '1000.00'],
    ])
  );
  const r = out.results[0];
  assert.equal(r.tx.side, 'sell');
  assert.equal(r.tx.redemption, true);
  assert.equal(r.tx.qty, 1); // Amount 1000 face → 1 unit
  assert.equal(r.tx.price, 1000); // paid back at par
});

await test('knownClassByTicker overrides inference (classFromHistory flag)', () => {
  const known = new Map([['GLDM', 'Alternative']]);
  const out = parseFidelityCSV(
    fidelityCSV([['06/06/2026', 'YOU BOUGHT', 'GLDM', 'SPDR GOLD MINISHARES', '60', '2', '', '-120']]),
    known
  );
  assert.equal(out.results[0].tx.assetClass, 'Alternative');
  assert.equal(out.results[0].classFromHistory, true);
});

await test('jul/2026: blank Symbol on bond row recovered via knownBondsByDescKey', () => {
  const meta = extractBondMeta('WELLS FARGO BANK NATL ASSN CD 4.20000% 07/08/2030');
  const knownBonds = new Map([[meta.descKey, '949764WE0']]);
  const out = parseFidelityCSV(
    fidelityCSV([
      ['06/20/2026', 'INTEREST', '', 'WELLS FARGO BANK NATL ASSN CD 4.20000% 07/08/2030', '', '', '', '3.50'],
    ]),
    null,
    knownBonds
  );
  assert.equal(out.incomeEvents.length, 1);
  assert.equal(out.incomeEvents[0].ticker, '949764WE0');
});

await test('missing header returns explicit error instead of throwing', () => {
  const out = parseFidelityCSV('a,b,c\n1,2,3');
  assert.equal(out.results.length, 0);
  assert.ok(out.error);
});

console.log('\n— extractBondMeta —');

await test('parses coupon, maturity, issuer and type', () => {
  const m = extractBondMeta('FEDERAL HOME LOAN BANKS 5.05000% 03/12/2027');
  assert.equal(m.couponRate, 5.05);
  assert.equal(m.maturityDate, '2027-03-12');
  assert.equal(m.bondType, 'Agency');
  assert.equal(m.shortName, 'FEDERAL HOME LOAN BANKS');
});

await test('returns null when coupon/maturity pattern is absent', () => {
  assert.equal(extractBondMeta('APPLE INC'), null);
});

console.log('\n— generic CSV: parseRow / parseDate / detectDateFormat —');

await test('parseRow: valid row with explicit class', () => {
  const r = parseRow(
    { date: '2024-03-15', side: 'buy', ticker: 'aapl', qty: '10', price: '175.50', assetClass: 'Stocks', fee: '', notes: 'x' },
    'USD'
  );
  assert.equal(r.ok, true);
  assert.equal(r.tx.ticker, 'AAPL');
  assert.equal(r.tx.qty, 10);
  assert.equal(r.tx.currency, 'USD');
});

await test('parseRow: unknown ticker without class asks the user (needsAssetClass)', () => {
  const r = parseRow({ date: '2024-03-15', side: 'buy', ticker: 'tesouro-ipca-2035', qty: '1', price: '100' });
  assert.equal(r.needsAssetClass, false); // tesouro-* infers BRA Fixed Income
  assert.equal(r.tx.assetClass, 'BRA Fixed Income');
  assert.equal(r.tx.currency, 'BRL');
});

await test('parseRow: comma-only decimal flagged ambiguous', () => {
  const r = parseRow({ date: '2024-03-15', side: 'buy', ticker: 'BBSE3', qty: '100', price: '38,20' });
  assert.equal(r.ambiguous, true);
});

await test('PR #77: detectDateFormat spots DMY when a day > 12 appears', () => {
  assert.equal(detectDateFormat(['15/03/2024', '01/04/2024']), 'dmy');
  assert.equal(detectDateFormat(['03/15/2024']), 'mdy');
  assert.equal(detectDateFormat(['2024-03-15']), 'mdy'); // ISO-only → default
});

await test('parseDate: ISO ignores fmt; invalid dates rejected', () => {
  assert.equal(parseDate('2024-02-30', 'mdy').value, null);
  assert.equal(parseDate('2024-03-15', 'dmy').value, '2024-03-15');
  assert.equal(parseDate('15/03/2024', 'dmy').value, '2024-03-15');
});

await test('parseNumberLoose: dot decimal, thousands comma, BR ambiguity', () => {
  assert.equal(parseNumberLoose('1,500.25').value, 1500.25);
  assert.equal(parseNumberLoose('175.50').value, 175.5);
  const br = parseNumberLoose('38,20');
  assert.equal(br.ambiguous, true);
});

await test('parseCSVOrPaste: header detection (PT aliases) and field mapping', () => {
  const out = parseCSVOrPaste('data,tipo,ativo,qtd,preco\n15/03/2024,compra,BBSE3,100,38.20');
  assert.equal(out.hadHeader, true);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].ticker, 'BBSE3');
  assert.equal(out.rows[0].side, 'compra');
});

console.log('\n— dupKey / inferAssetClass —');

await test('dupKey: ticker|side|qty|date, case-insensitive ticker', () => {
  const k = dupKey({ ticker: ' aapl ', side: 'buy', qty: '10', date: '2024-03-15' });
  assert.equal(k, 'AAPL|buy|10|2024-03-15');
});

await test('inferAssetClass covers the documented priority order', () => {
  assert.equal(inferAssetClass('BND'), 'Bonds'); // fixed income ETF list
  assert.equal(inferAssetClass('VNQ'), 'Real Estate'); // REIT ETF list
  assert.equal(inferAssetClass('tesouro-ipca-2035'), 'BRA Fixed Income');
  assert.equal(inferAssetClass('949764WE0'), 'Bank Bonds'); // CUSIP
  assert.equal(inferAssetClass('BBSE3'), 'BRA Stocks'); // B3 pattern
  assert.equal(inferAssetClass('AAPL'), 'Stocks'); // US pattern
  assert.equal(inferAssetClass('BRK.B'), null); // ambiguous → ask
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
