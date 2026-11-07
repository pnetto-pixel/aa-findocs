// Manual planning only: transaction amounts and the previous month's plan
// must never override an explicitly saved value (including zero).
export function initialDellPlan(month, snapshot) {
  if (snapshot?.dellSaleMode === "manual" &&
      typeof snapshot.dellSale === "number" &&
      Number.isFinite(snapshot.dellSale) && snapshot.dellSale >= 0) {
    return snapshot.dellSale;
  }
  return month === "2026-11" ? 24 * 330 : 0;
}

export function validDellAmount(value) {
  return (typeof value === "string" || typeof value === "number") &&
    String(value).trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
}
