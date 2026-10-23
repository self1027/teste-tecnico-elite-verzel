import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { DummyJsonProvider } from '../src/modules/catalog/infrastructure/dummyjson-provider.ts';
import { fixtures, mockDummyJSON } from './helpers/dummyjson.js';

let api;
let provider;
before(async () => {
  api = await mockDummyJSON();
  provider = new DummyJsonProvider({ baseURL: api.url, timeoutMs: 5000 });
});
beforeEach(() => {
  Object.assign(api.state, { requests: [], mode: 'valid', status: 200, body: undefined, productOverrides: {} });
});
after(async () => { await api?.close(); });

test('provider validates real list fixtures, supports absent brand and removes reviews and prices', async () => {
  const page = await provider.list({ limit: 30, skip: 0 });
  assert.equal(page.total, fixtures.products.total);
  assert.equal(page.products[0].id, fixtures.products.products[0].id);
  assert.equal(page.products[0].attributes.brand, fixtures.products.products[0].brand);
  assert.ok(!('brand' in page.products[1].attributes));
  for (const product of page.products) {
    const serialized = JSON.stringify(product);
    for (const privateField of ['reviews', 'reviewerName', 'reviewerEmail', 'fixture@example.invalid', 'price']) {
      assert.ok(!serialized.includes(privateField));
    }
  }
});

test('provider forwards pagination, search and category through the appropriate HTTP endpoints', async () => {
  const page = await provider.list({ limit: 10, skip: 20 });
  assert.equal(page.skip, 20);
  assert.equal(page.limit, 10);
  assert.equal(page.products[0].title, fixtures.paginated.products[0].title);
  await provider.search('phone & ear', { limit: 10, skip: 2 });
  assert.equal(api.state.requests[1].pathname, '/products/search');
  assert.equal(api.state.requests[1].searchParams.get('q'), 'phone & ear');
  assert.equal(api.state.requests[1].searchParams.get('skip'), '2');
  const category = await provider.list({ limit: 30, skip: 0, category: 'smartphones' });
  assert.equal(api.state.requests[2].pathname, '/products/category/smartphones');
  assert.equal(category.products[0].attributes.category, 'smartphones');
});

test('provider handles single products and categories, with image fallback and nullable descriptions', async () => {
  const product = await provider.getById(1);
  assert.equal(product.imageUrl, fixtures.product_1.thumbnail);
  assert.deepEqual(await provider.categories(), fixtures.categories);
  const body = structuredClone(fixtures.product_1);
  delete body.thumbnail;
  delete body.description;
  api.state.body = body;
  const fallback = await provider.getById(1);
  assert.equal(fallback.imageUrl, body.images[0]);
  assert.equal(fallback.description, null);
  delete body.images;
  assert.equal((await provider.getById(1)).imageUrl, null);
});

test('provider accepts empty paginated search results', async () => {
  api.state.body = { products: [], total: 0, skip: 100, limit: 0 };
  assert.deepEqual(await provider.search('missing', { limit: 30, skip: 100 }), api.state.body);
});

test('provider rejects invalid product shapes, metadata and a mismatched product ID', async () => {
  for (const body of [
    { ...fixtures.product_1, id: '1' },
    { ...fixtures.product_1, id: 2 },
    { ...fixtures.product_1, title: '' },
    { ...fixtures.product_1, thumbnail: 'javascript:alert(1)' },
    { ...fixtures.product_1, dimensions: { width: 'invalid' } },
  ]) {
    api.state.body = body;
    await assert.rejects(provider.getById(1), (error) => error.status === 502 && error.code === 'EXTERNAL_INVALID_RESPONSE');
  }
  for (const body of [
    { products: [], total: '194', skip: 0, limit: 30 },
    { products: [fixtures.product_1], total: 0, skip: 0, limit: 30 },
    { products: [], total: 10, skip: -1, limit: 30 },
  ]) {
    api.state.body = body;
    await assert.rejects(provider.list({ limit: 30, skip: 0 }), (error) => error.status === 502);
  }
  api.state.body = [{ slug: 'beauty' }];
  await assert.rejects(provider.categories(), (error) => error.status === 502);
});

test('provider maps missing products, upstream HTTP errors and invalid JSON to sanitized errors', async () => {
  await assert.rejects(provider.getById(404), (error) => error.status === 404 && error.code === 'EXTERNAL_PRODUCT_NOT_FOUND');
  api.state.body = { secret: 'upstream credentials' };
  api.state.status = 503;
  await assert.rejects(provider.getById(1), (error) => error.status === 502 && !error.message.includes('credentials'));
  api.state.mode = 'invalid-json';
  await assert.rejects(provider.getById(1), (error) => error.status === 502);
});

test('provider maps connection failures to 503', async () => {
  api.state.mode = 'network';
  await assert.rejects(provider.getById(1), (error) => error.status === 503 && error.code === 'EXTERNAL_UNAVAILABLE');
});

test('provider enforces timeout on both connection response and response body', async () => {
  const impatient = new DummyJsonProvider({ baseURL: api.url, timeoutMs: 40 });
  for (const mode of ['timeout', 'body-timeout']) {
    api.state.mode = mode;
    await assert.rejects(impatient.getById(1), (error) => error.status === 504 && error.code === 'EXTERNAL_TIMEOUT');
  }
});
