export const PREFERENCE_DEFAULTS = Object.freeze({
  allocationView: "total", grouping: "class", strategy: "standard",
  budgetMode: "current", fundingSource: "cash", standardFundingSource: "new",
  cashAccountId: null, excludeTickers: [], excludeClasses: [], washProtection: true,
  customBudget: null,
});

const choices = {
  allocationView: ["total", "ex-dell"], grouping: ["class", "holding"],
  strategy: ["standard", "dynamic"], budgetMode: ["current", "monthly", "custom", "cash"],
  fundingSource: ["cash", "new"], standardFundingSource: ["cash", "new"],
};

export function validatePreferencePatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length) return null;
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (Object.hasOwn(choices, key) && choices[key].includes(value)) result[key] = value;
    else if (key === "cashAccountId" && (value === null || (typeof value === "string" && value.trim() && value.length <= 128))) result[key] = value;
    else if (key === "washProtection" && typeof value === "boolean") result[key] = value;
    else if (key === "customBudget" && (value === null || (Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000_000))) result[key] = value;
    else if ((key === "excludeTickers" || key === "excludeClasses") && Array.isArray(value) && value.length <= 250 &&
        value.every(v => typeof v === "string" && v.trim() && v.length <= 128)) {
      result[key] = [...new Set(value.map(v => key === "excludeTickers" ? v.trim().toUpperCase() : v.trim().toLowerCase()))].sort();
    } else return null;
  }
  return result;
}

export function parseBudgetCents(input) {
  const text = String(input ?? "").trim();
  if (!/^\d+(\.\d{0,2})?$|^\.\d{1,2}$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return Number.isSafeInteger(cents) && cents <= 100_000_000_000 ? cents : null;
}

export function dollarsToBudgetCents(amount) {
  const cents = Math.floor(Number(amount) * 100 + 1e-7);
  return Number.isSafeInteger(cents) ? Math.max(0, cents) : null;
}

export function chooseBudget({ mode, source, account, contributions, customBudget }) {
  const available = account?.value == null ? null : dollarsToBudgetCents(account.value);
  if (mode === "cash" && source !== "cash") return { error: "Available Cash requires Existing Cash.", available };
  if ((mode === "current" || mode === "monthly") && !contributions) return { error: "Contribution plan is unavailable.", available };
  const cents = mode === "cash" ? available : mode === "custom" ? customBudget :
    dollarsToBudgetCents(mode === "current" ? contributions.currentRemaining : contributions.monthRemaining);
  if (cents == null) return { error: mode === "custom" ? "Enter a valid custom budget." : "Select an eligible Cash account.", available };
  if (source === "cash" && cents > 0 && (available == null || cents > available)) {
    return { error: available == null ? "Select an eligible Cash account." : "Budget exceeds the selected Cash balance.", available, requested: cents };
  }
  return { cents, available };
}
