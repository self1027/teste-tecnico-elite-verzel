import type { z } from 'zod';
import type { ExternalListInput, ExternalProduct, Pagination, ProductPage, ProductProvider } from '../contracts/catalog.js';
import { AppError } from '../../../shared/http/app-error.js';
import { categoriesSchema, externalPageSchema, externalProductSchema } from './dummyjson-schemas.js';

interface ProviderOptions {
  baseURL?: string;
  timeoutMs?: number;
}

function invalidResponse(): AppError {
  return new AppError(502, 'EXTERNAL_INVALID_RESPONSE', 'Invalid product provider response');
}

export class DummyJsonProvider implements ProductProvider {
  private readonly baseURL: string;
  private readonly timeoutMs: number;

  constructor(options: ProviderOptions = {}) {
    this.baseURL = options.baseURL ?? 'https://dummyjson.com';
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  list(input: ExternalListInput): Promise<ProductPage<ExternalProduct>> {
    const path = input.category ? `/products/category/${encodeURIComponent(input.category)}` : '/products';
    return this.get(path, externalPageSchema, { limit: String(input.limit), skip: String(input.skip) });
  }

  search(query: string, page: Pagination): Promise<ProductPage<ExternalProduct>> {
    return this.get('/products/search', externalPageSchema, { q: query, limit: String(page.limit), skip: String(page.skip) });
  }

  async getById(id: number): Promise<ExternalProduct> {
    const product = await this.get(`/products/${String(id)}`, externalProductSchema);
    if (product.id !== id) throw invalidResponse();
    return product;
  }

  categories(): Promise<string[]> {
    return this.get('/products/category-list', categoriesSchema);
  }

  private async get<T>(path: string, schema: z.ZodType<T>, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(path, this.baseURL);
    url.search = new URLSearchParams(query).toString();
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await fetch(url, { signal, redirect: 'error', headers: { Accept: 'application/json' } });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404) throw new AppError(404, 'EXTERNAL_PRODUCT_NOT_FOUND', 'External product not found');
        throw new AppError(502, 'EXTERNAL_HTTP_ERROR', 'Product provider request failed');
      }
      const body: unknown = await response.json();
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw invalidResponse();
      return parsed.data;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (signal.aborted) throw new AppError(504, 'EXTERNAL_TIMEOUT', 'Product provider timed out');
      if (error instanceof SyntaxError) throw invalidResponse();
      throw new AppError(503, 'EXTERNAL_UNAVAILABLE', 'Product provider is unavailable');
    }
  }
}
