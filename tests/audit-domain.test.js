import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalJson, validateInput, hashEvent, checkChain, bidderReference, GENESIS_HASH } from '../src/modules/audit/domain/cryptography.ts';

const auctionId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-10-24T12:00:00.000Z';
const auction = { productSnapshotId: id, startingBidCents: '1', minIncrementCents: '1', startsAt: timestamp, endsAt: '2026-10-25T12:00:00.000Z', status: 'PUBLISHED', currentBidId: null };
const input = (payload = auction, eventType = 'AUCTION_CREATED') => ({ auctionId, eventType, payload, createdAt: timestamp });
const event = (overrides = {}) => {
  const raw = { ...input(), id, sequence: 1n, hashVersion: 1, previousHash: GENESIS_HASH, ...overrides };
  return { ...raw, eventHash: hashEvent(raw) };
};

test('canonical JSON sorts nested keys and preserves array order', () => {
  assert.equal(canonicalJson({ z: [3, { b: true, a: null }], a: 'ç' }), '{"a":"ç","z":[3,{"a":null,"b":true}]}');
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
});

test('canonical JSON rejects ambiguous or executable values', () => {
  const cycle = {}; cycle.self = cycle;
  const accessor = Object.defineProperty({}, 'a', { enumerable: true, get() { throw new Error('must not execute'); } });
  const symbol = { [Symbol('hidden')]: 1 };
  const sparse = [1, 2]; delete sparse[0];
  for (const value of [undefined, 1n, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, -0, () => 1, Symbol('x'), new Date(), new Map(), cycle, accessor, symbol, sparse, Object.assign([1], { extra: 2 }), Object.create({ secret: 1 })]) {
    assert.throws(() => canonicalJson(value));
  }
  const shared = { a: 1 };
  assert.equal(canonicalJson([shared, shared]), '[{"a":1},{"a":1}]');
});

test('accepts exactly the public payload for each event type', () => {
  const bidderRef = bidderReference(auctionId, id);
  for (const value of [input(), input(auction, 'AUCTION_UPDATED'), input({ ...auction, status: 'CANCELLED' }, 'AUCTION_CANCELLED'), input({ bidId: id, bidderRef, amountCents: '10', bidSequence: '1', createdAt: timestamp, endsAt: auction.endsAt }, 'BID_ACCEPTED'), input({ settlementId: id, winningBidId: id, ledgerTransactionId: id, amountCents: '10', settledAt: timestamp, receiptHash: 'a'.repeat(64) }, 'AUCTION_SETTLED'), input({}, 'AUCTION_CLOSED_NO_BIDS')]) {
    assert.doesNotThrow(() => validateInput(value));
  }
});

test('rejects unknown fields and PII instead of publishing attacker-controlled payloads', () => {
  for (const payload of [{ ...auction, email: 'private@example.com' }, { ...auction, bidderId: id }, { ...auction, productSnapshotId: 'person@example.com' }, { ...auction, status: 'BOGUS' }, {}, { ...auction, currentBidId: 1 }, { ...auction, minIncrementCents: '0' }]) {
    assert.throws(() => validateInput(input(payload)));
  }
  assert.throws(() => validateInput({ ...input(), email: 'private@example.com' }));
  assert.throws(() => validateInput(input({ email: 'private@example.com' }, 'AUCTION_CLOSED_NO_BIDS')));
  assert.throws(() => validateInput(input({}, 'OTHER')));
});

test('decimal commitments are canonical bounded BIGINT strings', () => {
  for (const startingBidCents of ['0', '01', '-1', '+1', '1.0', '1e3', '', ' 1', '9223372036854775808', 1]) {
    assert.throws(() => validateInput(input({ ...auction, startingBidCents })));
  }
  validateInput(input({ ...auction, startingBidCents: '9223372036854775807' }));
});

test('dates must be real exact UTC timestamps with milliseconds', () => {
  for (const createdAt of ['2026-02-30T12:00:00.000Z', '2026-10-24T12:00:00Z', '2026-10-24T12:00:00.000+00:00', '2026-10-24', timestamp + 'x']) {
    assert.throws(() => validateInput({ ...input(), createdAt }));
    assert.throws(() => validateInput(input({ ...auction, endsAt: createdAt })));
  }
  assert.throws(() => validateInput(input({ ...auction, endsAt: timestamp })));
});

test('hash commits every immutable event field using a versioned domain', () => {
  const first = event();
  assert.match(first.eventHash, /^[a-f0-9]{64}$/);
  assert.notEqual(first.eventHash, createHash('sha256').update(canonicalJson(first.payload)).digest('hex'));
  assert.equal(first.eventHash, event({ payload: Object.fromEntries(Object.entries(auction).reverse()) }).eventHash);
  for (const change of [{ id: auctionId }, { auctionId: id }, { sequence: 2n }, { createdAt: '2026-10-24T12:00:01.000Z' }, { eventType: 'AUCTION_UPDATED' }, { previousHash: 'a'.repeat(64) }, { payload: { ...auction, startingBidCents: '2' } }]) {
    assert.notEqual(first.eventHash, event(change).eventHash);
  }
  for (const change of [{ hashVersion: 0 }, { sequence: 0n }, { sequence: 9223372036854775808n }, { sequence: '1' }, { id: 'invalid' }, { previousHash: 'x'.repeat(64) }]) {
    assert.throws(() => event(change));
  }
});

test('chain validates genesis, contiguous sequence, identity and immutable hashes', () => {
  const first = event();
  const second = event({ id: auctionId, sequence: 2n, previousHash: first.eventHash, eventType: 'AUCTION_UPDATED' });
  assert.deepEqual(checkChain(auctionId, [first, second]), { valid: true, reason: null });
  assert.deepEqual(checkChain(auctionId, []), { valid: true, reason: null });
  for (const events of [[second], [first, first], [second, first], [first, { ...second, sequence: 3n }], [{ ...first, auctionId: id }], [{ ...first, id: auctionId }], [{ ...first, hashVersion: 0 }], [{ ...first, payload: { ...auction, email: 'pii' } }], [{ ...first, previousHash: 'a'.repeat(64) }], [{ ...first, eventHash: 'a'.repeat(64) }], [first, { ...second, id: first.id }]]) {
    const result = checkChain(auctionId, events);
    assert.equal(result.valid, false);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length);
  }
});

test('bidder references are deterministic, domain separated and scoped to the auction', () => {
  const reference = bidderReference(auctionId, id);
  assert.match(reference, /^[a-f0-9]{64}$/);
  assert.equal(reference, bidderReference(auctionId, id));
  assert.notEqual(reference, bidderReference(id, id));
  assert.notEqual(reference, bidderReference(auctionId, auctionId));
  assert.notEqual(reference, createHash('sha256').update(auctionId + id).digest('hex'));
  assert.throws(() => bidderReference(auctionId, 'private@example.com'));
});
