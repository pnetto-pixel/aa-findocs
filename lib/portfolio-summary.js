// Pure, read-only projection of the persisted holdings and contribution history.
// Keep this module free of Redis/auth concerns so its financial math is testable.

function finiteNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 8) {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function holdingValueUSD(holding) {
  if (holding?.type === 'manual') {
    if (holding.manualMode === 'value') {
      const value = finiteNumber(holding.manualValue) ?? 0;
      // The browser keeps USD/BRL only in localStorage, not Redis. Returning null
      // is safer than silently treating a BRL balance as dollars.
      return holding.manualCurrency === 'BRL' ? null : value;
    }
    const qty = finiteNumber(holding.qty);
    const price = finiteNumber(holding.manualPrice);
    return qty != null && price != null ? qty * price : 0;
  }
  const qty = finiteNumber(holding?.qty);
  const price = finiteNumber(holding?.price);
  return qty != null && price != null ? qty * price : 0;
}

function nativePrice(holding) {
  if (holding?.type === 'manual') {
    if (holding.manualMode === 'qty_price') return finiteNumber(holding.manualPrice);
    return null;
  }
  return finiteNumber(holding?.price);
}

function contributionProjection(history, currentMonth = new Date().toISOString().slice(0, 7)) {
  const safeHistory = history && typeof history === 'object' && !Array.isArray(history) ? history : {};
  const rows = Object.entries(safeHistory)
    .filter(([month, snapshot]) => /^\d{4}-\d{2}$/.test(month) && snapshot && typeof snapshot === 'object')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, snapshot]) => {
      const planTotalUSD = finiteNumber(snapshot.planTotal);
      const investedUSD = finiteNumber(snapshot.invested);
      return {
        month,
        monthlyFixedUSD: finiteNumber(snapshot.monthlyFixed),
        dividendsUSD: finiteNumber(snapshot.dividends),
        dellSaleUSD: finiteNumber(snapshot.dellSale),
        extras: Array.isArray(snapshot.extras)
          ? snapshot.extras.map((extra) => ({
              name: typeof extra?.name === 'string' ? extra.name : '',
              amountUSD: finiteNumber(extra?.amount),
            }))
          : [],
        planTotalUSD,
        investedUSD,
        remainingUSD: planTotalUSD == null || investedUSD == null
          ? null
          : Math.max(0, planTotalUSD - investedUSD),
        savedAt: typeof snapshot.savedAt === 'string' ? snapshot.savedAt : null,
      };
    });
  const current = rows.find((row) => row.month === currentMonth) || null;
  return {
    currentCapacityUSD: current?.planTotalUSD ?? null,
    currentRemainingUSD: current?.remainingUSD ?? null,
    history: rows,
  };
}

export function buildPortfolioSummary({ holdings, savedAt = null, contributionHistory = {}, currentMonth } = {}) {
  const safeHoldings = Array.isArray(holdings) ? holdings.filter((h) => h && typeof h === 'object') : [];
  const projected = safeHoldings.map((holding) => {
    const valueUSD = holdingValueUSD(holding);
    const currency = holding.manualCurrency === 'BRL' ? 'BRL' : 'USD';
    return {
      ticker: String(holding.ticker || holding.name || '').toUpperCase(),
      name: String(holding.name || holding.ticker || ''),
      assetClass: String(holding.assetClass || 'Uncategorized'),
      qty: finiteNumber(holding.qty),
      price: nativePrice(holding),
      valueUSD: round(valueUSD),
      currency,
      nativeValue: holding.type === 'manual' && holding.manualMode === 'value'
        ? finiteNumber(holding.manualValue)
        : null,
      targetPct: finiteNumber(holding.target),
    };
  });

  const unvalued = projected.filter((holding) => holding.valueUSD == null);
  const totalValueUSD = projected.reduce((sum, holding) => sum + (holding.valueUSD ?? 0), 0);
  const classMap = new Map();
  for (const holding of projected) {
    const current = classMap.get(holding.assetClass) || { currentValueUSD: 0, targetPct: 0, hasUnvaluedHoldings: false };
    if (holding.valueUSD == null) current.hasUnvaluedHoldings = true;
    else current.currentValueUSD += holding.valueUSD;
    if (holding.targetPct != null && holding.targetPct > 0) current.targetPct += holding.targetPct;
    classMap.set(holding.assetClass, current);
  }

  const assetClasses = [...classMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => {
    const currentPct = totalValueUSD > 0 ? (item.currentValueUSD / totalValueUSD) * 100 : 0;
    const targetValueUSD = totalValueUSD * (item.targetPct / 100);
    return {
      name,
      currentValueUSD: round(item.currentValueUSD),
      currentPct: round(currentPct),
      targetPct: round(item.targetPct),
      driftPctPoints: round(currentPct - item.targetPct),
      targetValueUSD: round(targetValueUSD),
      // Positive means under target; negative means over target.
      underOverTargetUSD: round(targetValueUSD - item.currentValueUSD),
      hasUnvaluedHoldings: item.hasUnvaluedHoldings,
    };
  });

  const valueForClass = (name) => assetClasses.find((item) => item.name === name)?.currentValueUSD ?? 0;
  return {
    asOf: savedAt,
    portfolio: {
      totalValueUSD: round(totalValueUSD),
      cashUSD: round(valueForClass('Cash')),
      valuationComplete: unvalued.length === 0,
      unvaluedHoldings: unvalued.map(({ ticker, assetClass, currency, nativeValue }) => ({ ticker, assetClass, currency, nativeValue })),
    },
    assetClasses,
    holdings: projected,
    contributions: contributionProjection(contributionHistory, currentMonth),
  };
}
