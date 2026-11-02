// Broker credits are authoritative. Reconcile only equal-value API payments
// across a month boundary and within three calendar days (weekend posting).
// Keep distinct amounts/payments and never delete stored income records.
const day = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0,10) === value ? time / 86400000 : NaN;
};
const ticker = event => String(event.ticker || '').trim().toUpperCase();
export function reconcileDividendPayments(events) {
  const credits = new Map();
  for (const e of events) {
    if (e.source !== 'fidelity' || e.incomeType !== 'dividend' || !ticker(e) || !Number.isFinite(day(e.date)) || !Number.isFinite(e.totalReceived) || e.totalReceived <= 0) continue;
    const key = `${ticker(e)}|${e.date}`;
    const credit = credits.get(key) || { ticker: ticker(e), date: e.date, cents: 0 };
    credit.cents += Math.round(e.totalReceived * 100);
    credits.set(key, credit);
  }
  const pairs = [];
  events.forEach((e,index) => {
    if (e.source !== 'api' || e.incomeType !== 'dividend' || !Number.isFinite(day(e.date)) || !Number.isFinite(e.totalReceived) || e.totalReceived <= 0) return;
    for (const [key,credit] of credits) {
      if (ticker(e) !== credit.ticker || e.date?.slice(0,7) === credit.date.slice(0,7)) continue;
      const gap = Math.abs(day(e.date) - day(credit.date));
      const cents = Math.abs(Math.round(e.totalReceived * 100) - credit.cents);
      if (gap <= 3 && cents <= 1) pairs.push({ index, key, gap, cents });
    }
  });
  pairs.sort((a,b) => a.gap - b.gap || a.cents - b.cents || a.index - b.index || a.key.localeCompare(b.key));
  const removed = new Set(), consumed = new Set();
  for (const pair of pairs) {
    if (removed.has(pair.index) || consumed.has(pair.key)) continue;
    removed.add(pair.index); consumed.add(pair.key);
  }
  return { events: events.filter((_,index) => !removed.has(index)), matchedCount: removed.size };
}
