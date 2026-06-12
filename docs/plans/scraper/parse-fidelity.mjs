// parse-fidelity.mjs
//
// Node port of parseFidelityCSV from the aa-findocs app (src/Transactions.jsx).
// Input: the raw "Accounts History" CSV text downloaded from Fidelity.
// Output: { transactions, bondIncome } in the EXACT shape the app uses, ready to
// POST to /api/ingest-fidelity.
//
// Kept faithful to the app's logic on purpose (BOUGHT/SOLD/INTEREST/DIVIDEND/
// REDEMPTION, MDY dates, Bank Bonds qty÷1000 & price×10/×1000, inferAssetClass).
// If the app's parser changes, re-sync this file. Validate against a real CSV on
// the first manual run before trusting the daily output.
//
// Dep: papaparse (npm i papaparse)

import Papa from 'papaparse';
import crypto from 'crypto';

const B3_RX = /^[A-Z]{4}\d{1,2}$/;
const CUSIP_RX = /^[A-Z0-9]{9}$/;

const FIXED_INCOME_ETFS = new Set([
  'BND', 'AGG', 'SCHZ', 'IAGG', 'BNDX', 'VCIT', 'VCSH', 'LQD', 'HYG',
  'TLT', 'IEF', 'SHY', 'GOVT', 'MUB', 'VTEB', 'BSV', 'BIV', 'BLV',
  'VGSH', 'VGIT', 'VGLT', 'SPTL', 'SPIB', 'SPAB', 'FBND',
]);
const REAL_ESTATE_ETFS = new Set([
  'VNQ', 'XLRE', 'IYR', 'SCHH', 'RWR', 'USRT', 'FREL', 'REM', 'MORT', 'KBWY',
]);

function inferCurrency(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!t) return null;
  if (B3_RX.test(t)) return 'BRL';
  if (/^[A-Z]{1,5}$/.test(t)) return 'USD';
  return null;
}

function inferAssetClass(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!t) return null;
  if (FIXED_INCOME_ETFS.has(t)) return 'Bonds';
  if (REAL_ESTATE_ETFS.has(t)) return 'Real Estate';
  if (/^tesouro-/i.test(t)) return 'BRA Fixed Income';
  if (CUSIP_RX.test(t)) return 'Bank Bonds';
  const currency = inferCurrency(t);
  if (currency === 'BRL') return 'BRA Stocks';
  if (currency === 'USD') return 'Stocks';
  return null;
}

function newId() {
  return crypto.randomUUID();
}

function toISO(rawDate) {
  const mdy = String(rawDate || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!mdy) return null;
  let [, mo, d, y] = mdy;
  if (y.length === 2) y = (parseInt(y, 10) > 50 ? '19' : '20') + y;
  mo = mo.padStart(2, '0');
  d = d.padStart(2, '0');
  const yi = parseInt(y, 10), mi = parseInt(mo, 10), di = parseInt(d, 10);
  if (mi < 1 || mi > 12 || di < 1 || di > 31 || yi < 1900 || yi > 2100) return null;
  const dt = new Date(yi, mi - 1, di);
  if (dt.getFullYear() !== yi || dt.getMonth() !== mi - 1 || dt.getDate() !== di) return null;
  return `${y}-${mo}-${d}`;
}

export function parseFidelityCSV(text) {
  const result = Papa.parse(text, {
    skipEmptyLines: true,
    delimitersToGuess: [',', ';', '\t'],
  });
  if (!result.data || result.data.length === 0) {
    return { transactions: [], bondIncome: [] };
  }

  let headerIdx = -1;
  for (let i = 0; i < Math.min(8, result.data.length); i++) {
    const row = result.data[i].map((c) => String(c || '').trim().toLowerCase());
    if (row.includes('run date') && row.includes('action')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error('Fidelity header not found (expected "Run Date" + "Action")');
  }

  const header = result.data[headerIdx].map((c) => String(c || '').trim());
  const colOf = (name) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const idxDate = colOf('Run Date');
  const idxAction = colOf('Action');
  const idxSymbol = colOf('Symbol');
  const idxDesc = colOf('Symbol Description');
  const idxPrice = colOf('Price ($)');
  const idxQty = colOf('Quantity');
  const idxFees = colOf('Fees ($)');
  const idxAmount = colOf('Amount ($)');
  if (idxDate < 0 || idxAction < 0 || idxSymbol < 0 || idxPrice < 0 || idxQty < 0) {
    throw new Error('Required Fidelity columns missing');
  }

  const transactions = [];
  const bondIncome = [];

  for (let i = headerIdx + 1; i < result.data.length; i++) {
    const arr = result.data[i];
    if (!arr || arr.length === 0) continue;
    const action = String(arr[idxAction] || '').trim();
    const upper = action.toUpperCase();

    // Interest/coupon (CUSIP only) -> bondIncome kind:interest
    if (upper.includes('INTEREST') && idxAmount >= 0) {
      const iso = toISO(arr[idxDate]);
      const sym = String(arr[idxSymbol] || '').trim().toUpperCase();
      const amt = parseFloat(String(arr[idxAmount] || '').replace(/[$,\s]/g, ''));
      if (iso && sym && CUSIP_RX.test(sym) && isFinite(amt) && amt > 0) {
        bondIncome.push({ id: newId(), date: iso, ticker: sym, amount: amt, kind: 'interest', source: 'fidelity' });
      }
      continue;
    }

    // Stock dividends (non-CUSIP) -> bondIncome kind:dividend
    if ((upper.includes('DIVIDEND') || upper === 'CASH DIV') && !upper.includes('REINVEST') && idxAmount >= 0) {
      const iso = toISO(arr[idxDate]);
      const sym = String(arr[idxSymbol] || '').trim().toUpperCase();
      const amt = parseFloat(String(arr[idxAmount] || '').replace(/[$,\s]/g, ''));
      if (iso && sym && !CUSIP_RX.test(sym) && isFinite(amt) && amt > 0) {
        bondIncome.push({ id: newId(), date: iso, ticker: sym, amount: amt, kind: 'dividend', source: 'fidelity' });
      }
      continue;
    }

    let side = null;
    let isRedemption = false;
    if (upper.startsWith('YOU BOUGHT')) side = 'buy';
    else if (upper.startsWith('YOU SOLD')) side = 'sell';
    else if (upper.includes('REDEMPTION') || upper.startsWith('REDEEMED')) { side = 'sell'; isRedemption = true; }
    else continue;

    const isoDate = toISO(arr[idxDate]);
    if (!isoDate) continue;
    const symbol = String(arr[idxSymbol] || '').trim().toUpperCase();
    if (!symbol) continue;
    if (isRedemption && !CUSIP_RX.test(symbol)) continue;

    const amountAbs = idxAmount >= 0
      ? Math.abs(parseFloat(String(arr[idxAmount] || '').replace(/[$,\s]/g, '')))
      : NaN;

    let qtyRaw = parseFloat(String(arr[idxQty] || '').replace(/[,\s]/g, ''));
    if (isRedemption && (!isFinite(qtyRaw) || qtyRaw === 0) && isFinite(amountAbs) && amountAbs > 0) {
      qtyRaw = amountAbs;
    }
    if (!isFinite(qtyRaw) || qtyRaw === 0) continue;
    const qtyAbs = Math.abs(qtyRaw);

    let priceN = parseFloat(String(arr[idxPrice] || '').replace(/[$,\s]/g, ''));
    if (isRedemption && (!isFinite(priceN) || priceN <= 0)) {
      const units = qtyAbs / 1000;
      priceN = isFinite(amountAbs) && amountAbs > 0 && units > 0 ? amountAbs / units / 1000 : 1;
    }
    if (!isFinite(priceN) || priceN < 0) continue;

    let fee = 0;
    if (idxFees >= 0) {
      const fn = parseFloat(String(arr[idxFees] || '').replace(/[$,\s]/g, ''));
      if (isFinite(fn) && fn > 0) fee = fn;
    }

    const assetClass = inferAssetClass(symbol) || 'Stocks';
    const qty = assetClass === 'Bank Bonds' ? qtyAbs / 1000 : qtyAbs;
    const price = assetClass === 'Bank Bonds'
      ? (isRedemption ? priceN * 1000 : priceN * 10)
      : priceN;

    // Bond metadata (display/accrual) — mirrors the app.
    let notes = '';
    let couponRate = null, maturityDate = null, bondType = null, shortName = null, couponFreq = null;
    if (idxDesc >= 0 && assetClass === 'Bank Bonds') {
      const desc = String(arr[idxDesc] || '');
      const couponM = desc.match(/(\d+(?:\.\d+)?)%/);
      const maturityM = desc.match(/(\d{2})\/(\d{2})\/(\d{4})$/);
      if (couponM) couponRate = parseFloat(couponM[1]);
      if (maturityM) maturityDate = `${maturityM[3]}-${maturityM[1]}-${maturityM[2]}`;
      const nameEnd = desc.search(/\d+(?:\.\d+)?%/);
      if (nameEnd > 0) shortName = desc.slice(0, nameEnd).trim().replace(/\s+/g, ' ') || null;
      const u = desc.toUpperCase();
      if (u.includes('TREASURY') || u.includes('US TREAS')) bondType = 'Treasury';
      else if (u.includes('FEDERAL HOME LOAN') || u.includes('FHLB') || u.includes('FEDERAL FARM') || u.includes('FFCB') || u.includes('FNMA') || u.includes('FHLMC') || u.includes('FREDDIE') || u.includes('FANNIE')) bondType = 'Agency';
      else if (u.includes(' INC') || u.includes(' CORP') || u.includes(' LLC') || u.includes(' LTD') || u.includes(' PLC') || u.includes(' CO.')) bondType = 'Corporate';
      else bondType = 'CD';
      couponFreq = 'monthly';
      if (couponRate !== null && maturityM) notes = `${couponRate.toFixed(2)}% | ${maturityM[1]}/${maturityM[2]}/${maturityM[3]}`;
    }

    transactions.push({
      id: newId(),
      date: isoDate,
      side,
      ticker: symbol,
      assetClass,
      qty,
      price,
      currency: 'USD',
      fee,
      notes,
      ...(assetClass === 'Bank Bonds' && { couponRate, maturityDate, bondType, shortName, couponFreq }),
      ...(isRedemption && { redemption: true }),
      createdAt: new Date().toISOString(),
    });
  }

  return { transactions, bondIncome };
}
