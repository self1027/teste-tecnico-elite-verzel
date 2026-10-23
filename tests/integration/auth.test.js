import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import express from 'express';
import { decodeJwt, SignJWT } from 'jose';
import { isolatedDatabase, seedConfig } from '../helpers/database.js';
import { seed } from '../../src/shared/database/seed.ts';
import { createApp } from '../../src/app.ts';
import { createAuthModule } from '../../src/modules/auth/index.ts';
import { authorize } from '../../src/modules/auth/middleware/authorization.ts';
import { errorHandler } from '../../src/shared/http/error-handler.ts';

const config = { jwtSecret: 'test-only-secret-with-more-than-32-bytes-1234567890', jwtExpiresInSeconds: 900 };
let database;
let server;
let baseURL;
before(async () => {
  database = await isolatedDatabase();
  await seed(database.db, seedConfig);
  const auth = await createAuthModule(database.db, config);
  const app = express();
  for (const [path, role] of [['/auctioneer-only', 'AUCTIONEER'], ['/bidder-only', 'BIDDER']]) {
    app.get(path, auth.authenticate, authorize(role), (_request, response) => response.json({ ok: true }));
  }
  app.get('/missing-auth-middleware', authorize('AUCTIONEER'), (_request, response) => response.json({ ok: true }));
  app.get('/internal-error', () => { throw new Error('secret database password_hash information'); });
  app.use(createApp(auth.router));
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseURL = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) {
    const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  }
  await database?.close();
});

async function login(email = 'auctioneer@verzel.local', password = seedConfig.auctioneerPassword, extra = {}) {
  return fetch(`${baseURL}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, ...extra }),
  });
}
async function signedToken(subject, expiresIn = 60, extra = {}, secret = config.jwtSecret, algorithm = 'HS256') {
  return new SignJWT(extra).setProtectedHeader({ alg: algorithm, typ: 'JWT' })
    .setSubject(subject).setIssuer('verzel-auction-house').setAudience('verzel-api')
    .setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
    .sign(new TextEncoder().encode(secret));
}
function onlyPublicUser(user) {
  assert.deepEqual(Object.keys(user).sort(), ['displayName', 'email', 'id', 'role']);
}

test('valid login normalizes email, issues expiring JWT and exposes only public fields', async () => {
  const response = await login('  AUCTIONEER@VERZEL.LOCAL ');
  assert.equal(response.status, 200);
  const result = await response.json();
  onlyPublicUser(result.user);
  assert.equal(result.user.role, 'AUCTIONEER');
  assert.equal(result.expiresIn, 900);
  assert.equal(result.tokenType, 'Bearer');
  const claims = decodeJwt(result.accessToken);
  assert.equal(claims.sub, result.user.id);
  assert.equal(claims.exp - claims.iat, 900);
  assert.deepEqual(Object.keys(claims).sort(), ['aud', 'exp', 'iat', 'iss', 'sub']);
  const me = await fetch(`${baseURL}/auth/me`, { headers: { authorization: `Bearer ${result.accessToken}` } });
  assert.equal(me.status, 200);
  const identity = await me.json();
  onlyPublicUser(identity.user);
  assert.deepEqual(identity.user, result.user);
});

test('wrong password and unknown email return the same generic credentials error', async () => {
  const wrong = await login('auctioneer@verzel.local', 'incorrect-password');
  const unknown = await login('unknown@verzel.local');
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json());
});

test('Zod rejects malformed inputs and injected identity/role without echoing sensitive values', async () => {
  for (const [email, password, extra] of [
    ['invalid', 'private-password', {}],
    ['auctioneer@verzel.local', '', {}],
    ['auctioneer@verzel.local', seedConfig.auctioneerPassword, { role: 'AUCTIONEER', userId: randomUUID() }],
    ['auctioneer@verzel.local', 12345, {}],
  ]) {
    const response = await login(email, password, extra);
    assert.equal(response.status, 400);
    const result = await response.text();
    assert.ok(!result.includes(seedConfig.auctioneerPassword));
    assert.ok(!result.includes('private-password'));
    assert.equal(JSON.parse(result).error.code, 'VALIDATION_ERROR');
  }
});

test('missing, malformed, forged, expired and wrong-algorithm tokens return 401', async () => {
  const { user } = await (await login()).json();
  const tokens = [undefined, 'invalid', await signedToken(user.id, -1),
    await signedToken(user.id, 60, {}, 'different-secret-with-more-than-32-bytes'),
    await signedToken(user.id, 60, {}, config.jwtSecret, 'HS384'),
    await signedToken(randomUUID()), await signedToken('not-a-uuid')];
  for (const token of tokens) {
    const response = await fetch(`${baseURL}/auth/me`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'UNAUTHENTICATED');
  }
  const basic = await fetch(`${baseURL}/auth/me`, { headers: { authorization: 'Basic credentials' } });
  assert.equal(basic.status, 401);
});

test('authorization accepts each allowed role and denies the other, ignoring injected headers and token role', async () => {
  for (const [email, password, allowed, denied] of [
    ['auctioneer@verzel.local', seedConfig.auctioneerPassword, '/auctioneer-only', '/bidder-only'],
    ['bidder1@verzel.local', seedConfig.bidder1Password, '/bidder-only', '/auctioneer-only'],
    ['bidder2@verzel.local', seedConfig.bidder2Password, '/bidder-only', '/auctioneer-only'],
  ]) {
    const { accessToken, user } = await (await login(email, password)).json();
    assert.equal((await fetch(`${baseURL}${allowed}`, { headers: { authorization: `Bearer ${accessToken}` } })).status, 200);
    const response = await fetch(`${baseURL}${denied}`, { headers: { authorization: `Bearer ${accessToken}`, 'x-user-role': 'AUCTIONEER', 'x-user-id': randomUUID() } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'FORBIDDEN');
    if (user.role === 'BIDDER') {
      const forgedRole = await signedToken(user.id, 60, { role: 'AUCTIONEER' });
      assert.equal((await fetch(`${baseURL}/auctioneer-only`, { headers: { authorization: `Bearer ${forgedRole}` } })).status, 403);
    }
  }
  assert.equal((await fetch(`${baseURL}/auctioneer-only`)).status, 401);
  assert.equal((await fetch(`${baseURL}/missing-auth-middleware`)).status, 401);
});

test('role changes take effect immediately and removed identities cannot authenticate', async () => {
  const { accessToken, user } = await (await login('bidder1@verzel.local', seedConfig.bidder1Password)).json();
  try {
    await database.pool.query("UPDATE users SET role = 'AUCTIONEER' WHERE id = $1", [user.id]);
    const headers = { authorization: `Bearer ${accessToken}` };
    assert.equal((await fetch(`${baseURL}/auctioneer-only`, { headers })).status, 200);
    assert.equal((await fetch(`${baseURL}/bidder-only`, { headers })).status, 403);
  } finally {
    await database.pool.query("UPDATE users SET role = 'BIDDER' WHERE id = $1", [user.id]);
  }
  const removedId = randomUUID();
  await database.pool.query("INSERT INTO users SELECT $1, $2, password_hash, 'Temporary', role, now(), now() FROM users WHERE id = $3", [removedId, `${removedId}@test.invalid`, user.id]);
  const headers = { authorization: `Bearer ${await signedToken(removedId)}` };
  assert.equal((await fetch(`${baseURL}/auth/me`, { headers })).status, 200);
  await database.pool.query('DELETE FROM users WHERE id = $1', [removedId]);
  assert.equal((await fetch(`${baseURL}/auth/me`, { headers })).status, 401);
});

test('malformed JSON, oversized payloads, unknown routes and internal errors use sanitized errors', async () => {
  const malformed = await fetch(`${baseURL}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"secret"' });
  assert.equal(malformed.status, 400);
  assert.ok(!(await malformed.text()).includes('secret'));
  const large = await login('auctioneer@verzel.local', 'x'.repeat(20000));
  assert.equal(large.status, 413);
  const missing = await fetch(`${baseURL}/not-a-route`);
  assert.equal(missing.status, 404);
  const internal = await fetch(`${baseURL}/internal-error`);
  assert.equal(internal.status, 500);
  assert.deepEqual(await internal.json(), { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
});
