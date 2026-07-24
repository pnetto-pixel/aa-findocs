#!/usr/bin/env node
// scripts/simplefin-dump.mjs
//
// Mesmo dump do scripts/simplefin-dump.ps1, para quem estiver num Mac/Linux (ou
// preferir Node a PowerShell). Sem dependencias: roda com o Node do proprio
// projeto, `node scripts/simplefin-dump.mjs`.
//
// Diferente do sync do app (api/fidelity-pending.js + lib/simplefin-map.js), que
// so extrai o que o portfolio precisa, este script nao interpreta nada: mostra
// todo campo que a Bridge devolve, inclusive os que o app hoje ignora.
//
// Uso:
//   SIMPLEFIN_ACCESS_URL="https://user:pass@bridge.simplefin.org/simplefin" \
//     node scripts/simplefin-dump.mjs [--days 90] [--out ./simplefin-out] [--all-orgs] [--no-csv]
//
// O filtro por org "fidelity" e o padrao e e a mesma regra mandatoria do mapper
// (isFidelityOrg): uma conexao SimpleFin devolve TODAS as instituicoes linkadas
// no Bridge, entao sem ele o dump inclui contas bancarias pessoais. --all-orgs
// desliga de proposito.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

// ------------------------------------------------------------------ args ---

function parseArgs(argv) {
  const out = { days: 90, outDir: "./simplefin-out", allOrgs: false, csv: true, accessUrl: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") out.days = parseInt(argv[++i], 10);
    else if (a === "--out") out.outDir = argv[++i];
    else if (a === "--all-orgs") out.allOrgs = true;
    else if (a === "--no-csv") out.csv = false;
    else if (a === "--url") out.accessUrl = argv[++i];
    else if (a === "-h" || a === "--help") out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
node scripts/simplefin-dump.mjs [opcoes]

  --url <accessUrl>   SimpleFin access URL (default: $SIMPLEFIN_ACCESS_URL, ou pergunta)
  --days <n>          janela de transacoes, max 90 (default 90)
  --out <dir>         pasta de saida (default ./simplefin-out)
  --all-orgs          nao filtra por Fidelity (inclui contas bancarias pessoais)
  --no-csv            so imprime no console, nao escreve arquivos
`);
  process.exit(0);
}

// --------------------------------------------------------------- helpers ---

// A Bridge mistura convencoes: snake_case nos holdings (market_value), kebab
// na conta (available-balance). Le aceitando as duas.
function prop(obj, ...names) {
  if (!obj) return undefined;
  for (const n of names) {
    const v = obj[n];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function ts(v) {
  const n = num(v);
  if (n === null) return v === undefined ? "" : String(v ?? "");
  return new Date(n * 1000).toISOString().slice(0, 16).replace("T", " ");
}

function money(v) {
  return v === null || v === undefined ? "" : Number(v).toFixed(2);
}

// Tabela ASCII simples — evita dependencia so pra formatar saida.
function table(rows, columns) {
  if (!rows.length) return "  (vazio)";
  const cols = columns || Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length))
  );
  const line = (cells) => "  " + cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ");
  return [line(cols), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(cols.map((c) => r[c])))].join("\n");
}

function section(title) {
  console.log("\n" + "=".repeat(78));
  console.log("  " + title);
  console.log("=".repeat(78));
}

function toCsv(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

// Toda chave distinta vista numa colecao, com quantos itens vieram preenchidos.
// E como se descobre campo novo que a Bridge passou a mandar e o app nao le.
function keyInventory(items, level) {
  const counts = new Map();
  let total = 0;
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    total++;
    for (const [k, v] of Object.entries(it)) {
      if (!counts.has(k)) counts.set(k, 0);
      if (v !== null && v !== undefined && v !== "") counts.set(k, counts.get(k) + 1);
    }
  }
  return [...counts.keys()].sort().map((k) => ({ Level: level, Field: k, Filled: counts.get(k), OfTotal: total }));
}

// ----------------------------------------------------------------- input ---

let accessUrl = args.accessUrl || process.env.SIMPLEFIN_ACCESS_URL;
if (!accessUrl) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  accessUrl = (await rl.question("Cole o SimpleFin access URL (mesmo valor da env SIMPLEFIN_ACCESS_URL no Vercel): ")).trim();
  rl.close();
}
accessUrl = String(accessUrl || "").trim().replace(/^["']|["']$/g, "");
if (!accessUrl) {
  console.error("Access URL vazio.");
  process.exit(1);
}

// O access URL carrega Basic Auth no userinfo; nem todo fetch repassa userinfo
// sozinho, entao extraimos e mandamos header explicito contra a URL limpa
// (mesma abordagem de parseSimplefinUrl em api/fidelity-pending.js).
let baseUrl, authHeader;
try {
  const u = new URL(accessUrl);
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  if (!user || !pass) throw new Error("sem usuario:senha embutidos — confira se copiou o valor completo");
  u.username = "";
  u.password = "";
  baseUrl = u.toString().replace(/\/+$/, "");
  authHeader = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
} catch (err) {
  console.error(`Access URL malformado: ${err.message}`);
  process.exit(1);
}

let days = Number.isFinite(args.days) ? args.days : 90;
if (days < 1) days = 1;
if (days > 90) {
  console.log(`A Bridge trava em 90 dias; reduzindo ${days} -> 90.`);
  days = 90;
}

const startDate = Math.floor((Date.now() - days * 86400 * 1000) / 1000);
// pending=1 pede transacoes ainda nao liquidadas (o app nao usa; aqui queremos tudo).
const requestUrl = `${baseUrl}/accounts?start-date=${startDate}&pending=1`;

console.log(`\nGET ${baseUrl}/accounts  (janela: ${days} dias, desde ${new Date(startDate * 1000).toISOString().slice(0, 10)})`);

// ----------------------------------------------------------------- fetch ---

const res = await fetch(requestUrl, { headers: { Authorization: authHeader } });
if (!res.ok) {
  console.error(
    res.status === 403
      ? "SimpleFin devolveu HTTP 403 — access URL invalido ou revogado."
      : `SimpleFin devolveu HTTP ${res.status}.`
  );
  process.exit(1);
}
const rawJson = await res.text();
const payload = JSON.parse(rawJson);

const allAccounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
const accounts = args.allOrgs
  ? allAccounts
  : allAccounts.filter((a) => `${a?.org?.name || ""} ${a?.org?.domain || ""}`.toLowerCase().includes("fidelity"));

console.log(
  `Contas no payload: ${allAccounts.length}   |   apos filtro: ${accounts.length}` +
    (args.allOrgs ? " (sem filtro, --all-orgs)" : " (so Fidelity)")
);

const errors = Array.isArray(payload?.errors) ? payload.errors : [];
if (errors.length) {
  console.log("\nAvisos/erros retornados pela Bridge (payload.errors):");
  errors.forEach((e) => console.log(`  - ${e}`));
}

if (!accounts.length) {
  console.log("\nNenhuma conta Fidelity encontrada. Rode com --all-orgs pra ver que instituicoes vieram.");
  if (!args.allOrgs && allAccounts.length) {
    console.log(table(allAccounts.map((a) => ({ Org: a?.org?.name ?? "", Domain: a?.org?.domain ?? "", Account: a?.name ?? "" }))));
  }
  process.exit(0);
}

// ---------------------------------------------------- montagem das linhas ---

const accountRows = [];
const holdingRows = [];
const transactionRows = [];
const rawHoldings = [];
const rawTransactions = [];

for (const a of accounts) {
  const holdings = Array.isArray(a.holdings) ? a.holdings : [];
  const txs = Array.isArray(a.transactions) ? a.transactions : [];
  rawHoldings.push(...holdings);
  rawTransactions.push(...txs);

  accountRows.push({
    Org: a?.org?.name ?? "",
    OrgDomain: a?.org?.domain ?? "",
    AccountId: a?.id ?? "",
    Account: a?.name ?? "",
    Currency: a?.currency ?? "",
    Balance: money(num(a?.balance)),
    AvailableBalance: money(num(prop(a, "available-balance", "available_balance"))),
    BalanceDate: ts(prop(a, "balance-date", "balance_date")),
    Holdings: holdings.length,
    Transactions: txs.length,
  });

  for (const h of holdings) {
    if (!h) continue;
    const shares = num(h.shares);
    const marketValue = num(prop(h, "market_value", "market-value"));
    const costBasis = num(prop(h, "cost_basis", "cost-basis"));
    const purchasePrice = num(prop(h, "purchase_price", "purchase-price"));
    const symbol = String(h.symbol ?? "").trim();
    const description = String(h.description ?? "").trim();

    // Mesma classificacao que lib/simplefin-map.js usa: holdings sem symbol sao
    // bank bonds/CDs, EXCETO a linha sintetica "CASH" (que tambem vem sem
    // symbol e representa o cash sweep).
    const kind = symbol ? "stock/etf" : description.toUpperCase() === "CASH" ? "cash (sintetico)" : "bank bond/CD";

    // cost_basis as vezes vem total, as vezes ausente; purchase_price e por
    // unidade. Derivar o custo total ajuda a comparar com market_value.
    const totalCost =
      costBasis !== null ? costBasis : purchasePrice !== null && shares !== null ? purchasePrice * shares : null;
    const gain = marketValue !== null && totalCost !== null ? marketValue - totalCost : null;

    holdingRows.push({
      Account: a?.name ?? "",
      Kind: kind,
      Symbol: symbol,
      Description: description,
      Shares: shares === null ? "" : String(shares),
      MarketValue: money(marketValue),
      PurchasePrice: money(purchasePrice),
      CostBasis: money(costBasis),
      TotalCost: money(totalCost),
      GainLoss: money(gain),
      Currency: h.currency ?? "",
      HoldingId: h.id ?? "",
      Created: ts(h.created),
    });
  }

  for (const t of txs) {
    if (!t) continue;
    transactionRows.push({
      Account: a?.name ?? "",
      Posted: ts(t.posted),
      TransactedAt: ts(prop(t, "transacted_at", "transacted-at")),
      Amount: money(num(t.amount)),
      Description: String(t.description ?? "").trim(),
      Payee: t.payee ?? "",
      Memo: t.memo ?? "",
      Pending: t.pending === undefined ? "" : String(t.pending),
      TransactionId: t.id ?? "",
    });
  }
}

transactionRows.sort((x, y) => String(y.Posted).localeCompare(String(x.Posted)));
holdingRows.sort((x, y) => x.Kind.localeCompare(y.Kind) || parseFloat(y.MarketValue || 0) - parseFloat(x.MarketValue || 0));

// --------------------------------------------------------------- console ---

section("CONTAS");
console.log(table(accountRows));

section(`HOLDINGS (${holdingRows.length})`);
console.log(table(holdingRows, ["Kind", "Symbol", "Description", "Shares", "MarketValue", "PurchasePrice", "TotalCost", "GainLoss"]));

const byKind = new Map();
for (const h of holdingRows) {
  const cur = byKind.get(h.Kind) || { Kind: h.Kind, Positions: 0, MarketValue: 0 };
  cur.Positions++;
  cur.MarketValue += parseFloat(h.MarketValue || 0) || 0;
  byKind.set(h.Kind, cur);
}
console.log("\n  Totais por tipo:");
console.log(table([...byKind.values()].map((r) => ({ ...r, MarketValue: r.MarketValue.toFixed(2) }))));

section(`TRANSACOES (${transactionRows.length}, ultimos ${days} dias)`);
console.log(table(transactionRows, ["Posted", "Amount", "Description", "Pending"]));

section("CAMPOS DISPONIVEIS NO PAYLOAD");
console.log("  Todas as chaves que a Bridge retornou, com quantos itens vieram preenchidos.");
console.log("  Chave que aparece aqui e nao aparece nas tabelas acima = dado que o app ainda nao le.\n");
const inventory = [
  ...keyInventory(accounts, "account"),
  ...keyInventory(rawHoldings, "holding"),
  ...keyInventory(rawTransactions, "transaction"),
];
console.log(table(inventory));

// -------------------------------------------------------------- arquivos ---

if (args.csv) {
  fs.mkdirSync(args.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const write = (name, content) => {
    const p = path.join(args.outDir, name);
    fs.writeFileSync(p, content, "utf8");
    return p;
  };

  // Reserializa so o subconjunto filtrado, senao o arquivo bruto carrega as
  // contas bancarias pessoais que o filtro Fidelity acabou de excluir.
  const rawOut = args.allOrgs ? rawJson : JSON.stringify({ errors, accounts }, null, 2);

  const written = [
    write(`simplefin-raw-${stamp}.json`, rawOut),
    write(`accounts-${stamp}.csv`, toCsv(accountRows)),
    write(`holdings-${stamp}.csv`, toCsv(holdingRows)),
    write(`transactions-${stamp}.csv`, toCsv(transactionRows)),
    write(`fields-${stamp}.csv`, toCsv(inventory)),
  ];

  section("ARQUIVOS GERADOS");
  written.forEach((p) => console.log("  " + p));
  console.log("\n  Os CSVs abrem direto no Excel/Numbers. O JSON bruto tem tudo, sem perda.");
  console.log("  Atencao: esses arquivos tem dados financeiros reais — nao commitar.");
}
