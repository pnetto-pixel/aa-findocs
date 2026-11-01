import { shiftCalendarMonths, periodStart } from "./periodComparison.js";

const SIZES = { Month: 1, Quarter: 3, Half: 6, Year: 12 };
function validDate(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}
const monthIndex = date => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
const growth = (value, baseline) => baseline > 0 ? (value / baseline - 1) * 100 : null;

// Dividend/interest receipts and negative withholding events already share the
// canonical totalReceived field. Year filters hide bars, never reference data.
export function buildIncomeHistory(events, { groupBy = "Month", selectedYears = new Set(), selectedTickers = new Set(), selectedAssetClasses = new Set(), today } = {}) {
  if (!validDate(today)) return [];
  const size = SIZES[groupBy] || 1;
  const eligible = (events || []).filter(e => validDate(e?.date) && e.date <= today && Number.isFinite(e.totalReceived)
    && (!selectedTickers.size || selectedTickers.has(e.ticker))
    && (!selectedAssetClasses.size || selectedAssetClasses.has(e.assetClass)));
  const buckets = new Map();
  for (const e of eligible) {
    const index = Math.floor(monthIndex(e.date) / size);
    buckets.set(index, (buckets.get(index) || 0) + e.totalReceived);
  }
  const current = Math.floor(monthIndex(today) / size);
  const referenceToDate = monthsBack => {
    const cutoff = shiftCalendarMonths(today, -monthsBack);
    const start = periodStart(cutoff, size);
    const reference = eligible.filter(e => e.date >= start && e.date <= cutoff);
    return reference.length ? reference.reduce((sum, e) => sum + e.totalReceived, 0) : null;
  };
  return [...buckets].sort(([a], [b]) => a - b).filter(([index]) => !selectedYears.size || selectedYears.has(String(Math.floor(index * size / 12))))
    .map(([index, value]) => {
      const start = index * size;
      const year = Math.floor(start / 12);
      const part = Math.floor(start % 12 / size) + 1;
      let label = String(year), key = String(year);
      if (groupBy === "Month") {
        key = `${year}-${String(start % 12 + 1).padStart(2, "0")}`;
        label = new Date(Date.UTC(year, start % 12, 1)).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
      } else if (groupBy === "Quarter" || groupBy === "Half") {
        const prefix = groupBy === "Quarter" ? "Q" : "H";
        key = `${year}-${prefix}${part}`;
        label = `${prefix}${part} '${String(year).slice(2)}`;
      }
      // Match Contribution History: current multi-month periods compare to
      // the equivalent date, while monthly comparisons use calendar months.
      const partial = index === current;
      const toDate = partial && size > 1;
      return { key, label, value, partial,
        yoy: growth(value, toDate ? referenceToDate(12) : buckets.get(index - 12 / size)),
        previous: groupBy === "Year" ? null : growth(value, toDate ? referenceToDate(size) : buckets.get(index - 1)),
      };
    });
}
