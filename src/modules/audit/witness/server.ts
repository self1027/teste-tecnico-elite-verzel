import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { WitnessConflict, WitnessJournal, type JournalOptions } from './journal.js';
import { requireCheckpoint, requireIdentifier } from './protocol.js';

export interface WitnessServerOptions extends JournalOptions { publishToken: string }
/** Operate this process and journal with credentials/storage isolated from the application. */
export async function createWitnessServer(options: WitnessServerOptions) {
  requireIdentifier(options.namespace);
  if (!options.publishToken || options.publishToken.length < 16) throw new Error('Witness publish token must contain at least 16 characters');
  const tokenHash = createHash('sha256').update(`Bearer ${options.publishToken}`).digest();
  const journal = await WitnessJournal.open(options);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb', strict: true }));
  const prefix = '/v1/namespaces/:namespace/auctions/:auctionId';
  app.get(`${prefix}/latest`, (request, response) => {
    response.setHeader('cache-control', 'no-store');
    try {
      if (request.params.namespace !== options.namespace) { response.status(400).json({ error: 'NAMESPACE_MISMATCH' }); return; }
      requireIdentifier(request.params.auctionId);
      const receipt = journal.latest(request.params.auctionId);
      if (!receipt) { response.status(404).json({ error: 'NOT_FOUND' }); return; }
      response.json(receipt);
    } catch { response.status(503).json({ error: 'WITNESS_UNAVAILABLE' }); }
  });
  app.post(`${prefix}/checkpoints`, async (request, response) => {
    const supplied = createHash('sha256').update(request.headers.authorization ?? '').digest();
    if (!timingSafeEqual(supplied, tokenHash)) { response.status(401).json({ error: 'UNAUTHORIZED' }); return; }
    if (request.params.namespace !== options.namespace) { response.status(400).json({ error: 'NAMESPACE_MISMATCH' }); return; }
    try {
      requireIdentifier(request.params.auctionId);
      const body: unknown = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'checkpoint,previous') throw new Error('Invalid request');
      const value = body as Record<string, unknown>;
      requireCheckpoint(value.checkpoint);
      if (value.checkpoint.auctionId !== request.params.auctionId) throw new Error('Auction mismatch');
      const receipt = await journal.append(value.checkpoint, value.previous);
      response.setHeader('cache-control', 'no-store'); response.status(201).json(receipt);
    } catch (error) {
      response.status(error instanceof WitnessConflict ? 409 : 503).json({ error: error instanceof WitnessConflict ? 'CONFLICT' : 'PUBLICATION_FAILED' });
    }
  });
  return { app, close: () => journal.close() };
}
