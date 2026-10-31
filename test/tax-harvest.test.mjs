import test from 'node:test';
import assert from 'node:assert/strict';
import { addCalendarDays, buildHarvestLots, washSaleWarnings } from '../src/lib/taxHarvest.js';

const buy = (id, date, qty = 10, price = 100) => ({ id, date, side: 'buy', ticker: 'abc', qty, price, fee: 10, currency: 'USD' });
const sell = (date, qty, harvestLots) => ({ id: 's', date, side: 'sell', ticker: 'ABC', qty, harvestLots, currency: 'USD' });

test('wash window includes the sale and next 30 days, including across years', () => {
  const tx = [{ ...sell('2025-12-20', 1, []), harvestSale: true }];
  assert.deepEqual(washSaleWarnings(tx, '2025-12-19'), {});
  assert.equal(washSaleWarnings(tx, '2025-12-20').ABC.safeDate, '2026-01-20');
  assert.ok(washSaleWarnings(tx, '2026-01-19').ABC);
  assert.deepEqual(washSaleWarnings(tx, '2026-01-20'), {});
  assert.equal(addCalendarDays('2024-02-28', 2), '2024-03-01');
  assert.equal(addCalendarDays('2026-02-30', 1), null);
});

test('latest marked sale controls the end of the warning', () => {
  const tx = [{ ...sell('2026-01-01', 1, []), harvestSale: true }, { ...sell('2026-01-20', 1, []), harvestSale: true }];
  assert.deepEqual(washSaleWarnings(tx, '2026-01-25').ABC, { saleDate: '2026-01-20', safeDate: '2026-02-20' });
});

test('computes remaining lot shares, prorated fees and purchase window', () => {
  const tx = [buy('a', '2026-01-01'), buy('b', '2026-01-31', 5, 80), sell('2026-02-01', 4, [{ buyId: 'a', qty: 4 }])];
  const { candidates, uncertainTickers } = buildHarvestLots(tx, { ABC: { price: 90, currency: 'USD' } }, '2026-03-02');
  assert.deepEqual(uncertainTickers, []);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].qty, 6);
  assert.equal(candidates[0].loss, 66);
  assert.equal(candidates[0].clearDate, '2026-03-03');
  assert.deepEqual(candidates[0].priorBuys, [{ date: '2026-01-31', qty: 5 }]);
  assert.equal(buildHarvestLots(tx, { ABC: { price: 90, currency: 'USD' } }, '2026-03-03').candidates[0].clearDate, null);
});

test('unlinked or invalid sales prevent false claims about remaining lots', () => {
  for (const allocations of [undefined, [], [{ buyId: 'missing', qty: 2 }], [{ buyId: 'a', qty: 11 }]]) {
    const result = buildHarvestLots([buy('a', '2026-01-01'), sell('2026-01-02', 2, allocations)], { ABC: { price: 50, currency: 'USD' } }, '2026-02-01');
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.uncertainTickers, ['ABC']);
  }
});

test('fully sold, profitable, future, and unpriced buys do not become candidates', () => {
  const tx = [buy('a', '2026-01-01'), sell('2026-01-02', 10, [{ buyId: 'a', qty: 10 }]), buy('b', '2026-03-01')];
  assert.deepEqual(buildHarvestLots(tx, { ABC: { price: 50, currency: 'USD' } }, '2026-02-01').candidates, []);
  assert.deepEqual(buildHarvestLots([buy('a', '2026-01-01')], {}, '2026-02-01').candidates, []);
  assert.deepEqual(buildHarvestLots([buy('a', '2026-01-01')], { ABC: { price: 0, currency: 'USD' } }, '2026-02-01').candidates, []);
  assert.deepEqual(buildHarvestLots([buy('a', '2026-01-01')], { ABC: { price: 101, currency: 'USD' } }, '2026-02-01').candidates, []);
});

test('undated sales leave the ticker uncertain', () => {
  const result = buildHarvestLots([buy('a', '2026-01-01'), sell('', 1, [])], { ABC: { price: 50, currency: 'USD' } }, '2026-02-01');
  assert.deepEqual(result.uncertainTickers, ['ABC']);
  assert.deepEqual(result.candidates, []);
});

test('recent loss lots sold together cannot replace themselves', () => {
  const result = buildHarvestLots([buy('a', '2026-10-15'), buy('b', '2026-10-20', 2, 110)], { ABC: { price: 80, currency: 'USD' } }, '2026-10-31');
  assert.equal(result.candidates.length, 2);
  for (const lot of result.candidates) {
    assert.deepEqual(lot.priorBuys, []);
    assert.equal(lot.clearDate, null);
  }
});

test('only recent replacement shares still held after the hypothetical sale trigger a warning', () => {
  const tx = [
    buy('loss', '2026-01-01'),
    buy('closed', '2026-10-03', 2, 60),
    buy('partial', '2026-10-10', 5, 60),
    buy('old', '2026-09-30', 3, 60),
    sell('2026-10-15', 4, [{ buyId: 'closed', qty: 2 }, { buyId: 'partial', qty: 2 }]),
  ];
  const result = buildHarvestLots(tx, { ABC: { price: 80, currency: 'USD' } }, '2026-10-31');
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].priorBuys, [{ date: '2026-10-10', qty: 3 }]);
  assert.equal(result.candidates[0].clearDate, '2026-11-10');
  assert.deepEqual(buildHarvestLots(tx, { ABC: { price: 80, currency: 'USD' } }, '2026-11-10').candidates[0].priorBuys, []);
});

test('loss lot shares sold partially in the past do not become replacement shares', () => {
  const tx = [buy('a', '2026-10-15'), sell('2026-10-20', 4, [{ buyId: 'a', qty: 4 }])];
  const result = buildHarvestLots(tx, { ABC: { price: 80, currency: 'USD' } }, '2026-10-31');
  assert.equal(result.candidates[0].qty, 6);
  assert.deepEqual(result.candidates[0].priorBuys, []);
});


test('unproven or mismatched currencies make the ticker uncertain', () => {
  const quote = { ABC: { price: 80, currency: 'USD' } };
  for (const tx of [
    [{ ...buy('a', '2026-10-01'), currency: undefined }],
    [buy('a', '2026-10-01'), { ...buy('b', '2026-10-02'), currency: 'BRL' }],
    [buy('a', '2026-10-01'), { ...sell('2026-10-02', 1, [{ buyId: 'a', qty: 1 }]), currency: 'BRL' }],
  ]) {
    const result = buildHarvestLots(tx, quote, '2026-10-31');
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.uncertainTickers, ['ABC']);
  }
  for (const quotes of [{ ABC: { price: 80, currency: 'BRL' } }, { ABC: { price: 80 } }, { ABC: 80 }]) {
    const result = buildHarvestLots([buy('a', '2026-10-01')], quotes, '2026-10-31');
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.uncertainTickers, ['ABC']);
  }
  assert.equal(buildHarvestLots([{ ...buy('a', '2026-10-01'), currency: 'BRL' }], { ABC: { price: 80, currency: 'BRL' } }, '2026-10-31').candidates.length, 1);
});


test('legacy transactions derive a known currency from asset class', () => {
  const legacy = { ...buy('a', '2026-10-01'), currency: undefined, assetClass: 'BRA Stocks' };
  const result = buildHarvestLots([legacy], { ABC: { price: 80, currency: 'BRL' } }, '2026-10-31');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].currency, 'BRL');
});
