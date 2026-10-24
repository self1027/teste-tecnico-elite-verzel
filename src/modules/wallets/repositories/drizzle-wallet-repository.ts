import { randomUUID } from 'node:crypto';
import { and, asc, countDistinct, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database, DatabaseTransaction } from '../../../shared/database/client.js';
import { AppError } from '../../../shared/http/app-error.js';
import { users } from '../../users/infrastructure/schema.js';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../../ledger/infrastructure/schema.js';
import { DrizzleLedgerRepository } from '../../ledger/repositories/drizzle-ledger-repository.js';
import { wallets } from '../infrastructure/schema.js';
import type { WalletHistory, WalletQuery, WalletRepository, WalletWriteContext } from '../contracts/wallets.js';

async function provisionAndLock(tx: DatabaseTransaction, userId: string) {
  const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  const now = new Date();
  await tx.insert(wallets).values({ id: randomUUID(), userId, createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: wallets.userId });
  const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, userId)).for('update');
  if (!wallet) throw new Error('Wallet provisioning failed');
  let [account] = await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.walletId, wallet.id));
  if (!account) {
    if (wallet.balanceCents !== 0n || wallet.reservedCents !== 0n) {
      throw new AppError(409, 'MISSING_LEDGER_ACCOUNT', 'A funded wallet cannot be provisioned without its ledger account');
    }
    await tx.insert(ledgerAccounts).values({ id: randomUUID(), walletId: wallet.id, type: 'USER_WALLET', createdAt: now })
      .onConflictDoNothing({ target: ledgerAccounts.walletId });
    [account] = await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.walletId, wallet.id));
  }
  if (!account || account.type !== 'USER_WALLET') throw new AppError(409, 'INVALID_WALLET_ACCOUNT', 'Wallet ledger account is inconsistent');
  return { wallet, accountId: account.id };
}

async function history(tx: DatabaseTransaction, accountId: string, query: WalletQuery): Promise<WalletHistory> {
  const rows = await tx.select({ id: ledgerTransactions.id, type: ledgerTransactions.type, createdAt: ledgerTransactions.createdAt,
    amountCents: sql<string>`sum(${ledgerEntries.amountCents})::text` }).from(ledgerTransactions)
    .innerJoin(ledgerEntries, eq(ledgerEntries.transactionId, ledgerTransactions.id)).where(eq(ledgerEntries.accountId, accountId))
    .groupBy(ledgerTransactions.id).orderBy(desc(ledgerTransactions.createdAt), asc(ledgerTransactions.id)).limit(query.limit).offset(query.skip);
  const [total] = await tx.select({ count: countDistinct(ledgerEntries.transactionId) }).from(ledgerEntries).where(eq(ledgerEntries.accountId, accountId));
  const entries = rows.length === 0 ? [] : await tx.select().from(ledgerEntries)
    .where(and(eq(ledgerEntries.accountId, accountId), inArray(ledgerEntries.transactionId, rows.map((row) => row.id))))
    .orderBy(asc(ledgerEntries.id));
  return { transactions: rows.map((row) => ({ ...row, entries: entries.filter((entry) => entry.transactionId === row.id)
    .map((entry) => ({ id: entry.id, amountCents: entry.amountCents.toString() })) })), total: total?.count ?? 0, ...query };
}

export class DrizzleWalletRepository implements WalletRepository {
  constructor(private readonly db: Database) {}

  transaction<T>(work: (context: WalletWriteContext) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work({
      ledger: new DrizzleLedgerRepository(tx),
      provisionAndLock: (userId) => provisionAndLock(tx, userId),
      async credit(id, balanceCents) {
        await tx.update(wallets).set({ balanceCents, updatedAt: new Date() }).where(eq(wallets.id, id));
      },
      history: (accountId, query) => history(tx, accountId, query),
    }), { isolationLevel: 'read committed' });
  }
}
