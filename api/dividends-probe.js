// api/dividends-probe.js
//
// TEMPORARY diagnostic endpoint. Validates dividend-data availability before
// building the Dividends tab. Open in a browser (GET) — no auth required, it
// only reads public market data and never touches portfolio storage.
//
//   /api/dividends-probe                         -> default ticker set
//   /api/dividends-probe?b3=BBSE3,MXRF11&us=AAPL,VNQ
//
// What it checks:
//   * brapi  /api/quote/{t}?dividends=true  -> does the FREE-tier BRAPI_API_KEY
//     return dividendsData.cashDividends for YOUR tickers (not just the 4 free
//     test stocks)? VALE3 is included as a known-good control.
//   * Yahoo  /v8/finance/chart/{t}?events=div -> confirms the keyless US path
//     (same host already used by perf-history.js).
//
// DELETE this file once the Dividends data source is locked in.

const TIMEOUT_MS = 12000;

async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function redactToken(str) {
  return String(str).replace(/token=[^&\s]+/gi, 'token=***');
}

// brapi: one ticker, dividends=true. Reports whether cashDividends came back.
async function probeBrapi(ticker, token) {
  const url =
    `https://brapi.dev/api/quote/${encodeURIComponent(ticker)}` +
    `?range=1y&interval=1d&dividends=true&token=${encodeURIComponent(token)}`;
  const out = { ticker, source: 'brapi', ok: false, http: null };
  try {
    const r = await fetchWithTimeout(url);
    out.http = r.status;
    const body = await r.text();
    if (!r.ok) {
      out.error = redactToken(body.slice(0, 240));
      return out;
    }
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      out.error = 'non-JSON response';
      return out;
    }
    const result = Array.isArray(data?.results) ? data.results[0] : null;
    const cash = result?.dividendsData?.cashDividends;
    out.ok = Array.isArray(cash) && cash.length > 0;
    out.count = Array.isArray(cash) ? cash.length : 0;
    if (out.count > 0) {
      const sorted = [...cash].sort((a, b) =>
        String(b.paymentDate || '').localeCompare(String(a.paymentDate || ''))
      );
      // distinct payment types present (Dividendo / JCP / Rendimento...)
      out.types = [...new Set(cash.map((c) => c.label || c.type).filter(Boolean))];
      out.latest = sorted.slice(0, 3).map((c) => ({
        paymentDate: c.paymentDate,
        rate: c.rate ?? c.value,
        type: c.label || c.type,
      }));
    } else {
      // surface why it's empty: missing key, empty array, or module absent
      out.note = result
        ? (result.dividendsData ? 'dividendsData present but cashDividends empty' : 'no dividendsData in response')
        : 'no results in response';
    }
    return out;
  } catch (e) {
    out.error = `${e?.name || 'Error'}: ${e?.message || 'network error'}`;
    return out;
  }
}

// Yahoo: dividend events from the chart endpoint. Keyless, needs User-Agent.
async function probeYahoo(ticker) {
  const url =
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?range=2y&interval=1d&events=div`;
  const out = { ticker, source: 'yahoo', ok: false, http: null };
  try {
    const r = await fetchWithTimeout(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    out.http = r.status;
    if (!r.ok) {
      out.error = (await r.text().catch(() => '')).slice(0, 200);
      return out;
    }
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    const divs = result?.events?.dividends || {};
    const entries = Object.values(divs);
    out.ok = entries.length > 0;
    out.count = entries.length;
    if (entries.length > 0) {
      out.latest = entries
        .sort((a, b) => b.date - a.date)
        .slice(0, 3)
        .map((d) => ({
          date: new Date(d.date * 1000).toISOString().slice(0, 10),
          amount: d.amount,
        }));
    }
    return out;
  } catch (e) {
    out.error = `${e?.name || 'Error'}: ${e?.message || 'network error'}`;
    return out;
  }
}

export default async function handler(req, res) {
  const token = process.env.BRAPI_API_KEY;

  const b3List = String(req.query?.b3 || 'BBSE3,ITSA3,BBAS3,VALE3')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const usList = String(req.query?.us || 'AAPL,VNQ,O')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

  const brapi = token
    ? await Promise.all(b3List.map((t) => probeBrapi(t, token)))
    : [{ error: 'BRAPI_API_KEY not configured in env' }];
  const yahoo = await Promise.all(usList.map((t) => probeYahoo(t)));

  // Verdict: VALE3 is a known free-tier stock; if it works but your real
  // tickers don't, dividends history is gated behind a paid brapi plan.
  const control = brapi.find((r) => r.ticker === 'VALE3');
  const nonControl = brapi.filter((r) => r.ticker && r.ticker !== 'VALE3');
  const realTickersWork = nonControl.some((r) => r.ok);
  let brapiVerdict;
  if (!token) brapiVerdict = 'BRAPI_API_KEY missing';
  else if (realTickersWork) brapiVerdict = 'OK — free tier returns dividends for your tickers';
  else if (control?.ok) brapiVerdict = 'PAYWALLED — control (VALE3) works but your tickers return nothing -> needs paid plan';
  else brapiVerdict = 'NO DATA — even control failed; check key/network';

  res.status(200).json({
    note: 'Temporary dividend-source probe. Delete api/dividends-probe.js after review.',
    brapiKeyPresent: Boolean(token),
    verdict: {
      brapi: brapiVerdict,
      yahoo: yahoo.some((r) => r.ok) ? 'OK — keyless US dividends available' : 'FAILED — Yahoo returned no dividends',
    },
    brapi,
    yahoo,
  });
}
