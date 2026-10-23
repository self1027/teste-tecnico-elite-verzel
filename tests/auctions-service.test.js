import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuctionService } from '../src/modules/auctions/services/auction-service.ts';

const startsAt = new Date('2026-10-23T12:00:00.000Z');
const endsAt = new Date('2026-10-23T13:00:00.000Z');
const auction = { id: 'auction', auctioneerId: 'owner', productSnapshotId: 'snapshot', currentBidId: null, status: 'PUBLISHED', startsAt, endsAt, startingBidCents: 1n, minIncrementCents: 1n, createdAt: startsAt, updatedAt: startsAt };

function serviceAt(now) {
  const writes = [];
  const context = {
    snapshotExists: async () => true,
    lock: async () => auction,
    hasBids: async () => false,
    databaseNow: async () => now,
    insert: async (record) => { writes.push(record); return record; },
    update: async (_id, changes) => { writes.push(changes); return { ...auction, ...changes }; },
  };
  return { service: new AuctionService({ transaction: async (work) => work(context) }), writes };
}

test('creation rejects startsAt equal to the database decision time without inserting', async () => {
  const { service, writes } = serviceAt(startsAt);
  await assert.rejects(service.create('owner', auction), (error) => error.code === 'INVALID_AUCTION_DATES');
  assert.equal(writes.length, 0);
});

test('editing rejects the exact start instant even when a new future start is supplied', async () => {
  const { service, writes } = serviceAt(startsAt);
  await assert.rejects(service.edit('auction', 'owner', { startsAt: endsAt }), (error) => error.code === 'AUCTION_ALREADY_STARTED');
  assert.equal(writes.length, 0);
});

test('cancellation rejects the exact end instant without changing administrative status', async () => {
  const { service, writes } = serviceAt(endsAt);
  await assert.rejects(service.cancel('auction', 'owner'), (error) => error.code === 'AUCTION_EXPIRED');
  assert.equal(writes.length, 0);
});
