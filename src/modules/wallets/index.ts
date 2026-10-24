import { Router } from 'express';
import type { Database } from '../../shared/database/client.js';
import type { authentication } from '../auth/middleware/authentication.js';
import { authorize } from '../auth/middleware/authorization.js';
import { WalletController } from './controllers/wallet-controller.js';
import { DrizzleWalletRepository } from './repositories/drizzle-wallet-repository.js';
import { WalletService } from './services/wallet-service.js';

export function createWalletModule(database: Database, authenticate: ReturnType<typeof authentication>): Router {
  const controller = new WalletController(new WalletService(new DrizzleWalletRepository(database)));
  const router = Router();
  router.use(authenticate);
  router.get('/', controller.get);
  router.get('/transactions', controller.history);
  router.post('/deposits', authorize('BIDDER'), controller.deposit);
  return router;
}
