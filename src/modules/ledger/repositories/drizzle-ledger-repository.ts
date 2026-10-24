import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../../shared/database/client.js';
import type { LedgerTransactionInput, LedgerWriteContext, StoredTransaction } from '../contracts/ledger.js';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../infrastructure/schema.js';
import { assertBalanced } from '../services/balance.js';

export class DrizzleLedgerRepository implements LedgerWriteContext {
  constructor(private readonly tx: DatabaseTransaction) {}

  async findByKey(key: string): Promise<StoredTransaction | null> {
    const [transaction] = await this.tx.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, key));
    if (!transaction) return null;
    const entries = await this.tx.select().from(ledgerEntries).where(eq(ledgerEntries.transactionId, transaction.id));
    return { transaction, entries };
  }

  clearingAccounts() {
    return this.tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.type, 'SIMULATION_CLEARING')).limit(2);
  }

  async append(transaction: LedgerTransactionInput, entries: { accountId: string; amountCents: bigint }[]): Promise<void> {
    assertBalanced(entries);
    await this.tx.insert(ledgerTransactions).values(transaction);
    await this.tx.insert(ledgerEntries).values(entries.map((entry) => ({
      ...entry, id: randomUUID(), transactionId: transaction.id, createdAt: transaction.createdAt,
    })));
  }

  async balance(accountId: string): Promise<bigint> {
    const [row] = await this.tx.select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountCents}), 0)::text` })
      .from(ledgerEntries).where(eq(ledgerEntries.accountId, accountId));
    if (!row) throw new Error('Ledger aggregate returned no result');
    return BigInt(row.total);
  }
}
