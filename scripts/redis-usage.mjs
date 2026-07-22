// scripts/redis-usage.mjs
//
// Read-only diagnostic: reports Redis memory usage grouped by key category,
// so a "dataset near plan limit" alert can be root-caused before optimizing
// blind. Never writes or deletes anything.
//
// Usage:
//   REDIS_URL="<aa-findocs REDIS_URL from Vercel>" node scripts/redis-usage.mjs
//
// Pull the URL with `vercel env pull` (or copy it from the Vercel project's
// Storage tab) — this script does not read .env files.

import Redis from 'ioredis';

const url = process.env.REDIS_URL;
if (!url) {
  console.error('Set REDIS_URL before running this script.');
  process.exit(1);
}

const redis = new Redis(url, { maxRetriesPerRequest: 3, connectTimeout: 10000 });

// Order matters: first matching pattern wins. Mirrors the key shapes used
// across api/*.js and lib/auth.js.
const CATEGORIES = [
  { name: 'holdings', re: /^portfolio:(email|pwd):[^:]+:holdings$/ },
  { name: 'transactions', re: /^portfolio:(email|pwd):[^:]+:transactions$/ },
  { name: 'perf-history cache (per-user, TTL)', re: /^portfolio:(email|pwd):[^:]+:perf-history:/ },
  { name: 'dividends cache (per-user, TTL)', re: /^portfolio:(email|pwd):[^:]+:dividends:/ },
  { name: 'contributions-history', re: /^portfolio:(email|pwd):[^:]+:contributions-history$/ },
  { name: 'networth-history', re: /^portfolio:(email|pwd):[^:]+:networth-history$/ },
  { name: 'alerts-read', re: /^portfolio:(email|pwd):[^:]+:alerts-read$/ },
  { name: 'fidelity-pending (SimpleFin staging)', re: /^portfolio:(email|pwd):[^:]+:fidelity-pending$/ },
  { name: 'quote cache (global, 60s TTL)', re: /^portfolio:quotecache:/ },
  { name: 'allowlist', re: /^portfolio:allowlist$/ },
  { name: 'dividends paydates (global, 7d TTL)', re: /^dividends:paydates:/ },
  { name: 'events cache (global, TTL)', re: /^events:/ },
  { name: 'splitdetect cache (global, TTL)', re: /^splitdetect:/ },
];

function categorize(key) {
  for (const c of CATEGORIES) {
    if (c.re.test(key)) return c.name;
  }
  return 'uncategorized: ' + key;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function main() {
  const stats = new Map(); // category -> { bytes, count, noTtlCount, noTtlBytes, keys: [{key, bytes, ttl}] }
  let cursor = '0';
  let scanned = 0;

  do {
    const [next, keys] = await redis.scan(cursor, 'COUNT', 500);
    cursor = next;
    for (const key of keys) {
      scanned++;
      const [bytes, ttl] = await Promise.all([
        redis.memory('USAGE', key).catch(() => 0),
        redis.ttl(key).catch(() => -1),
      ]);
      const size = bytes || 0;
      const cat = categorize(key);
      if (!stats.has(cat)) {
        stats.set(cat, { bytes: 0, count: 0, noTtlCount: 0, noTtlBytes: 0, top: [] });
      }
      const s = stats.get(cat);
      s.bytes += size;
      s.count += 1;
      if (ttl === -1) {
        s.noTtlCount += 1;
        s.noTtlBytes += size;
      }
      s.top.push({ key, bytes: size, ttl });
    }
  } while (cursor !== '0');

  const rows = [...stats.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
  let total = 0;
  for (const [, s] of rows) total += s.bytes;

  console.log(`\nScanned ${scanned} keys, ${fmtBytes(total)} total (approximate, per-key MEMORY USAGE overhead included)\n`);
  console.log('Category'.padEnd(42), 'Total'.padStart(10), 'Keys'.padStart(7), 'No-TTL keys'.padStart(13), 'No-TTL bytes'.padStart(14));
  console.log('-'.repeat(90));
  for (const [name, s] of rows) {
    console.log(
      name.padEnd(42),
      fmtBytes(s.bytes).padStart(10),
      String(s.count).padStart(7),
      String(s.noTtlCount).padStart(13),
      fmtBytes(s.noTtlBytes).padStart(14)
    );
  }

  console.log('\nTop 15 individual keys by size:\n');
  const allKeys = rows.flatMap(([, s]) => s.top).sort((a, b) => b.bytes - a.bytes).slice(0, 15);
  for (const k of allKeys) {
    const ttlLabel = k.ttl === -1 ? 'no TTL' : `${k.ttl}s TTL`;
    console.log(`  ${fmtBytes(k.bytes).padStart(10)}  ${ttlLabel.padStart(10)}  ${k.key}`);
  }

  redis.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
