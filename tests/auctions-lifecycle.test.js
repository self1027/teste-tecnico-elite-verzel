import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lifecycleState } from '../src/modules/auctions/lifecycle.ts';

const startsAt = new Date('2026-10-23T12:00:00.000Z');
const endsAt = new Date('2026-10-23T13:00:00.000Z');
const auction = { status: 'PUBLISHED', startsAt, endsAt };

test('published lifecycle uses an inclusive start and exclusive end at exact millisecond boundaries', () => {
  for (const [now, expected] of [
    [new Date(startsAt.getTime() - 1), 'SCHEDULED'],
    [startsAt, 'LIVE'],
    [new Date(startsAt.getTime() + 1), 'LIVE'],
    [new Date(endsAt.getTime() - 1), 'LIVE'],
    [endsAt, 'FINALIZING'],
    [new Date(endsAt.getTime() + 1), 'FINALIZING'],
  ]) {
    assert.equal(lifecycleState(auction, now), expected);
  }
});

test('administrative terminal states always take precedence over dates', () => {
  for (const status of ['CANCELLED', 'SETTLED', 'CLOSED_NO_BIDS']) {
    for (const now of [new Date(startsAt.getTime() - 1), startsAt, endsAt]) {
      assert.equal(lifecycleState({ ...auction, status }, now), status);
    }
  }
});

test('lifecycle is pure and only uses the explicitly supplied clock', () => {
  const original = structuredClone(auction);
  assert.equal(lifecycleState(auction, new Date('2020-01-01T00:00:00Z')), 'SCHEDULED');
  assert.equal(lifecycleState(auction, new Date('2030-01-01T00:00:00Z')), 'FINALIZING');
  assert.deepEqual(auction, original);
});
