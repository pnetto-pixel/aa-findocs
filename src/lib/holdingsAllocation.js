export const tickerKey = value => String(value || "").trim().toUpperCase();
export const classKey = value => String(value || "").trim().toLowerCase();
export const isCashHolding = h => h.type === "manual" && classKey(h.assetClass) === "cash";
export const isValueHolding = h => h.type === "manual" && h.manualMode === "value";

const number = value => value != null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function exDellAllocation(holdings, usdBrlRate) {
  const rows = holdings.filter(h => tickerKey(h.ticker) !== "DELL").map(holding => {
    const cash = isCashHolding(holding);
    const assetClass = cash ? "Cash" : String(holding.assetClass || "Uncategorized").trim() || "Uncategorized";
    const sharePrice = number(holding.type === "manual" ? holding.manualPrice : holding.price);
    const qty = number(holding.qty);
    const isValue = isValueHolding(holding);
    const amount = number(holding.manualValue);
    const fx = holding.manualCurrency === "BRL";
    const value = isValue
      ? amount === 0 ? 0 : amount == null || (fx && !(usdBrlRate > 0)) ? null : amount / (fx ? usdBrlRate : 1)
      : qty === 0 ? 0 : qty == null || !(sharePrice > 0) ? null : qty * sharePrice;
    const ticker = tickerKey(holding.ticker);
    return {
      id: String(holding.id || ticker || holding.name), ticker, name: holding.name || ticker,
      classId: classKey(assetClass), assetClass, cash, value: Number.isFinite(value) ? value : null,
      rawTarget: Math.max(0, number(holding.target) || 0),
      sharePrice: !isValue && sharePrice > 0 ? sharePrice : null, fxMissing: fx && !(usdBrlRate > 0), holding,
    };
  }).sort((a, b) => compare(a.ticker, b.ticker) || compare(a.id, b.id));
  const total = rows.reduce((sum, row) => sum + (row.value ?? 0), 0);
  const targetSum = rows.reduce((sum, row) => sum + row.rawTarget, 0);
  const complete = rows.every(row => row.value != null);
  for (const row of rows) row.target = targetSum > 0 ? row.rawTarget / targetSum : null;
  return { rows, total, targetSum, complete };
}

export function groupExDellAllocation(allocation, byClass) {
  const groups = new Map();
  for (const row of allocation.rows) {
    const key = byClass ? row.classId : row.id;
    const group = groups.get(key) || {
      key, label: byClass ? row.assetClass : row.cash ? row.name : row.ticker || row.name, value: 0, target: 0,
      dayValue: 0, dayWeighted: 0, unknown: false,
    };
    group.value += row.value ?? 0;
    group.unknown ||= row.value == null;
    group.target += row.target ?? 0;
    const h = row.holding;
    if (h.type !== "manual" && row.value > 0 && Number(h.previousClose) > 0 && row.sharePrice > 0) {
      group.dayValue += row.value;
      group.dayWeighted += row.value * 100 * (row.sharePrice / Number(h.previousClose) - 1);
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => compare(a.label, b.label) || compare(a.key, b.key)).map(g => {
    const target = allocation.targetSum > 0 ? g.target * 100 : null;
    const actual = allocation.complete && allocation.total > 0 ? g.value / allocation.total * 100 : null;
    return { ...g, target, actual, gap: actual == null || target == null ? null : actual - target };
  });
}
