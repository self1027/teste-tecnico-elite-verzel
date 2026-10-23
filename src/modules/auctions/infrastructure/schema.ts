import {
  type AnyPgColumn, bigint, pgEnum, pgTable, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { productSnapshots } from '../../catalog/infrastructure/schema.js';
import { users } from '../../users/infrastructure/schema.js';

export const auctionStatus = pgEnum('auction_status', [
  'PUBLISHED', 'CANCELLED', 'SETTLED', 'CLOSED_NO_BIDS',
]);

export const auctions = pgTable('auctions', {
  id: uuid('id').primaryKey(),
  auctioneerId: uuid('auctioneer_id').notNull().references(() => users.id),
  productSnapshotId: uuid('product_snapshot_id').notNull().references(() => productSnapshots.id),
  currentBidId: uuid('current_bid_id').references((): AnyPgColumn => bids.id),
  startingBidCents: bigint('starting_bid_cents', { mode: 'bigint' }).notNull(),
  minIncrementCents: bigint('min_increment_cents', { mode: 'bigint' }).notNull(),
  startsAt: timestamp('starts_at').notNull(),
  endsAt: timestamp('ends_at').notNull(),
  status: auctionStatus('status').notNull(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

export const bids = pgTable('bids', {
  id: uuid('id').primaryKey(),
  auctionId: uuid('auction_id').notNull().references(() => auctions.id),
  bidderId: uuid('bidder_id').notNull().references(() => users.id),
  amountCents: bigint('amount_cents', { mode: 'bigint' }).notNull(),
  sequence: bigint('sequence', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at').notNull(),
}, (table) => [
  uniqueIndex('bids_auction_id_sequence_unique').on(table.auctionId, table.sequence),
]);

export type AuctionRecord = typeof auctions.$inferSelect;
export type NewAuctionRecord = typeof auctions.$inferInsert;
export type BidRecord = typeof bids.$inferSelect;
export type NewBidRecord = typeof bids.$inferInsert;
