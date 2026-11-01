import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIncomeHistory } from '../src/lib/incomeHistory.js';
import { buildContributionHistory } from '../src/lib/contributionHistory.js';
const event = (date, totalReceived, ticker = 'ABC', assetClass = 'Stocks') => ({ date, totalReceived, ticker, assetClass });

test('income comparisons match contribution history across all groupings and date cutoffs', () => {
  const events = [event('2025-01-10',20),event('2025-02-20',40),event('2025-07-10',10),event('2025-08-10',50),event('2025-09-20',900),event('2026-01-10',30),event('2026-02-20',20),event('2026-04-10',30),event('2026-05-10',30),event('2026-07-10',20),event('2026-08-10',100),event('2026-09-01',999)];
  const tx = events.map((e,i)=>({id:String(i),date:e.date,side:'buy',ticker:e.ticker,assetClass:e.assetClass,currency:'USD',qty:1,price:e.totalReceived,fee:0}));
  for (const groupBy of ['Month','Quarter','Half','Year']) {
    const rows = buildIncomeHistory(events,{groupBy,today:'2026-08-15'});
    const expected = buildContributionHistory(tx,5,groupBy,'','','2026-08-15');
    assert.deepEqual(rows,expected);
  }
});

test('filters retain hidden calendar references and net taxes and bond interest correctly', () => {
  const rows = buildIncomeHistory([event('2025-06-10',50),event('2026-05-10',100),event('2026-06-10',120),event('2026-06-10',-20),event('2026-06-10',300,'OTHER'),event('2026-06-10',40,'BOND','Bank Bonds')],{today:'2026-07-15',selectedYears:new Set(['2026']),selectedTickers:new Set(['ABC'])});
  assert.equal(rows.length,2);assert.equal(rows[1].value,100);assert.equal(rows[1].yoy,100);assert.equal(rows[1].previous,0);
  const bonds=buildIncomeHistory([event('2026-06-10',40,'BOND','Bank Bonds'),event('2026-06-10',100)],{today:'2026-07-15',selectedAssetClasses:new Set(['Bank Bonds'])});
  assert.equal(bonds[0].value,40);
});

test('missing, zero and negative bases do not produce misleading percentages or bridge gaps', () => {
  const rows=buildIncomeHistory([event('2025-04-01',0),event('2026-02-01',50),event('2026-04-01',100),event('2026-05-01',-20),event('2026-06-01',30)],{today:'2026-07-01'});
  assert.equal(rows[2].previous,null);assert.equal(rows[2].yoy,null);assert.equal(rows[3].previous,-120);assert.equal(rows[4].previous,null);
  assert.deepEqual(buildIncomeHistory([], {today:'invalid'}),[]);
});

test('current yearly comparison clamps leap-day cutoff and excludes later receipts', () => {
  const rows=buildIncomeHistory([event('2023-02-28',50),event('2023-03-01',950),event('2024-02-29',100),event('2024-03-01',1000)],{today:'2024-02-29',groupBy:'Year'});
  const row=rows.at(-1);assert.equal(row.value,100);assert.equal(row.yoy,100);assert.equal(row.previous,null);assert.equal(row.partial,true);
});
