// A transaction is linked in either direction: it may hold a tax link or be
// the target of a link on another transaction.
import { currencyForAssetClass } from './parsing.js';

export function hasTaxLinks(transaction, transactions) {
  if (!transaction) return false;
  if (transaction.harvestRebuySaleId || transaction.harvestLots?.length) return true;
  return transactions.some((other) => other.id !== transaction.id &&
    (other.harvestRebuySaleId === transaction.id || (other.harvestLots || []).some((lot) => lot.buyId === transaction.id)));
}

export function hasLinkedRebuys(transaction, transactions) {
  return transactions.some((tx) => tx.id !== transaction.id && tx.harvestRebuySaleId === transaction.id);
}

// Class changes can change both currency and contribution rules (Bank Bonds),
// so block even same-currency changes until the tax links are removed.
export function hasBulkTaxClassConflict(transactions, ids, nextClass) {
  const selected = new Set(ids);
  return transactions.some((tx) => selected.has(tx.id) && tx.assetClass !== nextClass && hasTaxLinks(tx, transactions));
}

export function hasExternalTaxReferences(transactions, ids) {
  const selected = new Set(ids);
  return transactions.some((tx) => !selected.has(tx.id) &&
    (selected.has(tx.harvestRebuySaleId) || (tx.harvestLots || []).some((lot) => selected.has(lot.buyId))));
}

// Validate links against the complete post-import list: users can deselect
// individual CSV rows or import in replace mode, either of which can orphan a
// reference even when the exported file was internally consistent.
export function validateImportedTaxLinks(transactions) {
  const byId = new Map(transactions.map(tx => [tx.id, tx]));
  const allocated = new Map();
  const ticker = tx => String(tx.ticker || '').trim().toUpperCase();
  const currency = tx => tx.currency || currencyForAssetClass(tx.assetClass);
  for (const tx of transactions) {
    if (tx.harvestRebuySaleId) {
      const sale = byId.get(tx.harvestRebuySaleId);
      if (tx.side !== 'buy' || !sale || sale.side !== 'sell' || !sale.harvestSale || !ticker(tx) || ticker(tx) !== ticker(sale) || !currency(tx) || currency(tx) !== currency(sale) || !tx.date || !sale.date || sale.date > tx.date) return 'A linked repurchase is missing its matching harvesting sale or has incompatible ticker, currency or date.';
    }
    if (!tx.harvestLots?.length) continue;
    if (tx.side !== 'sell') return 'Only sales can have lot allocations.';
    let total = 0;
    for (const lot of tx.harvestLots) {
      const buy = byId.get(lot.buyId);
      const qty = Number(lot.qty);
      if (!buy || buy.side !== 'buy' || !ticker(tx) || ticker(tx) !== ticker(buy) || !currency(tx) || currency(tx) !== currency(buy) || !tx.date || !buy.date || buy.date > tx.date || !Number.isFinite(qty) || qty <= 0) return 'A sale references a missing or incompatible purchase lot.';
      total += qty;
      allocated.set(buy.id, (allocated.get(buy.id) || 0) + qty);
      if (allocated.get(buy.id) > Number(buy.qty) + 1e-8) return 'Linked sales exceed the quantity available in a purchase lot.';
    }
    if (total > Number(tx.qty) + 1e-8) return 'Linked lot quantities exceed the sale quantity.';
  }
  return null;
}
