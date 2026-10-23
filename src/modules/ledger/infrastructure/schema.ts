import { bigint, pgEnum, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { wallets } from '../../wallets/infrastructure/schema.js';

export const ledgerAccountType = pgEnum('ledger_account_type', ['USER_WALLET', 'SIMULATION_CLEARING']);
export const ledgerTransactionType = pgEnum('ledger_transaction_type', ['DEPOSIT', 'AUCTION_SETTLEMENT']);

export const ledgerAccounts = pgTable('ledger_accounts', {
  id: uuid('id').primaryKey(),
  walletId: uuid('wallet_id').unique().references(() => wallets.id),
  type: ledgerAccountType('type').notNull(),
  createdAt: timestamp('created_at').notNull(),
});

export const ledgerTransactions = pgTable('ledger_transactions', {
  id: uuid('id').primaryKey(),
  type: ledgerTransactionType('type').notNull(),
  referenceId: uuid('reference_id'),
  idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull().unique(),
  createdAt: timestamp('created_at').notNull(),
});

export const ledgerEntries = pgTable('ledger_entries', {
  id: uuid('id').primaryKey(),
  transactionId: uuid('transaction_id').notNull().references(() => ledgerTransactions.id),
  accountId: uuid('account_id').notNull().references(() => ledgerAccounts.id),
  amountCents: bigint('amount_cents', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at').notNull(),
});

export type LedgerAccountRecord = typeof ledgerAccounts.$inferSelect;
export type NewLedgerAccountRecord = typeof ledgerAccounts.$inferInsert;
export type LedgerTransactionRecord = typeof ledgerTransactions.$inferSelect;
export type NewLedgerTransactionRecord = typeof ledgerTransactions.$inferInsert;
export type LedgerEntryRecord = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntryRecord = typeof ledgerEntries.$inferInsert;
