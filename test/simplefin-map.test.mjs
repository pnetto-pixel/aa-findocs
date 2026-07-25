// Run with: node test/simplefin-map.test.mjs
// Fixtures are synthetic — no real account data. Shapes mirror the real
// SimpleFin payload confirmed by the Fase 0 probe (see
// docs/plans/simplefin-fidelity-feed.md, "Incerteza nº 1").

import { strict as assert } from 'node:assert';
import { mapSimplefinPayload, isFidelityOrg, computeNetQty } from '../lib/simplefin-map.js';

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

const FIDELITY_ORG = { name: 'Fidelity Investments', domain: 'fidelity.com' };
const CHASE_ORG = { name: 'Chase', domain: 'chase.com' };

function fidelityAccount(overrides = {}) {
  return {
    id: 'ACT-fidelity-1',
    name: 'Fidelity Brokerage',
    currency: 'USD',
    org: FIDELITY_ORG,
    balance: '125000.00',
    'available-balance': '4321.55',
    'balance-date': 1753000000,
    holdings: [],
    transactions: [],
    ...overrides,
  };
}

console.log('\n— isFidelityOrg —');

await test('matches on org.name containing "fidelity"', () => {
  assert.equal(isFidelityOrg({ name: 'Fidelity Investments', domain: 'example.com' }), true);
});

await test('matches on org.domain containing "fidelity"', () => {
  assert.equal(isFidelityOrg({ name: 'Brokerage Co', domain: 'fidelity.com' }), true);
});

await test('does not match unrelated orgs', () => {
  assert.equal(isFidelityOrg(CHASE_ORG), false);
});

console.log('\n— mapSimplefinPayload: org filter —');

await test('non-Fidelity accounts are fully excluded (no holdings/tx leak)', () => {
  const payload = {
    accounts: [
      fidelityAccount(),
      {
        id: 'ACT-chase-1',
        name: 'Chase Checking',
        org: CHASE_ORG,
        'available-balance': '2000.00',
        holdings: [],
        transactions: [
          { id: 'TX-personal-1', posted: 1752900000, amount: '-45.00', description: 'STARBUCKS PURCHASE' },
        ],
      },
    ],
  };
  const out = mapSimplefinPayload(payload);
  assert.equal(out.unmapped.length, 0);
  assert.equal(out.transactions.length, 0);
  assert.equal(out.bondIncome.length, 0);
  // Only the Fidelity account's cash balance should surface.
  assert.equal(out.balanceCandidates.length, 1);
  assert.equal(out.balanceCandidates[0].accountId, 'ACT-fidelity-1');
});

console.log('\n— mapSimplefinPayload: dividend —');

await test('DIVIDEND RECEIVED maps to a dividend bondIncome entry', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        transactions: [
          {
            id: 'TX-div-1',
            posted: 1752900000,
            amount: '12.34',
            description: 'DIVIDEND RECEIVED APPLE INC (AAPL) (Cash)',
          },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  assert.equal(out.bondIncome.length, 1);
  const ev = out.bondIncome[0];
  assert.equal(ev.kind, 'dividend');
  assert.equal(ev.ticker, 'AAPL');
  assert.equal(ev.amount, 12.34);
  assert.equal(ev.source, 'simplefin');
  assert.equal(ev.simplefinId, 'TX-div-1');
  assert.equal(out.unmapped.length, 0);
});

await test('DIVIDEND ... REINVEST is not captured as a dividend', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        transactions: [
          {
            id: 'TX-reinvest-1',
            posted: 1752900000,
            amount: '-12.34',
            description: 'REINVESTMENT DIVIDEND APPLE INC (AAPL) (Cash)',
          },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  assert.equal(out.bondIncome.length, 0);
  // Not silently dropped — falls to unmapped since it doesn't match any
  // known exclude category (only EARNED CASH / REINVESTMENT CASH / DISTRIBUTION are purged).
  assert.equal(out.unmapped.length, 1);
});

console.log('\n— mapSimplefinPayload: bond interest —');

await test('INTEREST <issuer> (Cash) maps to an interest bondIncome entry', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        transactions: [
          {
            id: 'TX-int-1',
            posted: 1752900100,
            amount: '5.10',
            description: 'INTEREST WELLS FARGO BANK NATL ASSN (Cash)',
          },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  assert.equal(out.bondIncome.length, 1);
  const ev = out.bondIncome[0];
  assert.equal(ev.kind, 'interest');
  assert.equal(ev.ticker, 'WELLS FARGO BANK NATL ASSN');
  assert.equal(ev.amount, 5.1);
});

await test('"INTEREST as of YYYY-MM-DD ..." prefix is stripped', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        transactions: [
          {
            id: 'TX-int-2',
            posted: 1752900200,
            amount: '3.00',
            description: 'INTEREST as of 2026-01-15 US TREASURY NOTE (Cash)',
          },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  assert.equal(out.bondIncome.length, 1);
  assert.equal(out.bondIncome[0].ticker, 'US TREASURY NOTE');
});

console.log('\n— mapSimplefinPayload: bond interest auto-resolution —');

// NOTE: unlike the REDEMPTION_PAYOUT fixture (which carries the bond's full
// "Symbol Description" text, including a type suffix like "CD"), the real
// INTEREST description only ever contains the bare issuer name (see the
// 'INTEREST <issuer> (Cash)' fixture above: ticker === 'WELLS FARGO BANK
// NATL ASSN', no "CD"). So holdings fixtures here intentionally omit any
// type-suffix words in the text before the coupon% too, so shortName lines
// up exactly with the issuer text extracted from the interest description
// (the whole point of the exact-match-after-normalization rule).
const wellsFargoHolding = {
  id: 'HOLD-cd1',
  symbol: '',
  description: 'WELLS FARGO BANK NATL ASSN 4.20000% 07/08/2030',
  market_value: '1010.20',
};

await test('single holding match + known CUSIP in knownBondsByDescKey -> ticker resolves to the real CUSIP', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [wellsFargoHolding],
        transactions: [
          {
            id: 'TX-int-resolved-1',
            posted: 1752900100,
            amount: '5.10',
            description: 'INTEREST WELLS FARGO BANK NATL ASSN (Cash)',
          },
        ],
      }),
    ],
  };
  const knownBondsByDescKey = new Map([
    ['WELLS FARGO BANK NATL ASSN|4.2|2030-07-08', '949764WE0'],
  ]);
  const out = mapSimplefinPayload(payload, { knownBondsByDescKey });
  assert.equal(out.bondIncome.length, 1);
  const ev = out.bondIncome[0];
  assert.equal(ev.kind, 'interest');
  assert.equal(ev.ticker, '949764WE0');
  assert.equal(ev.descKey, undefined);
});

await test('single holding match but descKey NOT in knownBondsByDescKey -> ticker stays the issuer, descKey hint added', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [wellsFargoHolding],
        transactions: [
          {
            id: 'TX-int-unresolved-1',
            posted: 1752900100,
            amount: '5.10',
            description: 'INTEREST WELLS FARGO BANK NATL ASSN (Cash)',
          },
        ],
      }),
    ],
  };
  // No knownBondsByDescKey passed at all -> mapOneTransaction's default empty Map.
  const out = mapSimplefinPayload(payload);
  assert.equal(out.bondIncome.length, 1);
  const ev = out.bondIncome[0];
  assert.equal(ev.ticker, 'WELLS FARGO BANK NATL ASSN');
  assert.equal(ev.descKey, 'WELLS FARGO BANK NATL ASSN|4.2|2030-07-08');
});

await test('0 holding matches -> ticker stays the issuer, no descKey', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [
          {
            id: 'HOLD-cd-other',
            symbol: '',
            description: 'CHASE BANK USA NA 3.75000% 01/01/2029',
            market_value: '500.00',
          },
        ],
        transactions: [
          {
            id: 'TX-int-nomatch-1',
            posted: 1752900100,
            amount: '5.10',
            description: 'INTEREST WELLS FARGO BANK NATL ASSN (Cash)',
          },
        ],
      }),
    ],
  };
  const knownBondsByDescKey = new Map([
    ['WELLS FARGO BANK NATL ASSN|4.2|2030-07-08', '949764WE0'],
  ]);
  const out = mapSimplefinPayload(payload, { knownBondsByDescKey });
  assert.equal(out.bondIncome.length, 1);
  const ev = out.bondIncome[0];
  assert.equal(ev.ticker, 'WELLS FARGO BANK NATL ASSN');
  assert.equal(ev.descKey, undefined);
});

await test('2+ holding matches (ambiguous issuer) -> ticker stays the issuer, no resolution', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [
          wellsFargoHolding,
          {
            id: 'HOLD-cd2',
            symbol: '',
            // Same issuer shortName, different coupon/maturity -> two Wells
            // Fargo CDs held in the same account.
            description: 'WELLS FARGO BANK NATL ASSN 5.00000% 03/01/2028',
            market_value: '2000.00',
          },
        ],
        transactions: [
          {
            id: 'TX-int-ambiguous-1',
            posted: 1752900100,
            amount: '5.10',
            description: 'INTEREST WELLS FARGO BANK NATL ASSN (Cash)',
          },
        ],
      }),
    ],
  };
  const knownBondsByDescKey = new Map([
    ['WELLS FARGO BANK NATL ASSN|4.2|2030-07-08', '949764WE0'],
    ['WELLS FARGO BANK NATL ASSN|5|2028-03-01', '949764XX1'],
  ]);
  const out = mapSimplefinPayload(payload, { knownBondsByDescKey });
  assert.equal(out.bondIncome.length, 1);
  const ev = out.bondIncome[0];
  assert.equal(ev.ticker, 'WELLS FARGO BANK NATL ASSN');
  assert.equal(ev.descKey, undefined);
});

await test('normalization: extra spaces / different case in the issuer text still resolves correctly', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [wellsFargoHolding],
        transactions: [
          {
            id: 'TX-int-norm-1',
            posted: 1752900100,
            amount: '5.10',
            // Extra internal spaces + lowercase, to exercise the normalization
            // (issuer text is uppercased/trimmed by extractTicker already,
            // but internal double-spaces are not collapsed by it).
            description: 'INTEREST wells  fargo bank natl assn (Cash)',
          },
        ],
      }),
    ],
  };
  const knownBondsByDescKey = new Map([
    ['WELLS FARGO BANK NATL ASSN|4.2|2030-07-08', '949764WE0'],
  ]);
  const out = mapSimplefinPayload(payload, { knownBondsByDescKey });
  assert.equal(out.bondIncome.length, 1);
  assert.equal(out.bondIncome[0].ticker, '949764WE0');
});

console.log('\n— mapSimplefinPayload: redemption —');

await test('REDEMPTION PAYOUT maps to a sell transaction at face value', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        transactions: [
          {
            id: 'TX-redeem-1',
            posted: 1752900300,
            amount: '1000.00',
            description: 'REDEMPTION PAYOUT WELLS FARGO BANK NATL ASSN CD 4.20000% 07/08/2030 (Cash)',
          },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  assert.equal(out.transactions.length, 1);
  const tx = out.transactions[0];
  assert.equal(tx.side, 'sell');
  assert.equal(tx.assetClass, 'Bank Bonds');
  assert.equal(tx.redemption, true);
  assert.equal(tx.qty, 1); // 1000 / 1000
  assert.equal(tx.price, 1000);
  assert.equal(tx.ticker, 'WELLS FARGO BANK NATL ASSN CD 4.20000% 07/08/2030');
  assert.equal(tx.simplefinId, 'TX-redeem-1');
  assert.equal(out.unmapped.length, 0);
});

console.log('\n— mapSimplefinPayload: excluded cycles —');

await test('INTEREST EARNED CASH / REINVESTMENT CASH pair is excluded entirely', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        transactions: [
          {
            id: 'TX-cyc-1',
            posted: 1752900400,
            amount: '0.42',
            description: 'INTEREST EARNED CASH (123456789) (Cash)',
          },
          {
            id: 'TX-cyc-2',
            posted: 1752900500,
            amount: '-0.42',
            description: 'REINVESTMENT CASH (123456789) (Cash)',
          },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  assert.equal(out.transactions.length, 0);
  assert.equal(out.bondIncome.length, 0);
  assert.equal(out.unmapped.length, 0);
});

await test('DISTRIBUTION rows are excluded entirely', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        transactions: [
          {
            id: 'TX-distrib-1',
            posted: 1752900600,
            amount: '-2.10',
            description: 'DISTRIBUTION NUVEEN MUNI FUND (Cash)',
          },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  assert.equal(out.transactions.length, 0);
  assert.equal(out.bondIncome.length, 0);
  assert.equal(out.unmapped.length, 0);
});

await test('ELECTRONIC FUNDS TRANSFER RECEIVED rows are excluded entirely', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        transactions: [
          {
            id: 'TX-eft-1',
            posted: 1752900650,
            amount: '500.00',
            description: 'Electronic Funds Transfer Received (Cash)',
          },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  assert.equal(out.transactions.length, 0);
  assert.equal(out.bondIncome.length, 0);
  assert.equal(out.unmapped.length, 0);
});

console.log('\n— mapSimplefinPayload: unmapped —');

await test('an unrecognized description lands in unmapped, never silently dropped', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        transactions: [
          {
            id: 'TX-unknown-1',
            posted: 1752900700,
            amount: '-99.00',
            description: 'SOME WEIRD THING NOBODY HAS SEEN (Cash)',
          },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  assert.equal(out.transactions.length, 0);
  assert.equal(out.bondIncome.length, 0);
  assert.equal(out.unmapped.length, 1);
  const item = out.unmapped[0];
  assert.equal(item.simplefinId, 'TX-unknown-1');
  assert.equal(item.description, 'SOME WEIRD THING NOBODY HAS SEEN (Cash)');
  assert.equal(item.amount, -99);
  assert.ok(item.reason);
});

await test('YOU BOUGHT is recognized but routed to unmapped (no structured qty/price)', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        transactions: [
          {
            id: 'TX-bought-1',
            posted: 1752900800,
            amount: '-500.00',
            description: 'YOU BOUGHT VANGUARD TOTAL STOCK MKT ETF (VTI) (Cash)',
          },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  assert.equal(out.transactions.length, 0);
  assert.equal(out.unmapped.length, 1);
  assert.match(out.unmapped[0].reason, /qty\/price/);
});

console.log('\n— mapSimplefinPayload: balance candidates —');

await test('CASH holding is not counted into the Bank Bonds sum', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        'available-balance': '4321.55',
        holdings: [
          { id: 'HOLD-cash', symbol: '', description: 'CASH', market_value: '4321.55' },
          {
            id: 'HOLD-cd1',
            symbol: '',
            description: 'WELLS FARGO BANK NATL ASSN CD 4.20000% 07/08/2030',
            market_value: '1010.20',
          },
          {
            id: 'HOLD-cd2',
            symbol: '',
            description: 'US TREASURY NOTE 3.5% 05/15/2028',
            market_value: '985.00',
          },
          { id: 'HOLD-aapl', symbol: 'AAPL', description: 'APPLE INC', market_value: '5000.00' },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  const cash = out.balanceCandidates.find((c) => c.kind === 'cash');
  const bonds = out.balanceCandidates.find((c) => c.kind === 'bank-bonds');
  assert.ok(cash);
  assert.equal(cash.proposed, 4321.55);
  assert.ok(bonds);
  assert.equal(bonds.proposed, 1010.2 + 985.0);
  assert.equal(cash.accountId, 'ACT-fidelity-1');
  assert.equal(bonds.asOf, cash.asOf);
});

await test('cash falls back to the synthetic CASH holding when available-balance is missing', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        'available-balance': undefined,
        holdings: [{ id: 'HOLD-cash', symbol: '', description: 'CASH', market_value: '777.00' }],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  const cash = out.balanceCandidates.find((c) => c.kind === 'cash');
  assert.ok(cash);
  assert.equal(cash.proposed, 777);
});

await test('no Bank Bonds candidate when there are no symbol-less non-cash holdings', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [
          { id: 'HOLD-cash', symbol: '', description: 'CASH', market_value: '100.00' },
          { id: 'HOLD-aapl', symbol: 'AAPL', description: 'APPLE INC', market_value: '5000.00' },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  assert.equal(out.balanceCandidates.some((c) => c.kind === 'bank-bonds'), false);
});

await test('a bank-bonds-shaped holding with an invalid market_value is excluded from the sum and surfaced in unmapped, not silently dropped', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [
          { id: 'HOLD-cash', symbol: '', description: 'CASH', market_value: '100.00' },
          {
            id: 'HOLD-cd1',
            symbol: '',
            description: 'WELLS FARGO BANK NATL ASSN CD 4.20000% 07/08/2030',
            market_value: '1010.20',
          },
          {
            id: 'HOLD-cd-bad',
            symbol: '',
            description: 'BROKEN CD WITH NO MARKET VALUE',
            market_value: null,
          },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  const bonds = out.balanceCandidates.find((c) => c.kind === 'bank-bonds');
  assert.ok(bonds);
  // Only the valid holding counts toward the total.
  assert.equal(bonds.proposed, 1010.2);
  assert.equal(out.unmapped.length, 1);
  const item = out.unmapped[0];
  assert.equal(item.description, 'BROKEN CD WITH NO MARKET VALUE');
  assert.match(item.reason, /market_value/);
  assert.equal(item.accountId, 'ACT-fidelity-1');
});

await test('a Bank Bonds candidate can still surface even when the only symbol-less non-cash holding has an invalid market_value', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [
          { id: 'HOLD-cash', symbol: '', description: 'CASH', market_value: '100.00' },
          {
            id: 'HOLD-cd-bad',
            symbol: '',
            description: 'BROKEN CD WITH NO MARKET VALUE',
            market_value: undefined,
          },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  // No valid bank-bonds holding was found, so no candidate is proposed...
  assert.equal(out.balanceCandidates.some((c) => c.kind === 'bank-bonds'), false);
  // ...but the broken holding is still visible for manual review.
  assert.equal(out.unmapped.length, 1);
  assert.equal(out.unmapped[0].description, 'BROKEN CD WITH NO MARKET VALUE');
});

console.log('\n— mapSimplefinPayload: bondHoldings (item 41 Bond Matching) —');

await test('bond-shaped holdings are extracted into bondHoldings, with descKey when the description parses', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [
          { id: 'HOLD-cash', symbol: '', description: 'CASH', market_value: '100.00' },
          {
            id: 'HOLD-cd1',
            symbol: '',
            description: 'WELLS FARGO BANK NATL ASSN CD 4.20000% 07/08/2030',
            market_value: '1010.20',
          },
          { id: 'HOLD-aapl', symbol: 'AAPL', description: 'APPLE INC', market_value: '5000.00' },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  // CASH and the ticker-backed AAPL holding are not bank-bonds-shaped —
  // excluded from bondHoldings same as from the Bank Bonds balance sum.
  assert.equal(out.bondHoldings.length, 1);
  const h = out.bondHoldings[0];
  assert.equal(h.description, 'WELLS FARGO BANK NATL ASSN CD 4.20000% 07/08/2030');
  assert.equal(h.marketValue, 1010.2);
  assert.equal(h.descKey, 'WELLS FARGO BANK NATL ASSN CD|4.2|2030-07-08');
  assert.equal(h.couponRate, 4.2);
  assert.equal(h.maturityDate, '2030-07-08');
  assert.equal(h.accountId, 'ACT-fidelity-1');
});

await test('a bond-shaped holding whose description does not parse still appears, with descKey null', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [
          {
            id: 'HOLD-cd-weird',
            symbol: '',
            description: 'SOME UNUSUAL BOND TEXT NO COUPON HERE',
            market_value: '500.00',
          },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  assert.equal(out.bondHoldings.length, 1);
  const h = out.bondHoldings[0];
  assert.equal(h.descKey, null);
  assert.equal(h.couponRate, null);
  assert.equal(h.maturityDate, null);
  assert.equal(h.description, 'SOME UNUSUAL BOND TEXT NO COUPON HERE');
});

console.log('\n— bondHoldings auto-bind against knownBondsByDescKey (item 41) —');

// The actual auto-bind loop lives server-side (api/fidelity-pending.js
// handleSync, no network/Redis in this test suite's scope), but its whole
// job is to look up each bondHoldings[i].descKey in knownBondsByDescKey — a
// one-line lookup this test exercises directly against the real
// mapSimplefinPayload output, so a regression in either the descKey format
// (this file) or the CUSIP map format (lib/bond-meta.js) is caught here.
function autoBind(bondHoldings, knownBondsByDescKey) {
  const bindings = {};
  for (const h of bondHoldings) {
    if (!h.descKey) continue;
    const cusip = knownBondsByDescKey.get(h.descKey);
    if (cusip) bindings[h.descKey] = cusip;
  }
  return bindings;
}

await test('auto-bind resolves when descKey matches a known buy CUSIP', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [
          {
            id: 'HOLD-cd1',
            symbol: '',
            description: 'WELLS FARGO BANK NATL ASSN CD 4.20000% 07/08/2030',
            market_value: '1010.20',
          },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  const knownBondsByDescKey = new Map([
    ['WELLS FARGO BANK NATL ASSN CD|4.2|2030-07-08', '949764WE0'],
  ]);
  const bindings = autoBind(out.bondHoldings, knownBondsByDescKey);
  assert.equal(bindings['WELLS FARGO BANK NATL ASSN CD|4.2|2030-07-08'], '949764WE0');
});

await test('no auto-bind when descKey has no match in knownBondsByDescKey', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [
          {
            id: 'HOLD-cd1',
            symbol: '',
            description: 'WELLS FARGO BANK NATL ASSN CD 4.20000% 07/08/2030',
            market_value: '1010.20',
          },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  const knownBondsByDescKey = new Map([
    ['SOME OTHER ISSUER|3|2029-01-01', 'XYZ12345'],
  ]);
  const bindings = autoBind(out.bondHoldings, knownBondsByDescKey);
  assert.equal(Object.keys(bindings).length, 0);
});

await test('no auto-bind attempted for an unparseable holding (descKey null)', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [
          { id: 'HOLD-weird', symbol: '', description: 'UNUSUAL TEXT NO COUPON', market_value: '500.00' },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  const knownBondsByDescKey = new Map([['ANYTHING|1|2030-01-01', 'ABC']]);
  const bindings = autoBind(out.bondHoldings, knownBondsByDescKey);
  assert.equal(Object.keys(bindings).length, 0);
});

console.log('\n— bond buy transactions synthesized from holdings (jul/2026) —');

const BOND_DESC = 'WELLS FARGO BANK NATL ASSN CD 4.20000% 07/08/2030';
const BOND_DESCKEY = 'WELLS FARGO BANK NATL ASSN CD|4.2|2030-07-08';

await test('a NEW bond (unknown descKey) becomes a buy with cost = purchase_price x shares', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [
          // cost = 0.995 * 10000 = 9950; market value is higher (unrealized gain)
          { id: 'H1', symbol: '', description: BOND_DESC, market_value: '10453.00', purchase_price: '0.995', shares: '10000' },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  const buys = out.transactions.filter((t) => t.assetClass === 'Bank Bonds' && t.side === 'buy');
  assert.equal(buys.length, 1);
  const b = buys[0];
  // cost = qty * price = purchase_price * shares = 9950 (NOT the market value)
  assert.equal(Math.round(b.qty * b.price * 100) / 100, 9950);
  assert.equal(b.price, 1000);
  assert.equal(b.couponRate, 4.2);
  assert.equal(b.maturityDate, '2030-07-08');
  assert.equal(b.source, 'simplefin');
  assert.equal(b.simplefinId, `sfbond-buy:${BOND_DESCKEY}`);
  // ticker is the deterministic synthetic id (maturity YYYYMMDD + coupon bps)
  assert.equal(b.ticker, '20300708420');
});

await test('cost falls back to market value when purchase_price/shares/cost_basis absent', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [
          { id: 'H1', symbol: '', description: BOND_DESC, market_value: '10453.00' },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  const b = out.transactions.find((t) => t.assetClass === 'Bank Bonds' && t.side === 'buy');
  assert.equal(b.qty * b.price, 10453);
});

await test('cost_basis is used when present and purchase_price/shares are not', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [
          { id: 'H1', symbol: '', description: BOND_DESC, market_value: '10453.00', cost_basis: '9800' },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  const b = out.transactions.find((t) => t.assetClass === 'Bank Bonds' && t.side === 'buy');
  assert.equal(b.qty * b.price, 9800);
});

await test('a KNOWN bond (descKey already owned) is NOT re-created', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [
          { id: 'H1', symbol: '', description: BOND_DESC, market_value: '10453.00' },
        ],
      }),
    ],
  };
  const knownBondsByDescKey = new Map([[BOND_DESCKEY, 'CUSIP1234']]);
  const out = mapSimplefinPayload(payload, { knownBondsByDescKey });
  const buys = out.transactions.filter((t) => t.assetClass === 'Bank Bonds' && t.side === 'buy');
  assert.equal(buys.length, 0);
});

await test('an unparseable bond holding (no coupon/maturity) is skipped, not guessed', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [
          { id: 'H1', symbol: '', description: 'UNUSUAL TEXT NO COUPON', market_value: '500.00' },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  const buys = out.transactions.filter((t) => t.assetClass === 'Bank Bonds' && t.side === 'buy');
  assert.equal(buys.length, 0);
});

await test('a bond with no/zero market value is skipped', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [
          { id: 'H1', symbol: '', description: BOND_DESC, market_value: '0' },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  const buys = out.transactions.filter((t) => t.assetClass === 'Bank Bonds' && t.side === 'buy');
  assert.equal(buys.length, 0);
});

console.log('\n— computeNetQty —');

await test('sums buy qty and subtracts sell qty per ticker (case-insensitive)', () => {
  const net = computeNetQty([
    { ticker: 'aapl', side: 'buy', qty: 10 },
    { ticker: 'AAPL', side: 'buy', qty: 5 },
    { ticker: 'AAPL', side: 'sell', qty: 3 },
    { ticker: 'MSFT', side: 'buy', qty: 2 },
  ]);
  assert.equal(net.AAPL, 12);
  assert.equal(net.MSFT, 2);
});

await test('ignores rows with no ticker or no qty', () => {
  const net = computeNetQty([{ side: 'buy', qty: 10 }, { ticker: 'AAPL', side: 'buy' }]);
  assert.deepEqual(net, {});
});

console.log('\n— mapSimplefinPayload: stock/ETF position deltas —');

const SNAPSHOT_DATE = '2025-07-20'; // matches fidelityAccount()'s default balance-date fixture

await test('new ticker (net qty 0) becomes a buy priced at purchase_price', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [{ id: 'H1', symbol: 'AAPL', shares: '5', purchase_price: '150.00', market_value: '900.00' }],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload, { netQtyByTicker: {} });
  const buys = out.transactions.filter((t) => t.ticker === 'AAPL');
  assert.equal(buys.length, 1);
  assert.equal(buys[0].side, 'buy');
  assert.equal(buys[0].qty, 5);
  assert.equal(buys[0].price, 150);
  assert.equal(buys[0].assetClass, 'Stocks');
  assert.equal(buys[0].source, 'simplefin');
  assert.equal(buys[0].derivedFromHoldingsDiff, true);
  // simplefinId is anchored to accountId+ticker+sharesNew (the snapshot's
  // TARGET position), never to asOf/balance-date -- see the idempotency
  // tests below.
  assert.equal(buys[0].simplefinId, `sfstock-delta:ACT-fidelity-1:AAPL:5`);
  assert.match(buys[0].notes, /New position detected/);
});

await test('shares increased (existing position) becomes a delta buy priced at average cost', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [{ id: 'H1', symbol: 'AAPL', shares: '8', purchase_price: '120.00', market_value: '960.00' }],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload, { netQtyByTicker: { AAPL: 3 } });
  const buys = out.transactions.filter((t) => t.ticker === 'AAPL');
  assert.equal(buys.length, 1);
  assert.equal(buys[0].side, 'buy');
  assert.equal(buys[0].qty, 5); // 8 - 3
  assert.equal(buys[0].price, 120);
  assert.match(buys[0].notes, /Position increase detected/);
});

await test('shares decreased (partial, holding still present) becomes a delta sell priced at market_value proxy', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [{ id: 'H1', symbol: 'AAPL', shares: '6', purchase_price: '100.00', market_value: '600.00' }],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload, { netQtyByTicker: { AAPL: 10 } });
  const sells = out.transactions.filter((t) => t.ticker === 'AAPL');
  assert.equal(sells.length, 1);
  assert.equal(sells[0].side, 'sell');
  assert.equal(sells[0].qty, 4); // 10 - 6
  assert.equal(sells[0].price, 100); // 600 / 6
  assert.equal(sells[0].derivedFromHoldingsDiff, true);
  assert.match(sells[0].notes, /Sell price estimated from SimpleFin market value/);
  assert.equal(out.unmapped.filter((u) => u.description && u.description.includes('AAPL')).length, 0);
});

await test('full liquidation (holding listed at 0 shares) has no market_value proxy -> goes to unmapped, no invented sell', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [{ id: 'H1', symbol: 'AAPL', shares: '0', market_value: '0' }],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload, { netQtyByTicker: { AAPL: 10 } });
  const txs = out.transactions.filter((t) => t.ticker === 'AAPL');
  assert.equal(txs.length, 0);
  const unmapped = out.unmapped.filter((u) => u.description && u.description.includes('AAPL'));
  assert.equal(unmapped.length, 1);
  assert.match(unmapped[0].reason, /no market value left/);
  // Regression: unmapped rows derived from a delta must carry a simplefinId
  // too (same as every other unmapped item in this file), or
  // api/fidelity-pending.js's simplefinId-based dedupe never fires and the
  // row piles up unbounded every sync. See simplefinId form assertion below.
  assert.ok(unmapped[0].simplefinId);
  assert.equal(unmapped[0].simplefinId, `sfstock-delta:ACT-fidelity-1:AAPL:0`);
});

await test('unmapped rows from a delta with no purchase_price/cost_basis also carry a simplefinId, and it is stable across repeated syncs', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [{ id: 'H1', symbol: 'AAPL', shares: '5', market_value: '900.00' }],
      }),
    ],
  };
  const out1 = mapSimplefinPayload(payload, { netQtyByTicker: {} });
  const out2 = mapSimplefinPayload(payload, { netQtyByTicker: {} });
  const u1 = out1.unmapped.find((u) => u.description && u.description.includes('AAPL'));
  const u2 = out2.unmapped.find((u) => u.description && u.description.includes('AAPL'));
  assert.ok(u1 && u1.simplefinId);
  assert.equal(u1.simplefinId, u2.simplefinId);
});

await test('unmapped rows from a partial decrease with no market_value also carry a simplefinId', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [{ id: 'H1', symbol: 'AAPL', shares: '4', market_value: '0' }],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload, { netQtyByTicker: { AAPL: 10 } });
  const u = out.unmapped.find((u) => u.description && u.description.includes('AAPL'));
  assert.ok(u && u.simplefinId);
  assert.equal(u.simplefinId, `sfstock-delta:ACT-fidelity-1:AAPL:4`);
});

await test('missing shares field is skipped gracefully (no transaction, no unmapped)', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [{ id: 'H1', symbol: 'AAPL', purchase_price: '150.00', market_value: '900.00' }],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload, { netQtyByTicker: {} });
  assert.equal(out.transactions.filter((t) => t.ticker === 'AAPL').length, 0);
  assert.equal(out.unmapped.filter((u) => u.description && u.description.includes('AAPL')).length, 0);
});

await test('missing purchase_price/cost_basis on a buy delta goes to unmapped, not guessed', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [{ id: 'H1', symbol: 'AAPL', shares: '5', market_value: '900.00' }],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload, { netQtyByTicker: {} });
  assert.equal(out.transactions.filter((t) => t.ticker === 'AAPL').length, 0);
  const unmapped = out.unmapped.filter((u) => u.description && u.description.includes('AAPL'));
  assert.equal(unmapped.length, 1);
  assert.match(unmapped[0].reason, /no purchase_price\/cost_basis/);
});

await test('cost_basis/shares fallback is used when purchase_price is absent', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [{ id: 'H1', symbol: 'AAPL', shares: '5', cost_basis: '500.00', market_value: '900.00' }],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload, { netQtyByTicker: {} });
  const buys = out.transactions.filter((t) => t.ticker === 'AAPL');
  assert.equal(buys.length, 1);
  assert.equal(buys[0].price, 100); // 500 / 5
});

await test('simplefinId is deterministic per accountId+ticker+sharesNew (idempotent across repeated syncs on the same day)', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [{ id: 'H1', symbol: 'AAPL', shares: '5', purchase_price: '150.00', market_value: '900.00' }],
      }),
    ],
  };
  const out1 = mapSimplefinPayload(payload, { netQtyByTicker: {} });
  const out2 = mapSimplefinPayload(payload, { netQtyByTicker: {} });
  assert.equal(out1.transactions[0].simplefinId, out2.transactions[0].simplefinId);
});

await test('the SAME unresolved delta detected on two different days (asOf/balance-date advances, target position unchanged) produces the SAME simplefinId -- real cross-day idempotency', () => {
  // This is the case that used to break: the account's balance-date moves
  // forward every business day the sync runs, but as long as the user hasn't
  // acted on the delta yet, knownQty (from netQtyByTicker) stays 0 and
  // sharesNew stays 5 -- the SAME delta re-detected, not a new one. Anchoring
  // the id to asOf (the pre-fix approach) would mint a new id every day and
  // pile up duplicate candidates in the Trades queue; anchoring to the
  // target position (accountId+ticker+sharesNew) keeps it stable instead.
  const day1 = {
    accounts: [
      fidelityAccount({
        'balance-date': 1753000000,
        holdings: [{ id: 'H1', symbol: 'AAPL', shares: '5', purchase_price: '150.00', market_value: '900.00' }],
      }),
    ],
  };
  const day2 = {
    accounts: [
      fidelityAccount({
        'balance-date': 1753000000 + 86400 * 30, // 30 days later, still unresolved
        holdings: [{ id: 'H1', symbol: 'AAPL', shares: '5', purchase_price: '150.00', market_value: '900.00' }],
      }),
    ],
  };
  const out1 = mapSimplefinPayload(day1, { netQtyByTicker: {} });
  const out2 = mapSimplefinPayload(day2, { netQtyByTicker: {} });
  assert.equal(out1.transactions[0].simplefinId, out2.transactions[0].simplefinId);
  // date still reflects each snapshot's own asOf (only the identity is
  // asOf-independent, not the transaction's date field).
  assert.notEqual(out1.transactions[0].date, out2.transactions[0].date);
});

await test('a genuinely different delta (different target sharesNew) produces a DIFFERENT simplefinId, even same-day', () => {
  const firstDelta = {
    accounts: [
      fidelityAccount({
        holdings: [{ id: 'H1', symbol: 'AAPL', shares: '5', purchase_price: '150.00', market_value: '900.00' }],
      }),
    ],
  };
  const secondDelta = {
    accounts: [
      fidelityAccount({
        holdings: [{ id: 'H1', symbol: 'AAPL', shares: '9', purchase_price: '150.00', market_value: '900.00' }],
      }),
    ],
  };
  const out1 = mapSimplefinPayload(firstDelta, { netQtyByTicker: {} });
  const out2 = mapSimplefinPayload(secondDelta, { netQtyByTicker: {} });
  assert.notEqual(out1.transactions[0].simplefinId, out2.transactions[0].simplefinId);
});

await test('omitting netQtyByTicker entirely skips delta detection (backward compatible, pre-feature behavior)', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [{ id: 'H1', symbol: 'AAPL', shares: '5', purchase_price: '150.00', market_value: '900.00' }],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload);
  assert.equal(out.transactions.filter((t) => t.ticker === 'AAPL').length, 0);
});

await test('asset class inference: CUSIP-shaped symbol -> Bank Bonds, B3-shaped -> BRA Stocks, plain -> Stocks', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [
          { id: 'H1', symbol: '949764WE0', shares: '2', purchase_price: '1000.00', market_value: '2000.00' },
          { id: 'H2', symbol: 'BBSE3', shares: '100', purchase_price: '30.00', market_value: '3000.00' },
          { id: 'H3', symbol: 'MSFT', shares: '10', purchase_price: '300.00', market_value: '3000.00' },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload, { netQtyByTicker: {} });
  const byTicker = Object.fromEntries(out.transactions.map((t) => [t.ticker, t.assetClass]));
  assert.equal(byTicker['949764WE0'], 'Bank Bonds');
  assert.equal(byTicker['BBSE3'], 'BRA Stocks');
  assert.equal(byTicker['MSFT'], 'Stocks');
});

// ── INTEREST resolution via bondBindings (jul/2026) ──────────────────────────
// Second resolution source for the INTEREST branch: the descKey -> CUSIP binds
// the user confirmed by picking a CUSIP on a staged interest row. Exists for
// bonds bought before Fidelity dropped the CUSIP from the CSV — their buy rows
// carry no coupon/maturity, so buildKnownBondsByDescKey can never learn them
// and knownBondsByDescKey alone leaves them unresolved forever.
console.log('\n— INTEREST resolution via bondBindings —');

const wfDescKey = 'WELLS FARGO BANK NATL ASSN|4.2|2030-07-08';

function wellsFargoInterestPayload(txId = 'TX-int-bind-1') {
  return {
    accounts: [
      fidelityAccount({
        holdings: [
          {
            id: 'HOLD-cd1',
            symbol: '',
            description: 'WELLS FARGO BANK NATL ASSN 4.20000% 07/08/2030',
            market_value: '1010.20',
          },
        ],
        transactions: [
          {
            id: txId,
            posted: 1752900100,
            amount: '5.10',
            description: 'INTEREST WELLS FARGO BANK NATL ASSN (Cash)',
          },
        ],
      }),
    ],
  };
}

await test('bondBindings resolves the interest ticker when knownBondsByDescKey cannot', () => {
  const out = mapSimplefinPayload(wellsFargoInterestPayload(), {
    bondBindings: { [wfDescKey]: '949764WE0' },
  });
  assert.equal(out.bondIncome.length, 1);
  const ev = out.bondIncome[0];
  assert.equal(ev.kind, 'interest');
  assert.equal(ev.ticker, '949764WE0');
  assert.equal(ev.descKey, undefined);
});

await test('bondBindings value is normalized (trimmed + uppercased)', () => {
  const out = mapSimplefinPayload(wellsFargoInterestPayload(), {
    bondBindings: { [wfDescKey]: '  949764we0 ' },
  });
  assert.equal(out.bondIncome[0].ticker, '949764WE0');
});

await test('knownBondsByDescKey wins over a conflicting bondBindings entry', () => {
  const out = mapSimplefinPayload(wellsFargoInterestPayload(), {
    knownBondsByDescKey: new Map([[wfDescKey, 'FROMBUY01']]),
    bondBindings: { [wfDescKey]: 'FROMBIND1' },
  });
  assert.equal(out.bondIncome[0].ticker, 'FROMBUY01');
});

await test('a bondBindings entry for a different bond leaves the interest unresolved', () => {
  const out = mapSimplefinPayload(wellsFargoInterestPayload(), {
    bondBindings: { 'SOME OTHER BANK|3.5|2029-01-01': '949764WE0' },
  });
  const ev = out.bondIncome[0];
  assert.equal(ev.ticker, 'WELLS FARGO BANK NATL ASSN');
  assert.equal(ev.descKey, wfDescKey);
});

await test('bondBindings is never applied when the issuer matches 2+ holdings (still ambiguous)', () => {
  const payload = {
    accounts: [
      fidelityAccount({
        holdings: [
          {
            id: 'HOLD-cd1',
            symbol: '',
            description: 'WELLS FARGO BANK NATL ASSN 4.20000% 07/08/2030',
            market_value: '1010.20',
          },
          {
            id: 'HOLD-cd2',
            symbol: '',
            description: 'WELLS FARGO BANK NATL ASSN 3.90000% 01/15/2029',
            market_value: '2020.40',
          },
        ],
        transactions: [
          {
            id: 'TX-int-bind-ambiguous',
            posted: 1752900100,
            amount: '5.10',
            description: 'INTEREST WELLS FARGO BANK NATL ASSN (Cash)',
          },
        ],
      }),
    ],
  };
  const out = mapSimplefinPayload(payload, { bondBindings: { [wfDescKey]: '949764WE0' } });
  const ev = out.bondIncome[0];
  assert.equal(ev.ticker, 'WELLS FARGO BANK NATL ASSN');
  assert.equal(ev.descKey, undefined);
});

await test('omitting bondBindings keeps the pre-feature behavior', () => {
  const out = mapSimplefinPayload(wellsFargoInterestPayload());
  const ev = out.bondIncome[0];
  assert.equal(ev.ticker, 'WELLS FARGO BANK NATL ASSN');
  assert.equal(ev.descKey, wfDescKey);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
