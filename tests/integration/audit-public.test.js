import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Router } from 'express';
import { auctionFixture } from '../helpers/auctions.js';
import { serve } from '../helpers/http.js';
import { createApp } from '../../src/app.ts';

let fixture, http;
before(async () => { fixture = await auctionFixture(); });
after(async () => { await http?.close(); await fixture?.close(); });

test('public audit is mounted without authentication and explicitly reports missing external proof', async () => {
  const { createAuditModule } = await import('../../src/modules/audit/index.ts');
  const { auction } = await (await fixture.request('', { method: 'POST', token: fixture.tokens.owner, body: await fixture.payload() })).json();
  const audit = createAuditModule(fixture.db);
  http = await serve(createApp(Router(), undefined, undefined, undefined, audit.router));
  const response = await fetch(`${http.url}/auctions/${auction.id}/audit`);
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(result.status, 'VERIFICATION_UNAVAILABLE');
  assert.equal(result.localSequence, '1');
  const page = await (await fetch(`${http.url}/auctions/${auction.id}/audit/events?limit=1`)).json();
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].eventType, 'AUCTION_CREATED');
  assert.equal(page.events[0].sequence, '1');
  assert.equal((await fetch(`${http.url}/auctions/${auction.id}/audit?extra=1`)).status, 400);
  assert.equal((await fetch(`${http.url}/auctions/${auction.id}/audit/events?limit=101`)).status, 400);
});

test('public event pages do not reflect PII injected through hash metadata', async () => {
  const { auction } = await (await fixture.request('', { method: 'POST', token: fixture.tokens.owner, body: await fixture.payload() })).json();
  await fixture.pool.query('UPDATE audit_events SET event_hash=$1 WHERE auction_id=$2', ['private@example.com', auction.id]);
  const response = await fetch(`${http.url}/auctions/${auction.id}/audit/events`);
  const body = await response.json();
  assert.equal(body.status, 'TAMPERED');
  assert.deepEqual(body.events, []);
  assert.ok(!JSON.stringify(body).includes('private@example.com'));
});

test('SQL microsecond timestamp changes are detected before Date truncates their precision', async () => {
  const { auction } = await (await fixture.request('', { method: 'POST', token: fixture.tokens.owner, body: await fixture.payload() })).json();
  await fixture.pool.query("UPDATE audit_events SET created_at=created_at+interval '1 microsecond' WHERE auction_id=$1", [auction.id]);
  const result = await (await fetch(`${http.url}/auctions/${auction.id}/audit`)).json();
  assert.equal(result.status, 'TAMPERED');
  const page = await (await fetch(`${http.url}/auctions/${auction.id}/audit/events`)).json();
  assert.equal(page.status, 'TAMPERED');
  assert.deepEqual(page.events, []);
});
