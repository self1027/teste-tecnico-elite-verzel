import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AuditVerifier, inspectSnapshot } from '../src/modules/audit/services/audit-verifier.ts';
import { checkOperational } from '../src/modules/audit/services/operational-integrity.ts';
import { bidderReference, hashEvent, GENESIS_HASH } from '../src/modules/audit/domain/cryptography.ts';

const auctionId = '11111111-1111-4111-8111-111111111111';
const timestamp = '2026-10-24T12:00:00.000Z';
const later = '2026-10-24T13:00:00.000Z';
const auction = { productSnapshotId: randomUUID(), startingBidCents: '100', minIncrementCents: '10', startsAt: timestamp, endsAt: later, status: 'PUBLISHED', currentBidId: null };
function append(events, eventType, payload, createdAt = timestamp) {
  const unsigned = { id: randomUUID(), auctionId, sequence: BigInt(events.length + 1), eventType, payload, createdAt, previousHash: events.at(-1)?.eventHash ?? GENESIS_HASH, hashVersion: 1 };
  return [...events, { ...unsigned, eventHash: hashEvent(unsigned) }];
}
const initial = () => ({ auctionId, events: append([], 'AUCTION_CREATED', { ...auction }), operational: { auction: { ...auction }, bids: [], settlement: null } });

test('replay rejects updates after start and cancellation after end even with consistent hashes', () => {
  for (const [eventType, at, status] of [
    ['AUCTION_UPDATED', '2026-10-24T12:30:00.000Z', 'PUBLISHED'],
    ['AUCTION_CANCELLED', '2026-10-24T13:30:00.000Z', 'CANCELLED'],
  ]) {
    const snapshot = initial();
    const next = { ...auction, startingBidCents: '999', status };
    snapshot.events = append(snapshot.events, eventType, next, at);
    snapshot.operational.auction = next;
    assert.equal(checkOperational(snapshot).consistent, false);
  }
});
const anchored = (snapshot, index = snapshot.events.length - 1) => ({ auctionId, sequence: String(snapshot.events[index].sequence), hash: snapshot.events[index].eventHash, namespace: 'test', previousSequence: '0', previousHash: GENESIS_HASH, reference: 'signed-ref', publishedAt: timestamp, signature: 'verified-by-provider' });
const verify = (snapshot, anchor, unavailable = false) => new AuditVerifier({ snapshot: async () => snapshot }, { latest: async () => { if (unavailable) throw new Error('witness offline private token'); return anchor; } }).verify(auctionId);
function withBid(snapshot, amountCents = '100', endsAt = later) {
  const bid = { bidId: randomUUID(), bidderRef: bidderReference(auctionId, randomUUID()), amountCents, bidSequence: String(snapshot.operational.bids.length + 1), createdAt: timestamp };
  return { auctionId, events: append(snapshot.events, 'BID_ACCEPTED', { ...bid, endsAt }), operational: { ...snapshot.operational, auction: { ...snapshot.operational.auction, currentBidId: bid.bidId, endsAt }, bids: [...snapshot.operational.bids, bid] } };
}

test('verification never endorses unanchored history or replaces an unavailable witness', async () => {
  const id = randomUUID();
  const snapshot = { auctionId: id, events: [], operational: { auction: {}, bids: [], settlement: null } };
  const repository = { snapshot: async () => snapshot };
  const pending = await new AuditVerifier(repository, { latest: async () => null }).verify(id);
  assert.equal(pending.status, 'PENDING_ANCHOR');
  assert.equal(pending.operationalCoverage, 'NOT_RECORDED');
  assert.equal(pending.externallyVerifiedSequence, '0');
  const unavailable = await new AuditVerifier(repository, { latest: async () => { throw new Error('connection'); } }).verify(id);
  assert.equal(unavailable.status, 'VERIFICATION_UNAVAILABLE');
  assert.equal(unavailable.externallyVerifiedSequence, '0');
});

test('complete matching operational history is VERIFIED only at the external head', async () => {
  const snapshot = withBid(initial());
  const result = await verify(snapshot, anchored(snapshot));
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.operationalCoverage, 'CONSISTENT');
  assert.equal(result.localSequence, '2');
  assert.equal(result.externallyVerifiedSequence, '2');
  const prefix = await verify(snapshot, anchored(snapshot, 0));
  assert.equal(prefix.status, 'PENDING_ANCHOR');
  assert.equal(prefix.localSequence, '2');
  assert.equal(prefix.externallyVerifiedSequence, '1');
});

test('deleting an anchored tail or rewriting every hash cannot erase the independent commitment', async () => {
  const snapshot = withBid(initial());
  const remote = anchored(snapshot);
  const truncated = initial();
  truncated.events = snapshot.events.slice(0, 1);
  assert.equal((await verify(truncated, remote)).status, 'TAMPERED');
  const rewritten = initial();
  rewritten.operational.auction.startingBidCents = '999';
  rewritten.events = append([], 'AUCTION_CREATED', rewritten.operational.auction);
  assert.equal(inspectSnapshot(rewritten, null).status, 'PENDING_ANCHOR');
  const result = await verify(rewritten, anchored(snapshot, 0));
  assert.equal(result.status, 'TAMPERED');
  assert.equal(result.reason, 'EXTERNAL_ANCHOR_MISMATCH');
  assert.equal(result.externallyVerifiedSequence, '0');
});

test('a missing auction with a surviving external anchor reports tampering', async () => {
  const result = await verify(null, anchored(initial()));
  assert.equal(result.status, 'TAMPERED');
  assert.equal(result.reason, 'ANCHORED_AUCTION_MISSING');
});

test('local corruption remains TAMPERED when the independent witness is unavailable', async () => {
  const snapshot = initial();
  snapshot.events[0].eventHash = 'a'.repeat(64);
  const result = await verify(snapshot, null, true);
  assert.equal(result.status, 'TAMPERED');
  assert.equal(result.externallyVerifiedSequence, '0');
});

test('verification does not reflect hostile PII from stored JSON or provider errors', async () => {
  const snapshot = initial();
  snapshot.events[0].payload.email = 'private@example.com';
  const result = await verify(snapshot, null, true);
  assert.equal(result.status, 'TAMPERED');
  const output = JSON.stringify(result);
  assert.equal(output.includes('private@example.com'), false);
  assert.equal(output.includes('private token'), false);
  assert.equal(Object.hasOwn(result, 'events'), false);
});

test('replay compares every operational bid and auction field', () => {
  const snapshot = withBid(initial());
  assert.deepEqual(checkOperational(snapshot), { consistent: true, recorded: true, reason: null });
  for (const mutate of [value => { value.operational.auction.minIncrementCents = '11'; }, value => { value.operational.bids[0].amountCents = '101'; }, value => { value.operational.bids = []; }, value => { value.operational.bids.push({ ...value.operational.bids[0], bidId: randomUUID() }); }]) {
    const changed = structuredClone(snapshot); mutate(changed);
    assert.equal(checkOperational(changed).consistent, false);
    assert.equal(inspectSnapshot(changed, anchored(snapshot)).status, 'TAMPERED');
  }
});

test('valid hashes cannot make impossible bids or terminal transitions pass replay', () => {
  const snapshot = withBid(initial(), '99');
  assert.equal(checkOperational(snapshot).consistent, false);
  const accepted = withBid(initial());
  const repeated = withBid(accepted, '110');
  repeated.events[2].payload.bidderRef = repeated.events[1].payload.bidderRef;
  const { eventHash: ignored, ...unsigned } = repeated.events[2];
  assert.ok(ignored);
  repeated.events[2].eventHash = hashEvent(unsigned);
  assert.equal(checkOperational(repeated).consistent, false);
  const earlyClose = initial();
  earlyClose.events = append(earlyClose.events, 'AUCTION_CLOSED_NO_BIDS', {});
  earlyClose.operational.auction.status = 'CLOSED_NO_BIDS';
  assert.equal(checkOperational(earlyClose).consistent, false);
});

test('replay includes settlement and no-bid closure commitments', () => {
  const snapshot = withBid(initial());
  const settlement = { settlementId: randomUUID(), winningBidId: snapshot.operational.bids[0].bidId, ledgerTransactionId: randomUUID(), amountCents: '100', settledAt: later, receiptHash: 'b'.repeat(64) };
  snapshot.events = append(snapshot.events, 'AUCTION_SETTLED', settlement, later);
  snapshot.operational.settlement = settlement;
  snapshot.operational.auction.status = 'SETTLED';
  assert.equal(inspectSnapshot(snapshot, anchored(snapshot)).status, 'VERIFIED');
  snapshot.operational.settlement = { ...settlement, receiptHash: 'c'.repeat(64) };
  assert.equal(inspectSnapshot(snapshot, anchored(snapshot)).status, 'TAMPERED');
  const closed = initial();
  closed.events = append(closed.events, 'AUCTION_CLOSED_NO_BIDS', {}, later);
  closed.operational.auction.status = 'CLOSED_NO_BIDS';
  assert.equal(inspectSnapshot(closed, anchored(closed)).status, 'VERIFIED');
});
