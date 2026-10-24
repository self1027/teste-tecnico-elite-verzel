import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AuthLocals } from '../../auth/middleware/authentication.js';
import { unauthenticated } from '../../../shared/http/app-error.js';
import { MAX_CENTS } from '../../ledger/contracts/ledger.js';
import type { WalletUseCases } from '../contracts/wallets.js';

const input = z.strictObject({ amountCents: z.string().max(19).regex(/^[1-9]\d*$/).transform(BigInt).pipe(z.bigint().max(MAX_CENTS)) });
const keyInput = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const unsigned = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative());
const pageInput = z.strictObject({ limit: unsigned.pipe(z.number().min(1).max(100)).default(30), skip: unsigned.pipe(z.number().max(2147483647)).default(0) });

function owner(response: Response<unknown, AuthLocals>): string {
  if (!response.locals.user) throw unauthenticated();
  return response.locals.user.id;
}

export class WalletController {
  constructor(private readonly wallets: WalletUseCases) {}

  get = async (_request: Request, response: Response<unknown, AuthLocals>): Promise<void> => {
    response.json({ wallet: await this.wallets.get(owner(response)) });
  };

  deposit = async (request: Request, response: Response<unknown, AuthLocals>): Promise<void> => {
    const { amountCents } = input.parse(request.body);
    const headers = request.rawHeaders.filter((_, index) => index % 2 === 0).filter((header) => header.toLowerCase() === 'idempotency-key');
    const key = keyInput.parse(headers.length === 1 ? request.get('Idempotency-Key') : undefined);
    response.status(201).json({ deposit: await this.wallets.deposit(owner(response), amountCents, key) });
  };

  history = async (request: Request, response: Response<unknown, AuthLocals>): Promise<void> => {
    response.json(await this.wallets.history(owner(response), pageInput.parse(request.query)));
  };
}
