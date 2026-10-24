import express, { type Express, type Router } from 'express';
import { AppError } from './shared/http/app-error.js';
import { errorHandler } from './shared/http/error-handler.js';

export function createApp(authRouter: Router, catalogRouter?: Router, auctionRouter?: Router, walletRouter?: Router): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use('/auth', authRouter);
  if (catalogRouter) app.use('/catalog', catalogRouter);
  if (auctionRouter) app.use('/auctions', auctionRouter);
  if (walletRouter) app.use('/wallet', walletRouter);
  app.use(() => { throw new AppError(404, 'NOT_FOUND', 'Route not found'); });
  app.use(errorHandler);
  return app;
}
