import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('Vercel Hobby deployment stays within the 12-function limit', async () => {
  const apiFiles = (await readdir(resolve(repoRoot, 'api')))
    .filter((name) => name.endsWith('.js'));
  assert.ok(apiFiles.length <= 12, `found ${apiFiles.length} Serverless Functions`);
});

test('/api/mcp is rewritten to the consolidated protected portfolio function', async () => {
  const config = JSON.parse(await readFile(resolve(repoRoot, 'vercel.json'), 'utf8'));
  assert.ok(config.rewrites?.some((rewrite) => (
    rewrite.source === '/api/mcp'
    && rewrite.destination === '/api/portfolio-summary?resource=mcp'
  )));
});
