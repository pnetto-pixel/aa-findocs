import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHalfInvested, computeMonthlyInvested } from '../src/lib/contributionCapacity.js';
import { buildContributionHistory } from '../src/lib/contributionHistory.js';
import { buildAccumulatedInvestment } from '../src/lib/accumulatedInvestment.js';

const sale = { id: 's', date: '2025-01-20', side: 'sell', ticker: 'ABC', assetClass: 'Stocks', currency: 'USD', qty: 10, price: 10, fee: 2, harvestSale: true };
const buy = (id, date, price, extra = {}) => ({ id, date, side: 'buy', ticker: 'ABC', assetClass: 'Stocks', currency: 'USD', qty: 1, price, fee: 0, harvestRebuySaleId: 's', ...extra });

test('linked buys consume net proceeds once across months and respect cutoff', () => {
  const tx = [sale, buy('b1', '2025-02-02', 60), buy('b2', '2025-03-20', 70)];
  assert.equal(computeMonthlyInvested(tx, 5, '2025-02'), 0);
  assert.equal(computeMonthlyInvested(tx, 5, '2025-03'), 32);
  assert.deepEqual(computeHalfInvested(tx, 5, 2025, 3), { half1: 0, half2: 32 });
  const history = buildContributionHistory(tx, 5, 'Month', '', '', '2025-03-31');
  assert.equal(history.find(x => x.key === '2025-03').value, 32);
  const filtered = buildContributionHistory(tx, 5, 'Month', '2025-03-01', '2025-03-31', '2025-03-31');
  assert.equal(filtered[0].value, 32);
  const accum = buildAccumulatedInvestment(tx, 5, { today: '2025-03-31' });
  assert.equal(accum.at(-1).value, 32);
});

test('only same ticker, marked sales and later buys are eligible', () => {
  const tx = [sale, buy('before', '2025-01-01', 5), buy('other', '2025-02-01', 20, { ticker: 'XYZ' }), buy('unknown', '2025-02-02', 10, { harvestRebuySaleId: 'missing' })];
  assert.equal(computeMonthlyInvested(tx, 5, '2025-01'), 5);
  assert.equal(computeMonthlyInvested(tx, 5, '2025-02'), 30);
  assert.equal(computeMonthlyInvested([{ ...sale, harvestSale: false }, buy('x', '2025-02-03', 20)], 5, '2025-02'), 20);
});

test('bond rollovers in same bucket are not deducted twice', () => {
  const bondSale = { ...sale, assetClass: 'Bank Bonds', date: '2025-02-01' };
  const bondBuy = buy('b', '2025-02-02', 150, { assetClass: 'Bank Bonds' });
  const tx = [bondSale, bondBuy];
  assert.equal(computeMonthlyInvested(tx, 5, '2025-02'), 52);
  assert.deepEqual(computeHalfInvested(tx, 5, 2025, 2), { half1: 52, half2: 0 });
  assert.equal(buildContributionHistory(tx, 5, 'Month', '', '', '2025-02-28')[0].value, 52);
  assert.equal(buildAccumulatedInvestment(tx, 5, { today: '2025-02-28' }).at(-1).value, 52);
  // Unmarked bond sales retain their existing contribution treatment.
  const ordinary = [{ ...bondSale, harvestSale: false }, { ...bondBuy, harvestRebuySaleId: '' }];
  assert.equal(computeMonthlyInvested(ordinary, 5, '2025-02'), 48);
});
