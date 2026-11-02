import { currencyForAssetClass } from './parsing.js';
const ticker = tx => String(tx.ticker || '').trim().toUpperCase();
const currency = tx => tx.currency || currencyForAssetClass(tx.assetClass);

export function saleLotOptions(transactions, sale) {
  return transactions.filter(tx => tx.side === 'buy' && ticker(tx) === ticker(sale) && currency(tx) === currency(sale) && tx.date <= sale.date)
    .map(buy => {
      const used = transactions.filter(tx => tx.id !== sale.id && tx.side === 'sell').reduce((sum, tx) => sum + (tx.harvestLots || []).filter(lot => lot.buyId === buy.id).reduce((value, lot) => value + Number(lot.qty || 0), 0), 0);
      return { ...buy, available: Math.max(0, Number(buy.qty) - used) };
    }).filter(buy => buy.available > 1e-8 || (sale.harvestLots || []).some(lot => lot.buyId === buy.id && lot.qty > 0))
    .sort((a, b) => b.date.localeCompare(a.date));
}

// Preview at the recorded sale price, with proportional purchase/sale fees.
export function saleLotGainLoss(buy, sale, qty) {
  if (![Number(buy.qty), Number(sale.qty)].every(Number.isFinite)) return null;
  if (!(Number(buy.qty) > 0) || !(Number(sale.qty) > 0) || !(qty > 0)) return null;
  if (buy.price == null || sale.price == null || buy.price === '' || sale.price === '') return null;
  const price = Number(buy.price), salePrice = Number(sale.price), buyFee = Number(buy.fee || 0), saleFee = Number(sale.fee || 0);
  if (![price, salePrice, buyFee, saleFee, qty].every(Number.isFinite) || Math.min(price, salePrice, buyFee, saleFee) < 0) return null;
  return ((salePrice - saleFee / Number(sale.qty)) - (price + buyFee / Number(buy.qty))) * qty;
}
