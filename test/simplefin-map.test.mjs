// Run with: node test/simplefin-map.test.mjs
// Fixtures are synthetic — no real account data. Shapes mirror the real
// SimpleFin payload confirmed by the Fase 0 probe (see
// docs/plans/simplefin-fidelity-feed.md, "Incerteza nº 1").

import { strict as assert } from 'node:assert';
import { mapSimplefinPayload, isFidelityOrg } from '../lib/simplefin-map.js';

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

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
