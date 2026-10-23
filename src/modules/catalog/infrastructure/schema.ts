import { json, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const productSnapshots = pgTable('product_snapshots', {
  id: uuid('id').primaryKey(),
  externalId: varchar('external_id', { length: 255 }).notNull(),
  source: varchar('source', { length: 100 }).notNull(),
  title: text('title').notNull(),
  description: text('description'),
  imageUrl: text('image_url'),
  attributes: json('attributes'),
  capturedAt: timestamp('captured_at').notNull(),
});

export type ProductSnapshotRecord = typeof productSnapshots.$inferSelect;
export type NewProductSnapshotRecord = typeof productSnapshots.$inferInsert;
