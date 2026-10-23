import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { isolatedDatabase, seedConfig } from '../helpers/database.js';
import { mockDummyJSON, fixtures } from '../helpers/dummyjson.js';
import { serve } from '../helpers/http.js';
import { seed } from '../../src/shared/database/seed.ts';
import { createApp } from '../../src/app.ts';
import { createAuthModule } from '../../src/modules/auth/index.ts';
import { createCatalogModule } from '../../src/modules/catalog/index.ts';
import { DummyJsonProvider } from '../../src/modules/catalog/infrastructure/dummyjson-provider.ts';

let database;
let api;
let http;
let auctioneerToken;
let bidderToken;
before(async () => {
  database = await isolatedDatabase();
  await seed(database.db, seedConfig);
  api = await mockDummyJSON();
  const auth = await createAuthModule(database.db, { jwtSecret: 'catalog-test-secret-with-more-than-32-bytes', jwtExpiresInSeconds: 900 });
  const catalog = createCatalogModule(database.db, auth.authenticate, new DummyJsonProvider({ baseURL: api.url, timeoutMs: 500 }));
  http = await serve(createApp(auth.router, catalog));
  async function login(email, password) {
    const response = await fetch(`${http.url}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    assert.equal(response.status, 200);
    return (await response.json()).accessToken;
  }
  auctioneerToken = await login('auctioneer@verzel.local', seedConfig.auctioneerPassword);
  bidderToken = await login('bidder1@verzel.local', seedConfig.bidder1Password);
});
beforeEach(() => {
  Object.assign(api.state, { requests: [], mode: 'valid', status: 200, body: undefined, productOverrides: {} });
});
after(async () => {
  await http?.close();
  await api?.close();
  await database?.close();
});

function request(path, { token = auctioneerToken, method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${http.url}/catalog${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function importProduct(id) {
  const response = await request(`/import/${id}`, { method: 'POST' });
  assert.ok([200, 201].includes(response.status));
  return response.json();
}

test('all catalog GET endpoints require authentication', async () => {
  for (const path of ['/external', '/external/search?q=phone', '/external/1', '/categories', '/products', `/products/${randomUUID()}`]) {
    assert.equal((await request(path, { token: null })).status, 401);
  }
  assert.equal(api.state.requests.length, 0);
});

test('authenticated bidders can list, search, paginate, filter categories and read external products', async () => {
  const response = await request('/external?limit=10&skip=20', { token: bidderToken });
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.skip, 20);
  assert.equal(page.limit, 10);
  assert.equal(page.total, fixtures.paginated.total);
  assert.equal((await request('/external/search?q=phone&limit=10', { token: bidderToken })).status, 200);
  assert.equal(api.state.requests[1].pathname, '/products/search');
  assert.equal((await request('/external?category=smartphones', { token: bidderToken })).status, 200);
  assert.equal(api.state.requests[2].pathname, '/products/category/smartphones');
  assert.equal((await request('/external/1', { token: bidderToken })).status, 200);
  const categories = await request('/categories', { token: bidderToken });
  assert.deepEqual(await categories.json(), fixtures.categories);
});

test('import requires AUCTIONEER and rejects client role overrides', async () => {
  assert.equal((await request('/import/1', { method: 'POST', token: null })).status, 401);
  const denied = await request('/import/1', { method: 'POST', token: bidderToken, body: { role: 'AUCTIONEER' } });
  assert.equal(denied.status, 403);
  assert.equal(api.state.requests.length, 0);
});

test('import persists a sanitized snapshot with its own UUID and capture date', async () => {
  const result = await importProduct(1);
  assert.equal(result.created, true);
  const product = result.product;
  assert.equal(product.externalId, '1');
  assert.equal(product.source, 'dummyjson');
  assert.match(product.id, /^[0-9a-f-]{36}$/);
  assert.equal(product.title, fixtures.product_1.title);
  assert.equal(product.imageUrl, fixtures.product_1.thumbnail);
  assert.ok(Date.now() - Date.parse(product.capturedAt) < 10000);
  assert.notEqual(product.capturedAt, fixtures.product_1.meta.createdAt);
  const stored = await database.pool.query('SELECT * FROM product_snapshots WHERE id = $1', [product.id]);
  assert.equal(stored.rows.length, 1);
  for (const forbidden of ['reviews', 'reviewerName', 'reviewerEmail', 'fixture@example.invalid', 'price']) {
    assert.ok(!JSON.stringify(stored.rows[0]).includes(forbidden));
    assert.ok(!JSON.stringify(product).includes(forbidden));
  }
});

test('concurrent imports return one immutable snapshot without duplicates', async () => {
  const results = await Promise.all(Array.from({ length: 6 }, () => importProduct(2)));
  assert.equal(new Set(results.map((result) => result.product.id)).size, 1);
  assert.equal(results.filter((result) => result.created).length, 1);
  const count = await database.pool.query("SELECT count(*) FROM product_snapshots WHERE source = 'dummyjson' AND external_id = '2'");
  assert.equal(count.rows[0].count, '1');
});

test('existing snapshots and repeated imports remain available during external outages', async () => {
  const { product } = await importProduct(3);
  const previousRequests = api.state.requests.length;
  api.state.mode = 'network';
  const repeated = await importProduct(3);
  assert.equal(repeated.created, false);
  assert.deepEqual(repeated.product, product);
  const local = await request(`/products/${product.id}`, { token: bidderToken });
  assert.equal(local.status, 200);
  assert.deepEqual((await local.json()).product, product);
  const page = await request('/products?limit=1&skip=0', { token: bidderToken });
  const list = await page.json();
  assert.equal(list.products.length, 1);
  assert.ok(list.total >= 1);
  assert.equal(list.limit, 1);
  assert.equal(api.state.requests.length, previousRequests);
});

test('reimport never mutates a snapshot referenced by an auction or assigns an external bid price', async () => {
  const { product } = await importProduct(4);
  const auctionId = randomUUID();
  await database.pool.query("INSERT INTO auctions (id, auctioneer_id, product_snapshot_id, starting_bid_cents, min_increment_cents, starts_at, ends_at, status, created_at, updated_at) SELECT $1, id, $2, 500, 100, now(), now() + interval '1 day', 'PUBLISHED', now(), now() FROM users WHERE email = 'auctioneer@verzel.local'", [auctionId, product.id]);
  api.state.productOverrides = { title: 'Changed upstream', price: 999999 };
  const calls = api.state.requests.length;
  assert.deepEqual((await importProduct(4)).product, product);
  assert.equal(api.state.requests.length, calls);
  const auction = await database.pool.query('SELECT product_snapshot_id, starting_bid_cents FROM auctions WHERE id = $1', [auctionId]);
  assert.equal(auction.rows[0].product_snapshot_id, product.id);
  assert.equal(auction.rows[0].starting_bid_cents, '500');
});

test('invalid IDs, queries, pagination and import overrides return 400 without fetching externally', async () => {
  for (const path of ['/external/0', '/external/abc', '/external/9007199254740992', '/external?limit=0', '/external?limit=101', '/external?skip=-1', '/external?limit=1.5', '/external?skip=2147483648', '/external?limit=1&limit=2', '/external?category=../users', '/external/search?q=%20%20', '/external/search', '/products/not-a-uuid', '/products?skip=abc']) {
    assert.equal((await request(path)).status, 400, path);
  }
  assert.equal((await request('/import/5', { method: 'POST', body: { title: 'Injected', source: 'other', price: 1 } })).status, 400);
  assert.equal(api.state.requests.length, 0);
});

test('missing local or external products return 404 and invalid external responses never persist', async () => {
  assert.equal((await request(`/products/${randomUUID()}`)).status, 404);
  assert.equal((await request('/external/404')).status, 404);
  assert.equal((await request('/import/404', { method: 'POST' })).status, 404);
  api.state.body = { id: 5, title: 123 };
  assert.equal((await request('/import/5', { method: 'POST' })).status, 502);
  const count = await database.pool.query("SELECT count(*) FROM product_snapshots WHERE external_id = '5'");
  assert.equal(count.rows[0].count, '0');
});

test('HTTP failures, network errors and timeouts use the standard sanitized error envelope', async () => {
  for (const [mode, status] of [['network', 503], ['timeout', 504], ['invalid-json', 502]]) {
    api.state.mode = mode;
    const response = await request('/external/6');
    assert.equal(response.status, status);
    const result = await response.json();
    assert.ok(result.error.code);
    assert.ok(!JSON.stringify(result).includes('stack'));
  }
});
