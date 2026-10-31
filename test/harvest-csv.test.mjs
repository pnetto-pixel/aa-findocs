import { strict as assert } from 'node:assert';
import Papa from 'papaparse';
import { parseCSVOrPaste, parseRow } from '../src/lib/parsing.js';

const csv = Papa.unparse([
  { id: 'buy-1', date: '2026-01-01', side: 'buy', ticker: 'ABC', qty: 3, price: 10, assetClass: 'Stocks', fee: 0, harvestSale: '', harvestLots: '', harvestRebuySaleId: '' },
  { id: 'sell-1', date: '2026-02-01', side: 'sell', ticker: 'ABC', qty: 2, price: 8, assetClass: 'Stocks', fee: 1, harvestSale: true, harvestLots: JSON.stringify([{ buyId: 'buy-1', qty: 2 }]), harvestRebuySaleId: '' },
  { id: 'buy-2', date: '2026-03-05', side: 'buy', ticker: 'ABC', qty: 2, price: 8, assetClass: 'Stocks', fee: 0, harvestSale: '', harvestLots: '', harvestRebuySaleId: 'sell-1' },
]);
const results = parseCSVOrPaste(csv).rows.map(row => parseRow(row));
assert.ok(results.every(r => r.ok));
assert.equal(results[0].tx.id, 'buy-1');
assert.equal(results[1].tx.harvestSale, true);
assert.deepEqual(results[1].tx.harvestLots, [{ buyId: 'buy-1', qty: 2 }]);
assert.equal(results[2].tx.harvestRebuySaleId, 'sell-1');
const invalid = parseRow({ date: '2026-01-01', side: 'sell', ticker: 'ABC', qty: 1, price: 1, harvestLots: 'not-json' });
assert.equal(invalid.ok, false);
assert.match(invalid.errors.join(' '), /harvestLots/);
const legacy = parseRow({ date: '2026-01-01', side: 'buy', ticker: 'ABC', qty: 1, price: 1 });
assert.ok(legacy.ok && legacy.tx.id);
console.log('harvest CSV roundtrip tests passed');
