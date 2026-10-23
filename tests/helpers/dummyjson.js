import { readFileSync } from 'node:fs';
import { serve, respondJSON } from './http.js';

export const fixtures = Object.fromEntries(
  ['products', 'product_1', 'search_phone', 'paginated', 'categories', 'category_smartphones']
    .map((name) => [name, JSON.parse(readFileSync(new URL(`../fixtures/dummyjson/${name}.json`, import.meta.url), 'utf8'))]),
);

export async function mockDummyJSON() {
  const state = { requests: [], mode: 'valid', status: 200, body: undefined, productOverrides: {} };
  const http = await serve((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    state.requests.push(url);
    if (state.mode === 'network') { request.socket.destroy(); return; }
    if (state.mode === 'timeout') return;
    if (state.mode === 'body-timeout') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
      return;
    }
    if (state.mode === 'invalid-json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('not-json');
      return;
    }
    if (state.body !== undefined) { respondJSON(response, state.body, state.status); return; }
    if (url.pathname === '/products/category-list') { respondJSON(response, fixtures.categories); return; }
    const match = /^\/products\/(\d+)$/.exec(url.pathname);
    if (match) {
      if (match[1] === '404') { respondJSON(response, { message: 'Product not found' }, 404); return; }
      respondJSON(response, { ...fixtures.product_1, id: Number(match[1]), ...state.productOverrides });
      return;
    }
    const page = url.pathname === '/products/search' ? fixtures.search_phone
      : url.pathname === '/products/category/smartphones' ? fixtures.category_smartphones
        : url.searchParams.get('limit') === '10' ? fixtures.paginated : fixtures.products;
    respondJSON(response, { ...page, skip: Number(url.searchParams.get('skip') ?? page.skip), limit: Number(url.searchParams.get('limit') ?? page.limit) });
  });
  return { ...http, state };
}
