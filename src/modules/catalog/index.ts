import { Router } from 'express';
import type { Database } from '../../shared/database/client.js';
import type { authentication } from '../auth/middleware/authentication.js';
import { authorize } from '../auth/middleware/authorization.js';
import type { ProductProvider } from './contracts/catalog.js';
import { CatalogController } from './controllers/catalog-controller.js';
import { DrizzleSnapshotRepository } from './repositories/drizzle-snapshot-repository.js';
import { CatalogService } from './services/catalog-service.js';

export function createCatalogModule(
  database: Database, authenticate: ReturnType<typeof authentication>, provider: ProductProvider,
): Router {
  const service = new CatalogService(provider, new DrizzleSnapshotRepository(database));
  const controller = new CatalogController(service);
  const router = Router();
  router.use(authenticate);
  router.get('/external', controller.listExternal);
  router.get('/external/search', controller.searchExternal);
  router.get('/external/:id', controller.getExternal);
  router.get('/categories', controller.categories);
  router.post('/import/:id', authorize('AUCTIONEER'), controller.importProduct);
  router.get('/products', controller.listProducts);
  router.get('/products/:id', controller.getProduct);
  return router;
}
