// The main ticker filter can exclude Dell too. Other cards retain their own
// independent filters, but this exclusion always takes precedence.
export function isDellExcluded(includeDell, tickerFilter) {
  return !includeDell || (tickerFilter.size > 0 && !tickerFilter.has("DELL"));
}

export function includesPerformanceTicker(ticker, dellExcluded) {
  return !dellExcluded || String(ticker || "").trim().toUpperCase() !== "DELL";
}
