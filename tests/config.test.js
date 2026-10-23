import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAuthConfig, readDatabaseURL, readPort, readSeedConfig } from '../src/shared/config.ts';

test('authentication configuration requires a secret and a valid expiration', () => {
  for (const value of [undefined, '', 'short']) {
    assert.throws(() => readAuthConfig({ JWT_SECRET: value }));
  }
  const JWT_SECRET = 'x'.repeat(32);
  assert.equal(readAuthConfig({ JWT_SECRET }).jwtExpiresInSeconds, 3600);
  assert.equal(readAuthConfig({ JWT_SECRET, JWT_EXPIRES_IN_SECONDS: '60' }).jwtExpiresInSeconds, 60);
  for (const value of ['0', '-1', 'abc', '1.5', '86401', '']) {
    assert.throws(() => readAuthConfig({ JWT_SECRET, JWT_EXPIRES_IN_SECONDS: value }));
  }
});

test('seed configuration requires all three passwords without silently using defaults', () => {
  assert.throws(() => readSeedConfig({}));
  assert.throws(() => readSeedConfig({ SEED_AUCTIONEER_PASSWORD: 'short', SEED_BIDDER1_PASSWORD: 'x'.repeat(12), SEED_BIDDER2_PASSWORD: 'y'.repeat(12) }));
  const config = readSeedConfig({ SEED_AUCTIONEER_PASSWORD: 'a'.repeat(12), SEED_BIDDER1_PASSWORD: 'b'.repeat(12), SEED_BIDDER2_PASSWORD: 'c'.repeat(12) });
  assert.equal(config.bidder2Password, 'c'.repeat(12));
});

test('database URL and HTTP port reject invalid configuration', () => {
  assert.throws(() => readDatabaseURL({ DATABASE_URL: 'https://example.com' }));
  assert.throws(() => readDatabaseURL({}));
  assert.equal(readDatabaseURL({ DATABASE_URL: 'postgresql://localhost/test' }), 'postgresql://localhost/test');
  assert.equal(readPort({}), 3000);
  assert.throws(() => readPort({ PORT: '70000' }));
});
