import { shiftCalendarMonths } from "./periodComparison.js";
import { contributionTxToUSD } from "./contributionCapacity.js";

const MONTHS_PER_PERIOD = { Month: 1, Quarter: 3, Half: 6, Year: 12 };

function monthIndex(date) {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

function monthKey(index) {
  return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}`;
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function growth(value, previous) {
  return previous > 0 ? (value / previous - 1) * 100 : null;
}

// Canonical monthly contributions, then cumulative period-ending balances.
// Display filters never reset the running balance or remove comparison bases.
// Dates choose calendar periods: a mid-month filter still includes that month.
export function buildAccumulatedInvestment(transactions, usdBrlRate, {
  groupBy = "Month", fromDate = "", toDate = "", today,
} = {}) {
  if (!validDate(today)) return [];
  const size = MONTHS_PER_PERIOD[groupBy] || 1;
  const eligible = (transactions || []).filter((tx) =>
    validDate(tx?.date) && tx.date <= today
    && (tx.ticker || "").toUpperCase() !== "DELL"
    && (tx.side === "buy" || (tx.assetClass === "Bank Bonds" && tx.side === "sell"))
    && Number.isFinite(contributionTxToUSD(tx, usdBrlRate))
    && contributionTxToUSD(tx, usdBrlRate) >= 0
  );
  const buys = eligible.filter((tx) => tx.side === "buy");
  if (!buys.length) return [];
  const first = Math.min(...buys.map((tx) => monthIndex(tx.date)));
  const last = monthIndex(today);
  const byMonth = new Map();
  for (const tx of eligible) {
    const key = tx.date.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, { ordinary: 0, bonds: 0 });
    const monthly = byMonth.get(key);
    const amount = contributionTxToUSD(tx, usdBrlRate);
    if (tx.assetClass === "Bank Bonds") monthly.bonds += tx.side === "buy" ? amount : -amount;
    else monthly.ordinary += amount;
  }
  const buckets = new Map();
  let cumulative = 0;
  for (let month = first; month <= last; month++) {
    const key = monthKey(month);
    // Same monthly bars as Contribution History: bond rollovers net within
    // the whole month, unlike Capacity's intentionally per-half rule.
    const monthly = byMonth.get(key);
    cumulative += monthly ? monthly.ordinary + Math.max(0, monthly.bonds) : 0;
    const bucket = Math.floor(month / size);
    buckets.set(bucket, { value: cumulative });
  }
  // Reference balances stop at the equivalent date, with monthly bond
  // netting recalculated only from transactions known by that cutoff.
  const balanceAt = (cutoff) => {
    const months = new Map();
    for (const tx of eligible) {
      if (tx.date > cutoff) continue;
      const key = tx.date.slice(0, 7);
      const monthly = months.get(key) || { ordinary: 0, bonds: 0 };
      const amount = contributionTxToUSD(tx, usdBrlRate);
      if (tx.assetClass === "Bank Bonds") monthly.bonds += tx.side === "buy" ? amount : -amount;
      else monthly.ordinary += amount;
      months.set(key, monthly);
    }
    return [...months.values()].reduce((total, monthly) => total + monthly.ordinary + Math.max(0, monthly.bonds), 0);
  };
  const fromBucket = validDate(fromDate) ? Math.floor(monthIndex(fromDate) / size) : -Infinity;
  const toBucket = validDate(toDate) ? Math.floor(monthIndex(toDate) / size) : Infinity;
  if (fromDate && toDate && fromDate > toDate) return [];
  return [...buckets].filter(([bucket]) => bucket >= fromBucket && bucket <= toBucket)
    .map(([bucket, { value }]) => {
      const start = bucket * size;
      const year = Math.floor(start / 12);
      const period = Math.floor((start % 12) / size) + 1;
      let label = String(year);
      if (groupBy === "Month") {
        label = new Date(Date.UTC(year, start % 12, 1)).toLocaleDateString("en-US", {
          month: "short", year: "2-digit", timeZone: "UTC",
        });
      } else if (groupBy === "Quarter") label = `Q${period} '${String(year).slice(2)}`;
      else if (groupBy === "Half") label = `H${period} '${String(year).slice(2)}`;
      const partial = bucket === Math.floor(last / size);
      return {
        key: `${groupBy}-${bucket}`, label, value, partial,
        asOf: partial ? today : new Date(Date.UTC(year, start % 12 + size, 0)).toISOString().slice(0, 10),
        yoy: growth(value, partial && size > 1
          ? balanceAt(shiftCalendarMonths(today, -12)) : buckets.get(bucket - 12 / size)?.value),
        previous: groupBy === "Year" ? null : growth(value, partial && size > 1
          ? balanceAt(shiftCalendarMonths(today, -size)) : buckets.get(bucket - 1)?.value),
      };
    });
}
