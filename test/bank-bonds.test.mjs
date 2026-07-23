// Run with: node test/bank-bonds.test.mjs
// Validates the Bank Bonds replay helpers (src/lib/bankBonds.js), in
// particular the redemption-ticker resolution fix that consolidates the
// Holdings tab's aggregated total and Performance's Position Performance
// table (previously two divergent implementations of the same math).

import { strict as assert } from 'node:assert';
import { computeBankBondsPrincipal, computeBankBondsValueAt } from '../src/lib/bankBonds.js';

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

// Realistic Fidelity-CSV-imported buy: carries couponRate/maturityDate/
// shortName, populated by src/lib/parsing.js's extractBondMeta at import
// time. Real CUSIP as ticker.
const knownBuy = {
  id: 'buy-1',
  date: '2024-01-10',
  side: 'buy',
  ticker: '949764WE0',
  assetClass: 'Bank Bonds',
  qty: 1,
  price: 1000,
  currency: 'USD',
  fee: 0,
  notes: '4.20% | 07/08/2030',
  couponRate: 4.2,
  maturityDate: '2030-07-08',
  bondType: 'CD',
  shortName: 'WELLS FARGO BANK NATL ASSN CD',
  couponFreq: 'monthly',
};

console.log('\n— computeBankBondsValueAt: redemption ticker resolution —');

await test('(a) redemption ticker matches the original CUSIP — unchanged behavior', () => {
  const redemption = {
    id: 'sell-1',
    date: '2025-07-08',
    side: 'sell',
    ticker: '949764WE0',
    assetClass: 'Bank Bonds',
    qty: 1,
    price: 1000,
    currency: 'USD',
    fee: 0,
    notes: 'REDEMPTION PAYOUT',
    redemption: true,
  };
  const txs = [knownBuy, redemption];
  const snap = computeBankBondsValueAt(txs, '2025-12-31');
  assert.equal(Object.keys(snap.byTicker).length, 0, 'position should be fully closed, no ticker left open');
  assert.equal(snap.total, 0);
});

await test('(b) redemption ticker is the SimpleFin description text, resolvable via known buy metadata', () => {
  const redemption = {
    id: 'sell-2',
    date: '2025-07-08',
    side: 'sell',
    ticker: 'WELLS FARGO BANK NATL ASSN CD 4.20000% 07/08/2030',
    assetClass: 'Bank Bonds',
    qty: 1,
    price: 1000,
    currency: 'USD',
    fee: 0,
    notes: 'REDEMPTION PAYOUT WELLS FARGO BANK NATL ASSN CD 4.20000% 07/08/2030 (Cash)',
    redemption: true,
  };
  const txs = [knownBuy, redemption];
  const snap = computeBankBondsValueAt(txs, '2025-12-31');
  // The resolved position (real CUSIP) must be closed out — qty/cost zeroed —
  // not left as an inflated open position plus an orphan phantom sell.
  assert.equal(Object.keys(snap.byTicker).length, 0, 'resolved position should be fully closed');
  assert.equal(snap.total, 0);
});

await test('(c) redemption with no matching known buy (orphan, no metadata) stays excluded — no regression, no crash', () => {
  const manualBuy = {
    id: 'buy-2',
    date: '2024-02-01',
    side: 'buy',
    ticker: 'MANUALCUSIP1',
    assetClass: 'Bank Bonds',
    qty: 1,
    price: 500,
    currency: 'USD',
    fee: 0,
    notes: 'manual entry, no CSV metadata',
    // No couponRate/maturityDate/shortName — manually entered.
  };
  const orphanRedemption = {
    id: 'sell-3',
    date: '2025-02-01',
    side: 'sell',
    ticker: 'SOME OTHER BOND CO 3.50000% 02/01/2025',
    assetClass: 'Bank Bonds',
    qty: 1,
    price: 500,
    currency: 'USD',
    fee: 0,
    notes: 'REDEMPTION PAYOUT SOME OTHER BOND CO 3.50000% 02/01/2025 (Cash)',
    redemption: true,
  };
  const txs = [manualBuy, orphanRedemption];
  const snap = computeBankBondsValueAt(txs, '2025-12-31');
  // The manual buy stays open (its real position is untouched by the orphan
  // sell); the orphan sell's own pseudo-ticker position nets to zero and is
  // excluded from byTicker.
  assert.equal(Object.keys(snap.byTicker).length, 1);
  assert.ok(snap.byTicker['MANUALCUSIP1']);
  assert.equal(snap.byTicker['MANUALCUSIP1'].totalCost, 500);
  assert.ok(!snap.byTicker['SOME OTHER BOND CO 3.50000% 02/01/2025']);
});

console.log('\n— computeBankBondsValueAt: bondBindings fallback resolution (item 41 Bond Matching) —');

await test('(e) redemption resolves via bondBindings when knownBondsByDescKey has no match (manually/auto-bound in Bond Matching UI)', () => {
  // A bond bought before Fidelity's CSV carried a CUSIP: no couponRate/
  // maturityDate/shortName on the buy, so knownBondsByDescKey can't resolve
  // it — but the user has confirmed a bind for it in the Bond Matching UI.
  const oldBuy = {
    id: 'buy-3',
    date: '2019-05-01',
    side: 'buy',
    ticker: 'OLDCUSIP99',
    assetClass: 'Bank Bonds',
    qty: 1,
    price: 1000,
    currency: 'USD',
    fee: 0,
    notes: 'imported before CUSIP-in-CSV era, no metadata',
    // No couponRate/maturityDate/shortName.
  };
  const redemption = {
    id: 'sell-4',
    date: '2025-07-08',
    side: 'sell',
    ticker: 'CHASE BANK USA NA CD 3.75000% 07/08/2025',
    assetClass: 'Bank Bonds',
    qty: 1,
    price: 1000,
    currency: 'USD',
    fee: 0,
    notes: 'REDEMPTION PAYOUT CHASE BANK USA NA CD 3.75000% 07/08/2025 (Cash)',
    redemption: true,
  };
  const bondBindings = { 'CHASE BANK USA NA CD|3.75|2025-07-08': 'OLDCUSIP99' };
  const txs = [oldBuy, redemption];
  // Without bondBindings: the redemption is an orphan (no knownBondsByDescKey
  // match), so the real position stays open and an orphan pseudo-ticker shows up.
  const withoutBindings = computeBankBondsValueAt(txs, '2025-12-31');
  assert.ok(withoutBindings.byTicker['OLDCUSIP99'], 'without bondBindings, the real position stays open (orphan redemption)');
  // With bondBindings: the redemption resolves to the real CUSIP and closes it out.
  const withBindings = computeBankBondsValueAt(txs, '2025-12-31', bondBindings);
  assert.equal(Object.keys(withBindings.byTicker).length, 0, 'resolved via bondBindings, position should be fully closed');
  assert.equal(withBindings.total, 0);
});

await test('(f) omitting bondBindings entirely (default {}) keeps existing behavior unchanged', () => {
  const redemption = {
    id: 'sell-1',
    date: '2025-07-08',
    side: 'sell',
    ticker: '949764WE0',
    assetClass: 'Bank Bonds',
    qty: 1,
    price: 1000,
    currency: 'USD',
    fee: 0,
    redemption: true,
  };
  const txs = [knownBuy, redemption];
  const snap = computeBankBondsValueAt(txs, '2025-12-31');
  assert.equal(snap.total, 0);
});

console.log('\n— computeBankBondsPrincipal: ticker-agnostic reference total —');

await test('(d) buy sums, sell subtracts, regardless of ticker mismatch — canonical reference', () => {
  const redemptionMatching = {
    id: 'sell-1',
    date: '2025-07-08',
    side: 'sell',
    ticker: '949764WE0',
    assetClass: 'Bank Bonds',
    qty: 1,
    price: 1000,
    currency: 'USD',
    fee: 0,
    redemption: true,
  };
  const redemptionMismatched = {
    id: 'sell-2',
    date: '2025-07-08',
    side: 'sell',
    ticker: 'WELLS FARGO BANK NATL ASSN CD 4.20000% 07/08/2030',
    assetClass: 'Bank Bonds',
    qty: 1,
    price: 1000,
    currency: 'USD',
    fee: 0,
    redemption: true,
  };
  // Scenario (a): matching ticker.
  assert.equal(computeBankBondsPrincipal([knownBuy, redemptionMatching]), 0);
  // Scenario (b): mismatched/description ticker — computeBankBondsPrincipal
  // is ticker-agnostic, so it still nets correctly to 0 even though
  // computeBankBondsValueAt needs the resolution pre-pass to get there too.
  assert.equal(computeBankBondsPrincipal([knownBuy, redemptionMismatched]), 0);
  // A lone buy with no sell: full principal outstanding.
  assert.equal(computeBankBondsPrincipal([knownBuy]), 1000);
});

await test('(d) matches computeBankBondsValueAt total after the resolution fix (scenario b)', () => {
  const redemption = {
    id: 'sell-2',
    date: '2025-07-08',
    side: 'sell',
    ticker: 'WELLS FARGO BANK NATL ASSN CD 4.20000% 07/08/2030',
    assetClass: 'Bank Bonds',
    qty: 1,
    price: 1000,
    currency: 'USD',
    fee: 0,
    redemption: true,
  };
  const txs = [knownBuy, redemption];
  const canonical = computeBankBondsPrincipal(txs);
  const perTicker = Object.values(computeBankBondsValueAt(txs, '2025-12-31').byTicker).reduce(
    (s, bb) => s + bb.totalCost,
    0
  );
  assert.equal(canonical, 0);
  assert.equal(perTicker, 0);
  assert.equal(canonical, perTicker, 'the two totals must agree post-fix');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
