// Run with: node test/bond-meta.test.mjs
// Validates lib/bond-meta.js's backfillBondMetadata (Fase 2 of the "Bond
// Matching" item, jul/2026) — filling couponRate/maturityDate/shortName/notes
// on Bank Bonds transactions from a bound SimpleFin holding's description,
// without ever overwriting a field that already has a value. Also cross-
// checks the generated `notes` format against the accrual regex
// computeBankBondsValueAt (src/lib/bankBonds.js) actually parses.

import { strict as assert } from 'node:assert';
import { backfillBondMetadata } from '../lib/bond-meta.js';
import { computeBankBondsValueAt } from '../src/lib/bankBonds.js';

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

const HOLDING_DESC = 'WELLS FARGO BANK NATL ASSN CD 4.20000% 07/08/2030';
const CUSIP = 'OLDCUSIP99';

console.log('\n— backfillBondMetadata —');

await test('(a) fills couponRate/maturityDate/shortName/notes when empty', () => {
  const blindBuy = {
    id: 'buy-1',
    date: '2019-05-01',
    side: 'buy',
    ticker: CUSIP,
    assetClass: 'Bank Bonds',
    qty: 1,
    price: 1000,
    currency: 'USD',
    fee: 0,
    notes: '',
  };
  const next = backfillBondMetadata([blindBuy], CUSIP, HOLDING_DESC);
  assert.notEqual(next, [blindBuy], 'should return a new array reference when something changed');
  const tx = next[0];
  assert.equal(tx.couponRate, 4.2);
  assert.equal(tx.maturityDate, '2030-07-08');
  assert.equal(tx.shortName, 'WELLS FARGO BANK NATL ASSN CD');
  assert.equal(tx.notes, '4.20% | 07/08/2030');
});

await test('(b) never overwrites a field that already has a value', () => {
  const partiallyFilled = {
    id: 'buy-2',
    date: '2019-05-01',
    side: 'buy',
    ticker: CUSIP,
    assetClass: 'Bank Bonds',
    qty: 1,
    price: 1000,
    currency: 'USD',
    fee: 0,
    couponRate: 1.0, // deliberately wrong/stale, but PRESENT — must survive untouched
    maturityDate: '2099-01-01',
    shortName: 'SOME OTHER NAME',
    notes: 'pre-existing note, do not touch',
  };
  const original = [partiallyFilled];
  const next = backfillBondMetadata(original, CUSIP, HOLDING_DESC);
  assert.equal(next, original, 'no field was empty, so nothing should change');
  const [tx] = next;
  assert.equal(tx.couponRate, 1.0);
  assert.equal(tx.maturityDate, '2099-01-01');
  assert.equal(tx.shortName, 'SOME OTHER NAME');
  assert.equal(tx.notes, 'pre-existing note, do not touch');
});

await test('(c) no-op (same reference) when the holding description does not parse', () => {
  const blindBuy = {
    id: 'buy-3',
    date: '2019-05-01',
    side: 'buy',
    ticker: CUSIP,
    assetClass: 'Bank Bonds',
    qty: 1,
    price: 1000,
    currency: 'USD',
    fee: 0,
  };
  const original = [blindBuy];
  const next = backfillBondMetadata(original, CUSIP, 'US TREASURY BILL 0% 12/12/2099 (no coupon% pattern)');
  assert.equal(next, original, 'unparseable description -> same array reference, no data to fill');
});

await test('(c2) no-op (same reference) when nothing in the array matches the CUSIP', () => {
  const other = {
    id: 'buy-4',
    date: '2019-05-01',
    side: 'buy',
    ticker: 'SOMEOTHERCUSIP',
    assetClass: 'Bank Bonds',
    qty: 1,
    price: 1000,
    currency: 'USD',
    fee: 0,
  };
  const original = [other];
  const next = backfillBondMetadata(original, CUSIP, HOLDING_DESC);
  assert.equal(next, original);
});

await test('(d) applies to both buy AND sell rows of the same CUSIP', () => {
  const blindBuy = {
    id: 'buy-5',
    date: '2019-05-01',
    side: 'buy',
    ticker: CUSIP,
    assetClass: 'Bank Bonds',
    qty: 1,
    price: 1000,
    currency: 'USD',
    fee: 0,
  };
  const blindSell = {
    id: 'sell-5',
    date: '2025-07-08',
    side: 'sell',
    ticker: CUSIP,
    assetClass: 'Bank Bonds',
    qty: 1,
    price: 1000,
    currency: 'USD',
    fee: 0,
    redemption: true,
  };
  const next = backfillBondMetadata([blindBuy, blindSell], CUSIP, HOLDING_DESC);
  assert.notEqual(next, [blindBuy, blindSell]);
  for (const tx of next) {
    assert.equal(tx.couponRate, 4.2);
    assert.equal(tx.maturityDate, '2030-07-08');
    assert.equal(tx.shortName, 'WELLS FARGO BANK NATL ASSN CD');
    assert.equal(tx.notes, '4.20% | 07/08/2030');
  }
});

await test('(e) generated notes format is parseable by computeBankBondsValueAt\'s accrual regex', () => {
  const blindBuy = {
    id: 'buy-6',
    date: '2024-01-10',
    side: 'buy',
    ticker: CUSIP,
    assetClass: 'Bank Bonds',
    qty: 1,
    price: 1000,
    currency: 'USD',
    fee: 0,
  };
  const filled = backfillBondMetadata([blindBuy], CUSIP, HOLDING_DESC);
  const tx = filled[0];
  // Same regexes computeBankBondsValueAt applies to tx.notes.
  assert.match(tx.notes, /(\d+\.\d+)%/, 'notes must carry a decimal coupon % the accrual regex can parse');
  assert.match(tx.notes, /\d{2}\/\d{2}\/\d{4}$/, 'notes must end with an MM/DD/YYYY maturity date');
  // End-to-end: feed it through the real accrual function and confirm the
  // bond is no longer "flat" (interest is being projected past cost basis).
  const snap = computeBankBondsValueAt(filled, '2025-01-10');
  const pos = snap.byTicker[CUSIP];
  assert.ok(pos, 'position should still be open');
  assert.ok(pos.totalValue > pos.totalCost, 'accrued interest should push value above cost once notes are parseable');
});

await test('(f) ignores non-"Bank Bonds" transactions even with a matching ticker', () => {
  const stockTx = {
    id: 'stock-1',
    date: '2024-01-01',
    side: 'buy',
    ticker: CUSIP,
    assetClass: 'Stocks',
    qty: 1,
    price: 100,
    currency: 'USD',
    fee: 0,
  };
  const original = [stockTx];
  const next = backfillBondMetadata(original, CUSIP, HOLDING_DESC);
  assert.equal(next, original);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
