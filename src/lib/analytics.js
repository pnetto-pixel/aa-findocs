// lib/analytics.js
// Pure portfolio analytics used by the Performance tab's Risk / Monthly
// Returns / Invested-vs-Growth cards. Everything here derives from data the
// app already has (the TWR series returned by /api/perf-history and the
// transactions log) — no network, no React, no DOM. Unit-tested in
// test/analytics.test.mjs; keep it importable from Node.

// The perf-history TWR series is "% return since inception, base 0".
// wealthFromTwr converts it to a wealth index (base 1.0) so returns compound
// correctly: +10% then -10% is 0.99, not 0.
export function wealthFromTwr(portfolioPct) {
  return (portfolioPct || []).map((p) => 1 + (Number(p) || 0) / 100);
}

// Simple daily returns from a wealth index.
export function dailyReturns(wealth) {
  const out = [];
  for (let i = 1; i < wealth.length; i++) {
    if (wealth[i - 1] > 0 && isFinite(wealth[i])) {
      out.push(wealth[i] / wealth[i - 1] - 1);
    }
  }
  return out;
}

// Annualized volatility (%) from daily returns — sample stdev × √252.
export function annualizedVolatility(returns) {
  if (!returns || returns.length < 2) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance =
    returns.reduce((s, r) => s + (r - mean) * (r - mean), 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

// CAGR (%) between the first and last point of the series, annualized by
// calendar days. Requires ≥ 90 days of history — annualizing a few weeks
// produces absurd numbers.
export function cagr(dates, portfolioPct) {
  if (!dates || dates.length < 2) return null;
  const w = wealthFromTwr(portfolioPct);
  const days =
    (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 86400000;
  if (!(days >= 90) || w[0] <= 0) return null;
  const total = w[w.length - 1] / w[0];
  if (!(total > 0)) return null;
  return (Math.pow(total, 365 / days) - 1) * 100;
}

// Sharpe ratio over annualized figures. riskFreePct defaults to 0 — label it
// "rf=0" in the UI so nobody mistakes it for an excess-return Sharpe.
export function sharpeRatio(annReturnPct, annVolPct, riskFreePct = 0) {
  if (annReturnPct == null || annVolPct == null || !(annVolPct > 0)) return null;
  return (annReturnPct - riskFreePct) / annVolPct;
}

// Beta = cov(portfolio, benchmark) / var(benchmark), from paired daily returns.
export function betaVsBenchmark(portfolioReturns, benchReturns) {
  const n = Math.min(portfolioReturns?.length || 0, benchReturns?.length || 0);
  if (n < 2) return null;
  let meanP = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanP += portfolioReturns[i];
    meanB += benchReturns[i];
  }
  meanP /= n;
  meanB /= n;
  let cov = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    cov += (portfolioReturns[i] - meanP) * (benchReturns[i] - meanB);
    varB += (benchReturns[i] - meanB) * (benchReturns[i] - meanB);
  }
  if (!(varB > 0)) return null;
  return cov / varB;
}

// Underwater series: % below the running peak at each date (0 at new highs).
export function underwaterSeries(dates, portfolioPct) {
  const w = wealthFromTwr(portfolioPct);
  const out = [];
  let peak = -Infinity;
  for (let i = 0; i < w.length; i++) {
    if (w[i] > peak) peak = w[i];
    out.push({ date: dates[i], dd: peak > 0 ? (w[i] / peak - 1) * 100 : 0 });
  }
  return out;
}

// Deepest drawdown with its peak → trough dates.
// Returns { ddPct (≤ 0), peakDate, troughDate } or null.
export function maxDrawdown(dates, portfolioPct) {
  const w = wealthFromTwr(portfolioPct);
  if (w.length < 2) return null;
  let peak = w[0];
  let peakDate = dates[0];
  let best = { ddPct: 0, peakDate: dates[0], troughDate: dates[0] };
  for (let i = 1; i < w.length; i++) {
    if (w[i] > peak) {
      peak = w[i];
      peakDate = dates[i];
      continue;
    }
    const dd = peak > 0 ? (w[i] / peak - 1) * 100 : 0;
    if (dd < best.ddPct) {
      best = { ddPct: dd, peakDate, troughDate: dates[i] };
    }
  }
  return best;
}

// Month-by-month returns from the TWR series (fund-factsheet style).
// A month's return = wealth at its last data point / wealth at the previous
// month's last data point. The first month is measured from inception (may be
// partial). YTD per year compounds the months present.
// Returns { years: ["2026", "2025", ...] (desc), table: { year: { 1..12: pct|null, ytd } } }
export function monthlyReturns(dates, portfolioPct) {
  if (!dates || dates.length < 2) return { years: [], table: {} };
  const w = wealthFromTwr(portfolioPct);
  const lastByMonth = new Map(); // "YYYY-MM" → last wealth (dates are sorted asc)
  for (let i = 0; i < dates.length; i++) {
    lastByMonth.set(dates[i].slice(0, 7), w[i]);
  }
  const table = {};
  let prev = w[0];
  for (const [month, wm] of lastByMonth) {
    const year = month.slice(0, 4);
    const mi = parseInt(month.slice(5, 7), 10);
    if (!table[year]) table[year] = {};
    table[year][mi] = prev > 0 ? (wm / prev - 1) * 100 : null;
    prev = wm;
  }
  const years = Object.keys(table).sort().reverse();
  for (const y of years) {
    let acc = 1;
    let has = false;
    for (let m = 1; m <= 12; m++) {
      const r = table[y][m];
      if (r != null) {
        acc *= 1 + r / 100;
        has = true;
      }
    }
    table[y].ytd = has ? (acc - 1) * 100 : null;
  }
  return { years, table };
}

// Builds the buy/sell USD cashflows shared by investedSeries and xirr.
// resolveFxToUSD(tx) → multiplier that converts the tx's native price to USD
// (1 for USD txs); return null to skip a tx (e.g. BRL without a live FX rate).
// Sign convention here is "invested capital": buys add, sells subtract.
function usdFlows(transactions, resolveFxToUSD) {
  const flows = [];
  let skipped = 0;
  const txs = [...(transactions || [])]
    .filter((t) => t && t.date && (t.side === "buy" || t.side === "sell"))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const tx of txs) {
    const qty = Number(tx.qty) || 0;
    const price = Number(tx.price) || 0;
    const fee = Number(tx.fee) || 0;
    const fx = resolveFxToUSD ? resolveFxToUSD(tx) : 1;
    if (fx == null || !isFinite(fx) || fx <= 0) {
      skipped++;
      continue;
    }
    // Fees increase what a buy costs and reduce what a sell returns.
    const amt =
      tx.side === "buy" ? (qty * price + fee) * fx : -(qty * price - fee) * fx;
    flows.push({ date: tx.date, amt });
  }
  return { flows, skipped };
}

// Cumulative net invested capital (USD) aligned to the given date axis.
// series[i] = Σ buys − Σ sells with date ≤ dates[i].
export function investedSeries(dates, transactions, resolveFxToUSD) {
  const { flows, skipped } = usdFlows(transactions, resolveFxToUSD);
  const series = [];
  let acc = 0;
  let j = 0;
  for (const d of dates || []) {
    while (j < flows.length && flows[j].date <= d) {
      acc += flows[j].amt;
      j++;
    }
    series.push(acc);
  }
  return { series, skipped };
}

// XIRR: money-weighted annual return (%) via bracketing + bisection on the
// NPV. cashflows: [{ date: ISO, amount }] with the investor's sign convention
// (buys negative, sells/final value positive). Returns null when no root is
// bracketed (e.g. all flows same sign) or the series spans < 30 days.
export function xirr(cashflows) {
  const flows = (cashflows || [])
    .filter((c) => c && c.date && isFinite(c.amount) && c.amount !== 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (flows.length < 2) return null;
  if (!flows.some((c) => c.amount < 0) || !flows.some((c) => c.amount > 0)) return null;

  const t0 = Date.parse(flows[0].date);
  const tN = Date.parse(flows[flows.length - 1].date);
  if (!((tN - t0) / 86400000 >= 30)) return null;

  const yrs = flows.map((c) => (Date.parse(c.date) - t0) / (365.25 * 86400000));
  const npv = (r) =>
    flows.reduce((s, c, i) => s + c.amount / Math.pow(1 + r, yrs[i]), 0);

  const grid = [-0.9999, -0.99, -0.9, -0.75, -0.5, -0.25, -0.1, 0, 0.1, 0.25, 0.5, 1, 2, 5, 10, 100];
  let lo = null;
  let hi = null;
  let prevR = grid[0];
  let prevV = npv(grid[0]);
  for (let i = 1; i < grid.length; i++) {
    const v = npv(grid[i]);
    if (isFinite(prevV) && isFinite(v) && prevV * v <= 0) {
      lo = prevR;
      hi = grid[i];
      break;
    }
    prevR = grid[i];
    prevV = v;
  }
  if (lo == null) return null;

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const v = npv(mid);
    if (!isFinite(v)) return null;
    if (npv(lo) * v <= 0) hi = mid;
    else lo = mid;
    if (hi - lo < 1e-8) break;
  }
  return ((lo + hi) / 2) * 100;
}

// Investor-sign cashflows for xirr from the transactions log + the portfolio's
// current value: buys are money in (negative), sells money out (positive),
// plus the final value as a terminal positive flow.
export function xirrFromTransactions(transactions, resolveFxToUSD, finalValue, finalDate) {
  if (!(finalValue > 0) || !finalDate) return null;
  const { flows } = usdFlows(transactions, resolveFxToUSD);
  const cashflows = flows.map((f) => ({ date: f.date, amount: -f.amt }));
  cashflows.push({ date: finalDate, amount: finalValue });
  return xirr(cashflows);
}
