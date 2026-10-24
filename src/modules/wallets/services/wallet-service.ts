import { randomUUID } from 'node:crypto';
import { AppError } from '../../../shared/http/app-error.js';
import { MAX_CENTS } from '../../ledger/contracts/ledger.js';
import type { DepositReceipt, Reconciliation, WalletBalance, WalletHistory, WalletQuery, WalletRepository, WalletState, WalletUseCases } from '../contracts/wallets.js';

function balance(wallet: WalletState): WalletBalance {
  if (wallet.balanceCents < 0n || wallet.reservedCents < 0n || wallet.reservedCents > wallet.balanceCents) {
    throw new AppError(409, 'INVALID_WALLET_BALANCE', 'Wallet balance invariants violated');
  }
  return { balanceCents: wallet.balanceCents.toString(), reservedCents: wallet.reservedCents.toString(),
    availableCents: (wallet.balanceCents - wallet.reservedCents).toString() };
}

export class WalletService implements WalletUseCases {
  constructor(private readonly repository: WalletRepository) {}

  get(userId: string): Promise<WalletBalance> {
    return this.repository.transaction(async (tx) => balance((await tx.provisionAndLock(userId)).wallet));
  }

  async deposit(userId: string, amountCents: bigint, key: string): Promise<DepositReceipt> {
    if (amountCents <= 0n || amountCents > MAX_CENTS) throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be positive and within BIGINT limits');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Invalid Idempotency-Key');
    return this.repository.transaction(async (tx) => {
      const { wallet, accountId } = await tx.provisionAndLock(userId);
      balance(wallet);
      const scopedKey = `deposit:${userId}:${key}`;
      const previous = await tx.ledger.findByKey(scopedKey);
      if (previous) {
        const own = previous.entries.find((entry) => entry.accountId === accountId);
        if (previous.transaction.type !== 'DEPOSIT' || previous.transaction.referenceId !== wallet.id || !own) {
          throw new AppError(409, 'INVALID_DEPOSIT_RECORD', 'Stored deposit is inconsistent');
        }
        if (own.amountCents !== amountCents) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different amount');
        return { transactionId: previous.transaction.id, amountCents: own.amountCents.toString(), createdAt: previous.transaction.createdAt };
      }
      if (wallet.balanceCents + amountCents > MAX_CENTS) throw new AppError(409, 'BALANCE_LIMIT', 'Deposit would exceed the wallet BIGINT limit');
      const clearing = await tx.ledger.clearingAccounts();
      const account = clearing[0];
      if (clearing.length !== 1 || !account || account.walletId !== null) {
        throw new AppError(409, 'INVALID_CLEARING_ACCOUNT', 'A single seeded simulation clearing account is required');
      }
      const id = randomUUID();
      const now = new Date();
      await tx.ledger.append({ id, type: 'DEPOSIT', referenceId: wallet.id, idempotencyKey: scopedKey, createdAt: now }, [
        { accountId, amountCents }, { accountId: account.id, amountCents: -amountCents },
      ]);
      await tx.credit(wallet.id, wallet.balanceCents + amountCents);
      return { transactionId: id, amountCents: amountCents.toString(), createdAt: now };
    });
  }

  history(userId: string, query: WalletQuery): Promise<WalletHistory> {
    return this.repository.transaction(async (tx) => {
      const { wallet, accountId } = await tx.provisionAndLock(userId);
      balance(wallet);
      return tx.history(accountId, query);
    });
  }

  reconcile(userId: string): Promise<Reconciliation> {
    return this.repository.transaction(async (tx) => {
      const { wallet, accountId } = await tx.provisionAndLock(userId);
      const total = await tx.ledger.balance(accountId);
      const valid = wallet.balanceCents >= 0n && wallet.reservedCents >= 0n && wallet.reservedCents <= wallet.balanceCents;
      return { walletId: wallet.id, balanceCents: wallet.balanceCents.toString(), ledgerBalanceCents: total.toString(),
        differenceCents: (wallet.balanceCents - total).toString(), consistent: valid && wallet.balanceCents === total };
    });
  }
}
