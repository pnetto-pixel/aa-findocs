import test from 'node:test';
import assert from 'node:assert/strict';
import { addCalendarDays, buildHarvestLots, groupHarvestCandidates, washSaleWarnings, scopeHarvestToHoldings } from '../src/lib/taxHarvest.js';

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

test('all recent loss lots keep a conservative purchase-window flag', () => {
  const result = buildHarvestLots([buy('a', '2026-10-15'), buy('b', '2026-10-20', 2, 110)], { ABC: { price: 80, currency: 'USD' } }, '2026-10-31');
  assert.equal(result.candidates.length, 2);
  for (const lot of result.candidates) {
    assert.deepEqual(lot.priorBuys, [{ date: '2026-10-20', qty: 2 }, { date: '2026-10-15', qty: 10 }]);
    assert.equal(lot.clearDate, '2026-11-20');
  }
});

test('recent buys still flag risk after subsequent full or partial lot sales', () => {
  const tx = [
    buy('loss', '2026-01-01'),
    buy('closed', '2026-10-03', 2, 60),
    buy('partial', '2026-10-10', 5, 60),
    buy('old', '2026-09-30', 3, 60),
    sell('2026-10-15', 4, [{ buyId: 'closed', qty: 2 }, { buyId: 'partial', qty: 2 }]),
  ];
  const result = buildHarvestLots(tx, { ABC: { price: 80, currency: 'USD' } }, '2026-10-31');
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].priorBuys, [{ date: '2026-10-10', qty: 5 }, { date: '2026-10-03', qty: 2 }]);
  assert.equal(result.candidates[0].clearDate, '2026-11-10');
  assert.deepEqual(buildHarvestLots(tx, { ABC: { price: 80, currency: 'USD' } }, '2026-11-10').candidates[0].priorBuys, []);
});

test('partial sale does not suppress the purchase-window alert', () => {
  const tx = [buy('a', '2026-10-15'), sell('2026-10-20', 4, [{ buyId: 'a', qty: 4 }])];
  const result = buildHarvestLots(tx, { ABC: { price: 80, currency: 'USD' } }, '2026-10-31');
  assert.equal(result.candidates[0].qty, 6);
  assert.deepEqual(result.candidates[0].priorBuys, [{ date: '2026-10-15', qty: 10 }]);
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

test('open lots include gains, losses and remaining shares with proportional buy fees', () => {
  const tx = [buy('loss', '2026-01-01'), buy('gain', '2026-02-01', 10, 50),
    sell('2026-03-01', 4, [{ buyId: 'loss', qty: 4 }])];
  const result = buildHarvestLots(tx, { ABC: { price: 80, currency: 'USD' } }, '2026-10-31');
  assert.deepEqual(result.openLots.map(lot => lot.buyId), ['gain', 'loss']);
  assert.equal(result.openLots[1].qty, 6);
  assert.equal(result.openLots[1].costPerShare, 101);
  assert.equal(result.openLots[1].gainLoss, -126);
  assert.equal(result.openLots[0].gainLoss, 290);
  assert.ok(Math.abs(result.openLots[0].gainLossPct - (80 / 51 - 1) * 100) < 1e-8);
  assert.equal(result.candidates[0], result.openLots[1]);
});

test('unpriced and unknown-cost lots remain visible without an invented result', () => {
  for (const prices of [{}, { ABC: { price: 0, currency: 'USD' } }]) {
    const result = buildHarvestLots([buy('a', '2026-01-01')], prices, '2026-10-31');
    assert.equal(result.openLots.length, 1);
    assert.equal(result.openLots[0].currentPrice, null);
    assert.equal(result.openLots[0].gainLoss, null);
    assert.equal(result.openLots[0].gainLossPct, null);
    assert.deepEqual(result.candidates, []);
  }
  const unknown = buildHarvestLots([{ ...buy('a', '2026-01-01'), price: null }], { ABC: { price: 80, currency: 'USD' } }, '2026-10-31');
  assert.equal(unknown.openLots[0].costPerShare, null);
  assert.equal(unknown.openLots[0].gainLoss, null);
  assert.deepEqual(unknown.incompleteTickers, ['ABC']);
  const zeroBasis = buildHarvestLots([{ ...buy('a', '2026-01-01', 10, 0), fee: 0 }], { ABC: { price: 80, currency: 'USD' } }, '2026-10-31');
  assert.equal(zeroBasis.openLots[0].gainLoss, 800);
  assert.equal(zeroBasis.openLots[0].gainLossPct, null);
});

test('an incomplete open basis excludes the entire ticker from opportunity totals', () => {
  for (const incomplete of [{ price: null }, { fee: -1 }]) {
    const result = buildHarvestLots([
      buy('loss', '2026-01-01'),
      { ...buy('unknown', '2026-01-02'), ...incomplete },
      { ...buy('other', '2026-01-01'), ticker: 'XYZ' },
    ], { ABC: { price: 80, currency: 'USD' }, XYZ: { price: 80, currency: 'USD' } }, '2026-10-31');
    assert.deepEqual(result.incompleteTickers, ['ABC']);
    assert.deepEqual(result.openLots.filter(lot => lot.ticker === 'ABC').map(lot => lot.gainLoss), [null, -210]);
    assert.deepEqual(result.candidates.map(lot => lot.ticker), ['XYZ']);
    assert.deepEqual(groupHarvestCandidates(result.candidates).totalsByCurrency, { USD: 210 });
  }
  const closedUnknown = buildHarvestLots([
    buy('loss', '2026-01-01'),
    { ...buy('unknown', '2026-01-02'), price: null },
    sell('2026-02-01', 10, [{ buyId: 'unknown', qty: 10 }]),
  ], { ABC: { price: 80, currency: 'USD' } }, '2026-10-31');
  assert.deepEqual(closedUnknown.incompleteTickers, []);
  assert.equal(closedUnknown.candidates.length, 1);
});

test('uncertain and closed lots stay outside open lots and all monetary totals', () => {
  const uncertain = buildHarvestLots([buy('a', '2026-01-01'), sell('2026-02-01', 3, [])], { ABC: { price: 80, currency: 'USD' } }, '2026-10-31');
  assert.deepEqual(uncertain.openLots, []);
  assert.deepEqual(groupHarvestCandidates(uncertain.candidates).totalsByCurrency, {});
  const closed = buildHarvestLots([buy('a', '2026-01-01'), sell('2026-02-01', 10, [{ buyId: 'a', qty: 10 }])], { ABC: { price: 80, currency: 'USD' } }, '2026-10-31');
  assert.deepEqual(closed.openLots, []);
});

test('grouped loss estimates separate currencies and known purchase restrictions', () => {
  const tx = [
    buy('a1', '2026-01-01', 10, 100), buy('a2', '2026-02-01', 10, 90),
    { ...buy('b1', '2026-01-01'), ticker: 'BR', currency: 'BRL' },
    { ...buy('c1', '2026-01-01'), ticker: 'XYZ' },
    { ...buy('replacement', '2026-10-20', 2, 40), ticker: 'XYZ' },
  ];
  const result = buildHarvestLots(tx, { ABC: { price: 80, currency: 'USD' }, BR: { price: 50, currency: 'BRL' }, XYZ: { price: 80, currency: 'USD' } }, '2026-10-31');
  const grouped = groupHarvestCandidates(result.candidates);
  assert.deepEqual(grouped.totalsByCurrency, { USD: 320, BRL: 510 });
  assert.deepEqual(grouped.restrictedTotalsByCurrency, { USD: 210 });
  const abc = grouped.groups.find(group => group.ticker === 'ABC');
  assert.equal(abc.lots.length, 2);
  assert.deepEqual(abc.lots.map(lot => lot.date), ['2026-02-01', '2026-01-01']);
  assert.equal(abc.totalLoss, 320);
  assert.equal(abc.restricted, false);
  const restricted = grouped.groups.find(group => group.ticker === 'XYZ');
  assert.equal(restricted.restricted, true);
  assert.equal(restricted.clearDate, '2026-11-20');
  assert.deepEqual(grouped.groups.map(group => group.currency), ['USD', 'USD', 'BRL']);
});

test('empty and invalid-date histories keep the full result shape', () => {
  const empty = { candidates: [], openLots: [], uncertainTickers: [], incompleteTickers: [], uncertaintyReasons: {} };
  assert.deepEqual(buildHarvestLots([], {}, '2026-10-31'), empty);
  assert.deepEqual(buildHarvestLots([], {}, 'invalid'), empty);
  assert.deepEqual(groupHarvestCandidates(), { groups: [], totalsByCurrency: {}, restrictedTotalsByCurrency: {} });
});

 test('uncertainty reasons distinguish missing lot links, currency and dates', () => {
  const missing = buildHarvestLots([buy('a', '2026-01-01'), { id: 's', ticker: 'ABC', side: 'sell', date: '2026-02-01', qty: 1, price: 80, currency: 'USD' }], {}, '2026-03-01');
  assert.deepEqual(missing.uncertaintyReasons.ABC, ['unlinked-sale']);
  const currency = buildHarvestLots([buy('a', '2026-01-01')], { ABC: { price: 80, currency: 'BRL' } }, '2026-03-01');
  assert.deepEqual(currency.uncertaintyReasons.ABC, ['currency']);
  const date = buildHarvestLots([{ ...buy('a', '2026-01-01'), date: 'invalid' }], {}, '2026-03-01');
  assert.deepEqual(date.uncertaintyReasons.ABC, ['invalid-date']);
});

test('card scope removes bank bonds and closed positions from every section and total', () => {
  const tickers = ['OPEN', 'CLOSED', 'BOND', 'ABSENT'];
  const harvest = {
    candidates: tickers.map(ticker => ({ ticker, buyId: ticker, date: '2026-01-01', currency: 'USD', loss: 10 })),
    openLots: tickers.map(ticker => ({ ticker })),
    uncertainTickers: tickers, incompleteTickers: tickers,
    uncertaintyReasons: Object.fromEntries(tickers.map(ticker => [ticker, ['unlinked-sale']])),
  };
  const result = scopeHarvestToHoldings(harvest, [
    { ticker: 'open', qty: 0.5, assetClass: 'Stocks' },
    { ticker: 'CLOSED', qty: 0, target: 20, assetClass: 'Stocks' },
    { ticker: 'BOND', qty: 10, assetClass: 'Bank Bonds' },
  ]);
  assert.deepEqual(result.candidates.map(l => l.ticker), ['OPEN']);
  assert.deepEqual(result.openLots.map(l => l.ticker), ['OPEN']);
  assert.deepEqual(result.uncertainTickers, ['OPEN']);
  assert.deepEqual(result.incompleteTickers, ['OPEN']);
  assert.deepEqual(Object.keys(result.uncertaintyReasons), ['OPEN']);
  assert.deepEqual(groupHarvestCandidates(result.candidates).totalsByCurrency, { USD: 10 });
  assert.equal(harvest.candidates.length, 4);
});

test('ARE October 12/23 buys are grouped as recent and excluded from main totals', () => {
  const tx = [
    { ...buy('are-old', '2025-01-01', 10, 100), ticker: 'ARE', fee: 0 },
    { ...buy('are-12', '2026-10-12', 23, 43.92), ticker: 'are', fee: 0 },
    { ...buy('are-23a', '2026-10-23', 23, 43.30), ticker: 'ARE', fee: 0 },
    { ...buy('are-23b', '2026-10-23', 14, 43.33), ticker: 'ARE', fee: 0 },
    { ...buy('other', '2025-01-01', 1, 100), ticker: 'XYZ', fee: 0 },
  ];
  const quotes = { ARE: { price: 40.45, currency: 'USD' }, XYZ: { price: 80, currency: 'USD' } };
  for (const today of ['2026-11-02', '2026-11-22']) {
    const result = buildHarvestLots(tx, quotes, today);
    const grouped = groupHarvestCandidates(result.candidates);
    const are = grouped.groups.find(g => g.ticker === 'ARE');
    assert.equal(are.restricted, true);assert.equal(are.lots.length, 4);
    assert.equal(are.clearDate, '2026-11-23');
    assert.deepEqual(grouped.totalsByCurrency, { USD: 20 });
    assert.ok(Math.abs(grouped.restrictedTotalsByCurrency.USD - (595.50 + 185.68)) < 1e-8);
    assert.equal(result.openLots.filter(l => l.ticker === 'ARE').reduce((sum, l) => sum + l.qty, 0), 70);
  }
  const released = groupHarvestCandidates(buildHarvestLots(tx, quotes, '2026-11-23').candidates);
  assert.equal(released.groups.find(g => g.ticker === 'ARE').restricted, false);
  assert.deepEqual(released.restrictedTotalsByCurrency, {});
});

test('purchase alert includes same day/day 30, ignores future buys and extends with latest buy', () => {
  const quotes = { ABC: { price: 80, currency: 'USD' } };
  const tx = [buy('old', '2025-01-01'), buy('today', '2026-11-02', 0.5), buy('future', '2026-11-03')];
  const result = buildHarvestLots(tx, quotes, '2026-11-02');
  assert.deepEqual(result.candidates[0].priorBuys, [{ date: '2026-11-02', qty: 0.5 }]);
  assert.equal(result.candidates[0].clearDate, '2026-12-03');
  const next = buildHarvestLots(tx, quotes, '2026-11-03');
  assert.equal(next.candidates[0].clearDate, '2026-12-04');
});
