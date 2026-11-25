// Rebalance: per-asset purchase target in dollars. Whole-share buys aim for the
// integer quantity closest to this, within +/-10%; outside that band, the largest
// quantity that stays at or under the target.
export const PER_ASSET_TARGET = 1000;
const PER_ASSET_BAND_LOW = PER_ASSET_TARGET * 0.9; // 900
const PER_ASSET_BAND_HIGH = PER_ASSET_TARGET * 1.1; // 1100

// resourceLimit = min(gap, remainingCash) - hard ceiling, never exceeded.
// cashLimit = remainingCash alone (Infinity when no cash budget is set).
function pickShareQty(price, resourceLimit, cashLimit) {
  if (!(price > 0)) return 0;
  // One share already costs more than the top of the band. Shares are
  // indivisible, so suggest exactly one rather than hiding the holding -
  // the gap ceiling cannot be honored here, but the cash budget still is.
  if (price > PER_ASSET_BAND_HIGH) return price <= cashLimit ? 1 : 0;
  if (resourceLimit <= 0) return 0;
  // Not enough room to reach the band - fall back to whatever fits.
  if (resourceLimit < PER_ASSET_BAND_LOW) return Math.floor(resourceLimit / price);
  const effectiveHigh = Math.min(PER_ASSET_BAND_HIGH, resourceLimit);
  // value(n) is linear in n, so the nearest integer to the target is round(target/price).
  const idealQty = Math.round(PER_ASSET_TARGET / price);
  const idealValue = idealQty * price;
  if (idealQty >= 1 && idealValue >= PER_ASSET_BAND_LOW && idealValue <= effectiveHigh) return idealQty;
  // Band unreachable with any integer -> largest qty at or under the target.
  return Math.floor(Math.min(PER_ASSET_TARGET, resourceLimit) / price);
}

// Manual value-only classes that can still be topped up with a dollar amount
// (no share price, so the suggestion is a value, not a quantity).
const VALUE_TARGET_CLASSES = new Set(["BRA Fixed Income", "Bank Bonds"]);

function isBraFixedIncome(h) {
  return (
    h.type === "manual" &&
    (h.assetClass || "").trim().toLowerCase() === "bra fixed income"
  );
}

// Existing Cash supplies a cap without adding money to the target denominator.
export function standardRebalance({ holdings, totalValue, cash, fundingSource, usdBrlRate, holdingValue, isCash, targetOf = h => h.target }) {
  const investableTotal = totalValue + (fundingSource === "new" ? cash : 0);
  if (investableTotal <= 0) return [];

  // Build candidate list: only underweight holdings with valid prices
  const candidates = holdings
    .filter((h) => {
      if (isCash(h)) return false; // cash sits separately, not rebalanced
      if (targetOf(h) <= 0) return false;
      if (h.type === "manual") {
        if (h.manualMode === "value") {
          if (!VALUE_TARGET_CLASSES.has(h.assetClass)) return false;
          // BRA Fixed Income reads as 0 USD when the live FX rate hasn't
          // loaded yet - skip rather than suggest an inflated gap.
          if (isBraFixedIncome(h) && !usdBrlRate) return false;
          return true;
        }
        return h.manualPrice != null && h.manualPrice > 0 && h.qty != null;
      }
      return h.price != null && h.price > 0;
    })
    .map((h) => {
      const currentValue = holdingValue(h);
      const targetValue = investableTotal * (targetOf(h) / 100);
      const gap = targetValue - currentValue;
      const price = h.type === "manual" ? h.manualPrice : h.price;
      return { holding: h, currentValue, targetValue, gap, price };
    })
    .filter((c) => c.gap > 0); // underweight only

  // Sort: largest gap first
  candidates.sort((a, b) => b.gap - a.gap);

  // Allocate cash targeting ~$1K per asset (or up to gap, whichever is smaller)
  let remainingCash = cash > 0 ? cash : Infinity;
  const suggestions = [];
  for (const c of candidates) {
    if (remainingCash <= 0) break;
    if (c.holding.manualMode === "value") {
      // No share price: suggest the exact dollar amount, no band/floor.
      const allocDollars = Math.min(PER_ASSET_TARGET, c.gap, remainingCash);
      if (allocDollars <= 0) continue;
      suggestions.push({
        holding: c.holding,
        currentValue: c.currentValue,
        targetValue: c.targetValue,
        deltaShares: null,
        deltaDollars: allocDollars,
        gap: c.gap,
      });
      remainingCash -= allocDollars;
      continue;
    }
    const resourceLimit = Math.min(c.gap, remainingCash);
    const qty = pickShareQty(c.price, resourceLimit, remainingCash);
    if (qty <= 0) continue; // no affordable whole share for the available room
    const actualDollars = qty * c.price;
    suggestions.push({
      holding: c.holding,
      currentValue: c.currentValue,
      targetValue: c.targetValue,
      deltaShares: qty,
      deltaDollars: actualDollars,
      gap: c.gap,
    });
    remainingCash -= actualDollars;
  }

  return suggestions;
}
