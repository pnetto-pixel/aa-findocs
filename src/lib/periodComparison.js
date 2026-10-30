// Match calendar month/day within the reference period; clamp month ends
// (including Feb 29) instead of overflowing into the next month.
export function shiftCalendarMonths(date, months) {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1;
  const day = Number(date.slice(8, 10));
  const first = new Date(Date.UTC(year, month + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, lastDay));
  return first.toISOString().slice(0, 10);
}

export function periodStart(date, months) {
  const month = Number(date.slice(5, 7)) - 1;
  return `${date.slice(0, 4)}-${String(Math.floor(month / months) * months + 1).padStart(2, "0")}-01`;
}
