import { bigint, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { ledgerTransactions } from '../../ledger/infrastructure/schema.js';
import { auctions, bids } from './schema.js';

export const auctionSettlements = pgTable('auction_settlements', {
  id: uuid('id').primaryKey(),
  auctionId: uuid('auction_id').notNull().unique().references(() => auctions.id),
  winningBidId: uuid('winning_bid_id').notNull().unique().references(() => bids.id),
  ledgerTransactionId: uuid('ledger_transaction_id').notNull().unique().references(() => ledgerTransactions.id),
  amountCents: bigint('amount_cents', { mode: 'bigint' }).notNull(),
  receiptToken: uuid('receipt_token').notNull().unique(),
  settledAt: timestamp('settled_at').notNull(),
});

export type AuctionSettlementRecord = typeof auctionSettlements.$inferSelect;
export type NewAuctionSettlementRecord = typeof auctionSettlements.$inferInsert;
