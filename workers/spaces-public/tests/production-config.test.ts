import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const expectedRoutes = [
  'https://humaninformationinterface.com/spaces',
  'https://humaninformationinterface.com/spaces/*',
  'https://humaninformationinterface.com/new',
  'https://humaninformationinterface.com/new/',
  'https://humaninformationinterface.com/s/*'
];

test('production config owns only reviewed HTTPS routes without preview or bindings', async () => {
  const source = await readFile(new URL('../wrangler.production.jsonc', import.meta.url), 'utf8');
  const config = JSON.parse(source) as Record<string, unknown>;
  assert.equal(config.name, 'hii-spaces-public');
  assert.equal(config.main, 'src/production.ts');
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, expectedRoutes);
  for (const binding of ['vars', 'kv_namespaces', 'r2_buckets', 'd1_databases', 'durable_objects', 'services']) {
    assert.equal(binding in config, false, `unexpected privileged binding: ${binding}`);
  }
});
