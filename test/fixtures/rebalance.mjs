// All fixture values are invented. D is the projected Ex-DELL denominator.
export function fixture({ D = 100000, dell = 90000, budget, cashGap = -budget, assets }) {
  const missing = -cashGap - assets.reduce((sum, [, , gap]) => sum + gap, 0);
  const rows = missing ? [...assets, ["LOCKED", "Other", missing, 100, true]] : assets;
  const target = (D - 10000) / rows.length;
  const holdingTarget = target / D * 70;
  const holdings = rows.map(([ticker, assetClass, gap, price]) => price == null
    ? { id: ticker, ticker, assetClass, target: holdingTarget, type: "manual", manualMode: "value", manualValue: target - gap }
    : { id: ticker, ticker, assetClass, target: holdingTarget, type: "auto", price, qty: (target - gap) / price });
  holdings.push({ id: "cash-permanent", ticker: "CASH", name: "Cash Account", assetClass: "Cash",
    target: 10000 / D * 70, type: "manual", manualMode: "value", manualValue: 10000 - cashGap });
  holdings.push({ id: "dell", ticker: " dell ", assetClass: "Stocks", target: 30, type: "auto", price: 100, qty: dell / 100 });
  return { holdings, settings: { budgetCents: budget * 100, fundingSource: "cash",
    excludeTickers: rows.filter(row => row[4]).map(row => row[0]) } };
}

export const referenceCases = {
  diversification: { budget: 600, assets: [["A", "Stocks", 1200, 100], ["B", "Stocks", 400, 100], ["C", "Stocks", 400, 100], ["D", "Stocks", 400, 100]] },
  overshoot: { budget: 2000, assets: [["A", "Stocks", 330, 700], ["B", "Stocks", 370, 110, true], ["F", "Bank Bonds", 1300, null]] },
  cashWeight: { budget: 2000, assets: [["A", "Stocks", 40, 250], ["B", "Stocks", -40, 110, true], ["F", "Bank Bonds", 1700, null]] },
  shareTrap: { budget: 1000, assets: [["A", "Stocks", 1200, 600], ["B", "Stocks", 1000, 500]] },
  cashReserve: { budget: 1000, cashGap: 100, assets: [["A", "Stocks", 1000, 100], ["B", "Stocks", -1400, 200]] },
  breadth: { budget: 1750, cashGap: -1300, assets: [["A", "Stocks", 600, 220], ["B", "Stocks", 240, 175], ["C", "Bonds", 570, 330], ["D", "Bonds", 530, 135], ["E", "Alternative", 660, 545]] },
};

export function largeFixture({ size, D, dell, budget, seed = size }) {
  const classes = ["Stocks", "Bonds", "Real Estate", "BRA Stocks", "Alternative"];
  const prices = [27.87, 49.03, 71.80, 111, 150.45, 210.11, 375.20, 585.09, 950, 1060, 1139.98];
  let x = seed;
  const random = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296);
  const assets = Array.from({ length: size - 3 }, (_, i) => [`S${String(i).padStart(2, "0")}`,
    classes[i % classes.length], Math.round(4000 * random() - 1200),
    prices[Math.floor(random() * prices.length)], i % 13 === 0]);
  const out = fixture({ D, dell, budget, assets });
  out.settings.excludeClasses = ["BRA Stocks"];
  return out;
}
