import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { after, before, beforeEach, test } from 'node:test';
import { auctionFixture } from '../helpers/auctions.js';

let f;
before(async () => { f = await auctionFixture(); });
beforeEach(async () => { await f.reset(); });
after(async () => { await f?.close(); });

async function waitForBlockedMutation(pid) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await f.pool.query('SELECT count(*) FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))', [pid]);
    if (Number(result.rows[0].count) > 0) return;
    await setTimeout(20);
  }
  assert.fail('Auction mutation did not wait for the parent auction row lock');
}

async function lock(id) {
  const client = await f.pool.connect();
  await client.query('BEGIN');
  const result = await client.query('SELECT pg_backend_pid() AS pid');
  await client.query('SELECT id FROM auctions WHERE id = $1 FOR UPDATE', [id]);
  return { client, pid: result.rows[0].pid };
}

test('two concurrent cancellations serialize and return one success plus one conflict', async () => {
  const auction = await f.fixture();
  const responses = await Promise.all([1, 2].map(() => f.request(`/${auction.id}/cancel`, { method: 'POST', token: f.tokens.owner })));
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal((await f.pool.query('SELECT status FROM auctions WHERE id = $1', [auction.id])).rows[0].status, 'CANCELLED');
});

test('concurrent edit and cancellation cannot overwrite a terminal status', async () => {
  const auction = await f.fixture();
  const [edit, cancel] = await Promise.all([
    f.request(`/${auction.id}`, { method: 'PATCH', token: f.tokens.owner, body: { startingBidCents: '12345' } }),
    f.request(`/${auction.id}/cancel`, { method: 'POST', token: f.tokens.owner }),
  ]);
  assert.ok([200, 409].includes(edit.status));
  assert.equal(cancel.status, 200);
  const row = (await f.pool.query('SELECT status, starting_bid_cents FROM auctions WHERE id = $1', [auction.id])).rows[0];
  assert.equal(row.status, 'CANCELLED');
  assert.equal(row.starting_bid_cents, edit.status === 200 ? '12345' : '1000');
});

test('a bid committed while cancellation waits is observed before the cancellation decision', async () => {
  const now = await f.clock();
  const auction = await f.fixture({ startsAt: new Date(+now - 1000) });
  const { client, pid } = await lock(auction.id);
  try {
    await client.query('INSERT INTO bids (id, auction_id, bidder_id, amount_cents, sequence, created_at) VALUES ($1, $2, $3, 2000, 1, now())', [randomUUID(), auction.id, f.bidderId]);
    const pending = f.request(`/${auction.id}/cancel`, { method: 'POST', token: f.tokens.owner });
    await waitForBlockedMutation(pid);
    await client.query('COMMIT');
    const response = await pending;
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'AUCTION_HAS_BIDS');
    assert.equal((await f.pool.query('SELECT status FROM auctions WHERE id = $1', [auction.id])).rows[0].status, 'PUBLISHED');
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('editing rejects a start crossed while waiting, using database wall clock after the lock', async () => {
  const now = await f.clock();
  const auction = await f.fixture({ startsAt: new Date(+now + 250) });
  const { client, pid } = await lock(auction.id);
  try {
    const pending = f.request(`/${auction.id}`, { method: 'PATCH', token: f.tokens.owner, body: { startingBidCents: '2' } });
    await waitForBlockedMutation(pid);
    await client.query('SELECT pg_sleep(greatest(0, extract(epoch FROM ($1::timestamptz - clock_timestamp()))) + 0.02)', [auction.startsAt]);
    await client.query('COMMIT');
    const response = await pending;
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'AUCTION_ALREADY_STARTED');
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('cancellation rejects an end crossed while waiting, using the same parent row protocol', async () => {
  const now = await f.clock();
  const auction = await f.fixture({ startsAt: new Date(+now - 1000), endsAt: new Date(+now + 250) });
  const { client, pid } = await lock(auction.id);
  try {
    const pending = f.request(`/${auction.id}/cancel`, { method: 'POST', token: f.tokens.owner });
    await waitForBlockedMutation(pid);
    await client.query('SELECT pg_sleep(greatest(0, extract(epoch FROM ($1::timestamptz - clock_timestamp()))) + 0.02)', [auction.endsAt]);
    await client.query('COMMIT');
    const response = await pending;
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'AUCTION_EXPIRED');
  } finally { await client.query('ROLLBACK'); client.release(); }
});
