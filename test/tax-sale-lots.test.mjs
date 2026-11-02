import test from 'node:test';
import assert from 'node:assert/strict';
import { saleLotOptions, saleLotGainLoss } from '../src/lib/taxSaleLots.js';
const buy = (id, date, price = 100) => ({ id, date, price, ticker: 'ABC', side: 'buy', qty: 10, fee: 10, currency: 'USD' });
const sale = { id: 'sale', date: '2026-11-01', ticker: 'ABC', side: 'sell', qty: 10, price: 90, fee: 20, currency: 'USD', harvestLots: [{ buyId: 'old', qty: 2 }] };

test('whole-lot options are newest first with remaining quantities, retaining old links', () => {
 const transactions = [buy('old','2025-01-01'),buy('new','2026-10-01'),buy('future','2026-12-01'),{...buy('other','2026-01-01'),ticker:'XYZ'},{...buy('brl','2026-01-01'),currency:'BRL'},sale,{...sale,id:'another-sale',harvestLots:[{buyId:'old',qty:4}]}];
 const lots = saleLotOptions(transactions,sale);
 assert.deepEqual(lots.map(l=>[l.id,l.available]),[['new',10],['old',6]]);
 assert.deepEqual(sale.harvestLots,[{buyId:'old',qty:2}]);
});

test('gain/loss uses recorded selling price with proportional fees and preserves legacy partial amounts', () => {
 assert.equal(saleLotGainLoss(buy('old','2025-01-01'),sale,10),-130);
 assert.equal(saleLotGainLoss(buy('old','2025-01-01'),sale,2),-26);
 assert.equal(saleLotGainLoss(buy('gain','2025-01-01',80),sale,10),70);
 assert.equal(saleLotGainLoss({...buy('missing','2025-01-01'),price:null},sale,10),null);
 assert.equal(saleLotGainLoss(buy('old','2025-01-01'),{...sale,qty:Infinity},10),null);
});
