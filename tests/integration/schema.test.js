import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/shared/database/schema.ts';

test('migration and domain relationships work on an isolated PostgreSQL database', async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a disposable PostgreSQL database');
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    const db = drizzle({ client: pool });
    await migrate(db, { migrationsFolder: './drizzle' });
    await migrate(db, { migrationsFolder: './drizzle' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const db = drizzle({ client });
      const now = new Date('2026-10-23T12:00:00.000Z');
      const timestamps = { createdAt: now, updatedAt: now };
      const auctioneerId = randomUUID();
      const bidderId = randomUUID();
      const productId = randomUUID();
      const auctionId = randomUUID();
      const bidId = randomUUID();
      const walletId = randomUUID();
      const accountId = randomUUID();
      const transactionId = randomUUID();
      const preciseAmount = 9007199254740993n;

      await db.insert(schema.users).values([
        { id: auctioneerId, email: `${auctioneerId}@test.invalid`, passwordHash: 'test', displayName: 'Auctioneer', role: 'AUCTIONEER', ...timestamps },
        { id: bidderId, email: `${bidderId}@test.invalid`, passwordHash: 'test', displayName: 'Bidder', role: 'BIDDER', ...timestamps },
      ]);
      await db.insert(schema.productSnapshots).values({ id: productId, externalId: '1', source: 'test', title: 'Product', capturedAt: now });
      await db.insert(schema.auctions).values({ id: auctionId, auctioneerId, productSnapshotId: productId, startingBidCents: 1n, minIncrementCents: 1n, startsAt: now, endsAt: now, status: 'PUBLISHED', ...timestamps });
      await db.insert(schema.bids).values({ id: bidId, auctionId, bidderId, amountCents: preciseAmount, sequence: 1n, createdAt: now });
      await db.update(schema.auctions).set({ currentBidId: bidId }).where(eq(schema.auctions.id, auctionId));
      const [wallet] = await db.insert(schema.wallets).values({ id: walletId, userId: bidderId, ...timestamps }).returning();
      assert.equal(wallet.balanceCents, 0n);
      assert.equal(wallet.reservedCents, 0n);
      await db.insert(schema.walletReservations).values({ id: randomUUID(), walletId, auctionId, bidId, amountCents: preciseAmount, status: 'ACTIVE', createdAt: now });
      await db.insert(schema.ledgerAccounts).values([
        { id: accountId, walletId, type: 'USER_WALLET', createdAt: now },
        { id: randomUUID(), type: 'SIMULATION_CLEARING', createdAt: now },
        { id: randomUUID(), type: 'SIMULATION_CLEARING', createdAt: now },
      ]);
      await db.insert(schema.ledgerTransactions).values({ id: transactionId, type: 'AUCTION_SETTLEMENT', referenceId: auctionId, idempotencyKey: randomUUID(), createdAt: now });
      const [entry] = await db.insert(schema.ledgerEntries).values({ id: randomUUID(), transactionId, accountId, amountCents: -preciseAmount, createdAt: now }).returning();
      assert.equal(entry.amountCents, -preciseAmount);
      const [bid] = await db.select().from(schema.bids).where(eq(schema.bids.id, bidId));
      assert.equal(bid.amountCents, preciseAmount);
      assert.equal(bid.sequence, 1n);
      await db.insert(schema.auctionSettlements).values({ id: randomUUID(), auctionId, winningBidId: bidId, ledgerTransactionId: transactionId, amountCents: preciseAmount, receiptToken: randomUUID(), settledAt: now });
      await db.insert(schema.auditEvents).values({ id: randomUUID(), auctionId, sequence: 1n, eventType: 'BID_PLACED', payload: { bidId }, previousHash: '0'.repeat(64), eventHash: '1'.repeat(64), createdAt: now });
      await db.insert(schema.auditAnchors).values({ id: randomUUID(), auctionId, lastSequence: 1n, lastHash: '1'.repeat(64), anchoredAt: now });

      async function rejectsSQL(sql, code) {
        await client.query('SAVEPOINT constraint_check');
        try {
          await assert.rejects(client.query(sql), (error) => error.code === code);
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT constraint_check');
          await client.query('RELEASE SAVEPOINT constraint_check');
        }
      }
      await rejectsSQL('INSERT INTO bids SELECT gen_random_uuid(), auction_id, bidder_id, amount_cents, sequence, created_at FROM bids', '23505');
      await rejectsSQL('INSERT INTO bids SELECT gen_random_uuid(), gen_random_uuid(), bidder_id, amount_cents, sequence + 1, created_at FROM bids', '23503');
      await rejectsSQL('INSERT INTO wallets SELECT gen_random_uuid(), user_id, balance_cents, reserved_cents, created_at, updated_at FROM wallets', '23505');
      await rejectsSQL('INSERT INTO ledger_transactions SELECT gen_random_uuid(), type, reference_id, idempotency_key, created_at FROM ledger_transactions', '23505');
      await rejectsSQL('INSERT INTO audit_anchors SELECT gen_random_uuid(), auction_id, last_sequence, last_hash, external_reference, anchored_at FROM audit_anchors', '23505');
      await rejectsSQL("UPDATE users SET role = 'ADMIN'", '22P02');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  } finally {
    await pool.end();
  }
});
