import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { isolatedDatabase } from '../helpers/database.js';
import { DrizzleAuditRepository } from '../../src/modules/audit/repositories/drizzle-audit-repository.ts';
import { checkChain } from '../../src/modules/audit/domain/cryptography.ts';

test('additive migration preserves legacy events as unsupported version zero without trusting them', async () => {
  const f = await isolatedDatabase();
  try {
    await f.pool.query('ALTER TABLE audit_events DROP COLUMN hash_version');
    const owner = randomUUID(), product = randomUUID(), auction = randomUUID(), event = randomUUID();
    await f.pool.query("INSERT INTO users VALUES($1,'legacy@test.invalid','hash','Legacy','AUCTIONEER',now(),now())", [owner]);
    await f.pool.query("INSERT INTO product_snapshots(id,external_id,source,title,captured_at) VALUES($1,'legacy','test','Legacy',now())", [product]);
    await f.pool.query("INSERT INTO auctions(id,auctioneer_id,product_snapshot_id,starting_bid_cents,min_increment_cents,starts_at,ends_at,status,created_at,updated_at) VALUES($1,$2,$3,1,1,date_trunc('milliseconds',now()),date_trunc('milliseconds',now())+interval '1 hour','PUBLISHED',now(),now())", [auction, owner, product]);
    await f.pool.query("INSERT INTO audit_events(id,auction_id,sequence,event_type,payload,previous_hash,event_hash,created_at) VALUES($1,$2,1,'LEGACY',$3,$4,$5,date_trunc('milliseconds',now()))", [event, auction, JSON.stringify({ legacy: 'preserved' }), '0'.repeat(64), '1'.repeat(64)]);
    const migration = await readFile(new URL('../../drizzle/20261024195515_orange_inertia/migration.sql', import.meta.url), 'utf8');
    await f.pool.query(migration);
    const snapshot = await new DrizzleAuditRepository(f.db).snapshot(auction);
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.events[0].id, event);
    assert.equal(snapshot.events[0].hashVersion, 0);
    assert.deepEqual(snapshot.events[0].payload, { legacy: 'preserved' });
    assert.equal(checkChain(auction, snapshot.events).valid, false);
  } finally { await f.close(); }
});
