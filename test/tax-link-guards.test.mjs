import { strict as assert } from 'node:assert';
import { hasTaxLinks, hasLinkedRebuys, hasBulkTaxClassConflict, hasExternalTaxReferences, validateImportedTaxLinks } from '../src/lib/taxLinkGuards.js';

const rows = [
  { id: 'lot', side: 'buy', ticker: 'ABC', date: '2026-01-01', qty: 10, currency: 'USD', assetClass: 'Stocks' },
  { id: 'sale', side: 'sell', ticker: 'ABC', date: '2026-02-01', qty: 5, currency: 'USD', assetClass: 'Stocks', harvestSale: true, harvestLots: [{ buyId: 'lot', qty: 5 }] },
  { id: 'rebuy', side: 'buy', ticker: 'ABC', date: '2026-03-10', qty: 5, currency: 'USD', assetClass: 'Stocks', harvestRebuySaleId: 'sale' },
  { id: 'free', side: 'buy', ticker: 'XYZ', date: '2026-01-01', qty: 2, currency: 'USD', assetClass: 'Stocks' },
];
assert.equal(validateImportedTaxLinks(rows), null);
assert.equal(hasTaxLinks(rows[0], rows), true);
assert.equal(hasTaxLinks(rows[1], rows), true);
assert.equal(hasTaxLinks(rows[2], rows), true);
assert.equal(hasTaxLinks(rows[3], rows), false);
assert.equal(hasLinkedRebuys(rows[1], rows), true);
assert.equal(hasBulkTaxClassConflict(rows, ['lot'], 'BRA Stocks'), true);
assert.equal(hasBulkTaxClassConflict(rows, ['sale', 'rebuy'], 'Bank Bonds'), true);
assert.equal(hasBulkTaxClassConflict(rows, ['sale'], 'Stocks'), false);
assert.equal(hasBulkTaxClassConflict(rows, ['free'], 'BRA Stocks'), false);
assert.equal(hasExternalTaxReferences(rows, ['lot']), true);
assert.equal(hasExternalTaxReferences(rows, ['sale']), true);
assert.equal(hasExternalTaxReferences(rows, ['lot', 'sale', 'rebuy']), false);
assert.match(validateImportedTaxLinks(rows.filter(tx => tx.id !== 'lot')), /missing or incompatible purchase/);
assert.match(validateImportedTaxLinks(rows.filter(tx => tx.id !== 'sale')), /missing its matching harvesting sale/);
assert.match(validateImportedTaxLinks(rows.map(tx => tx.id === 'rebuy' ? { ...tx, currency: 'BRL' } : tx)), /incompatible ticker, currency or date/);
assert.match(validateImportedTaxLinks(rows.map(tx => tx.id === 'sale' ? { ...tx, harvestLots: [{ buyId: 'lot', qty: 11 }] } : tx)), /exceed/);
assert.match(validateImportedTaxLinks(rows.map(tx => tx.id === 'sale' ? { ...tx, harvestSale: false } : tx)), /matching harvesting sale/);
