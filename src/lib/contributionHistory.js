import { shiftCalendarMonths, periodStart } from "./periodComparison.js";
import { contributionTxToUSD } from "./contributionCapacity.js";

// Full history from first transaction, grouped by the chosen granularity.
// DELL buys are excluded (stock vesting, not real contributions).
// Bank Bonds: only net positive (buys − sells) per bucket counts — rollovers
// (redeem + recompra) do not inflate the contribution history.
// Optional fromDate/toDate ("YYYY-MM-DD") filter the date range shown.
// groupBy: "Month" | "Quarter" | "Half" | "Year"
function periodBars(transactions, usdBrlRate, groupBy, fromDate, toDate) {
  const relevant = transactions.filter((tx) => {
    if (tx.side !== "buy" && !(tx.assetClass === "Bank Bonds" && tx.side === "sell")) return false;
    if ((tx.ticker || "").toUpperCase() === "DELL") return false;
    if (!tx.date) return false;
    if (fromDate && tx.date < fromDate) return false;
    if (toDate && tx.date > toDate) return false;
    return true;
  });
  if (!relevant.length) return [];

  const byKey = {};
  const bbBuy = {}, bbSell = {};

  for (const tx of relevant) {
    const [yStr, mStr] = tx.date.slice(0, 7).split("-");
    const y = parseInt(yStr, 10);
    const m = parseInt(mStr, 10);
    let key;
    if (groupBy === "Month") {
      key = `${yStr}-${mStr}`;
    } else if (groupBy === "Quarter") {
      key = `${y}-Q${Math.ceil(m / 3)}`;
    } else if (groupBy === "Half") {
      key = `${y}-H${m <= 6 ? 1 : 2}`;
    } else {
      key = yStr;
    }

    const amount = contributionTxToUSD(tx, usdBrlRate);
    if (tx.assetClass === "Bank Bonds") {
      if (tx.side === "buy") bbBuy[key] = (bbBuy[key] || 0) + amount;
      else bbSell[key] = (bbSell[key] || 0) + amount;
    } else if (tx.side === "buy") {
      byKey[key] = (byKey[key] || 0) + amount;
    }
  }

  // Merge net Bank Bond contributions per bucket
  const allKeys = new Set([...Object.keys(byKey), ...Object.keys(bbBuy)]);
  for (const key of allKeys) {
    const net = Math.max(0, (bbBuy[key] || 0) - (bbSell[key] || 0));
    if (net > 0) byKey[key] = (byKey[key] || 0) + net;
  }

  return Object.keys(byKey)
    .sort()
    .map((key) => {
      let label;
      if (groupBy === "Month") {
        const [y, mStr] = key.split("-");
        const d = new Date(parseInt(y, 10), parseInt(mStr, 10) - 1, 1);
        label = d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
      } else if (groupBy === "Quarter") {
        const [y, q] = key.split("-");
        label = `${q} '${y.slice(2)}`;
      } else if (groupBy === "Half") {
        const [y, h] = key.split("-");
        label = `${h} '${y.slice(2)}`;
      } else {
        label = key;
      }
      return { key, label, value: byKey[key] };
    });
}


// Comparisons use exact calendar periods from the full history, even when
// display filters hide the baseline. Preserve the chart's existing amounts.
export function buildContributionHistory(transactions, usdBrlRate, groupBy, fromDate, toDate, today) {
  transactions = transactions.filter(tx => tx.date <= today);
  const full = new Map(periodBars(transactions, usdBrlRate, groupBy).map(row => [row.key, row.value]));
  const size = { Month: 1, Quarter: 3, Half: 6, Year: 12 }[groupBy];
  const indexOf = key => {
    const year = Number(key.slice(0, 4));
    const part = groupBy === "Year" ? 1 : Number(key.slice(groupBy === "Month" ? 5 : 6));
    return year * 12 / size + part - 1;
  };
  const balances = new Map([...full].map(([key, value]) => [indexOf(key), value]));
  const current = Math.floor((Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1) / size);
  const growth = (value, baseline) => baseline > 0 ? (value / baseline - 1) * 100 : null;
  return periodBars(transactions, usdBrlRate, groupBy, fromDate, toDate).map(row => {
    const index = indexOf(row.key);
    const compareToDate = index === current && size > 1;
    const referenceValue = (monthsBack) => {
      const cutoff = shiftCalendarMonths(today, -monthsBack);
      const bars = periodBars(transactions, usdBrlRate, groupBy, periodStart(cutoff, size), cutoff);
      return bars[0]?.value;
    };
    return { ...row, yoy: growth(row.value, compareToDate ? referenceValue(12) : balances.get(index - 12 / size)),
      previous: groupBy === "Year" ? null : growth(row.value, compareToDate ? referenceValue(size) : balances.get(index - 1)),
      partial: index === current };
  });
}
