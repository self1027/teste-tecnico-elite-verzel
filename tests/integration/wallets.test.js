import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { after, before, beforeEach, test } from 'node:test';
import { seed } from '../../src/shared/database/seed.ts';
import { createAuthModule } from '../../src/modules/auth/index.ts';
import { createApp } from '../../src/app.ts';
import { createWalletModule } from '../../src/modules/wallets/index.ts';
import { DrizzleWalletRepository } from '../../src/modules/wallets/repositories/drizzle-wallet-repository.ts';
import { WalletService } from '../../src/modules/wallets/services/wallet-service.ts';
import { DrizzleLedgerRepository } from '../../src/modules/ledger/repositories/drizzle-ledger-repository.ts';
import { isolatedDatabase, seedConfig } from '../helpers/database.js';
import { serve } from '../helpers/http.js';

let database, http, tokens, users;
before(async () => {
  database = await isolatedDatabase();
  await seed(database.db, seedConfig);
  const auth = await createAuthModule(database.db, { jwtSecret: 'wallet-test-secret-at-least-thirty-two-bytes', jwtExpiresInSeconds: 900 });
  http = await serve(createApp(auth.router, undefined, undefined, createWalletModule(database.db, auth.authenticate)));
  tokens = {};
  users = {};
  for (const [name, password] of [['bidder1', seedConfig.bidder1Password], ['bidder2', seedConfig.bidder2Password], ['auctioneer', seedConfig.auctioneerPassword]]) {
    const response = await fetch(`${http.url}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${name}@verzel.local`, password }) });
    const login = await response.json();
    tokens[name] = login.accessToken;
    users[name] = (await database.pool.query('SELECT id FROM users WHERE email=$1', [`${name}@verzel.local`])).rows[0].id;
  }
});
beforeEach(async () => {
  await database.pool.query('DELETE FROM ledger_entries; DELETE FROM ledger_transactions; UPDATE wallets SET balance_cents=0, reserved_cents=0');
});
after(async () => { await http?.close(); await database?.close(); });
function request(path = '', { token = tokens.bidder1, method = 'GET', body, key } = {}) {
  return fetch(`${http.url}/wallet${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key === undefined ? {} : { 'Idempotency-Key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function deposit(amountCents = '10000', key = 'deposit-1', token = tokens.bidder1) {
  return request('/deposits', { method: 'POST', token, key, body: { amountCents } });
}
async function balances() { return (await (await request()).json()).wallet; }

test('wallet query is authenticated and returns canonical zero balances for either role', async () => {
  assert.equal((await request('', { token: null })).status, 401);
  assert.equal((await request('', { token: 'invalid' })).status, 401);
  for (const token of [tokens.bidder1, tokens.auctioneer]) {
    const response = await request('', { token });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { wallet: { balanceCents: '0', reservedCents: '0', availableCents: '0' } });
  }
});

test('BIDDER deposit atomically credits the wallet and creates two balanced entries', async () => {
  const response = await deposit();
  assert.equal(response.status, 201);
  const { deposit: receipt } = await response.json();
  assert.equal(receipt.amountCents, '10000');
  assert.ok(receipt.transactionId && receipt.createdAt);
  assert.deepEqual(await balances(), { balanceCents: '10000', reservedCents: '0', availableCents: '10000' });
  const rows = await database.pool.query('SELECT a.type, e.amount_cents FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id ORDER BY e.amount_cents');
  assert.deepEqual(rows.rows, [{ type: 'SIMULATION_CLEARING', amount_cents: '-10000' }, { type: 'USER_WALLET', amount_cents: '10000' }]);
  assert.equal((await database.pool.query('SELECT sum(amount_cents)::text AS sum FROM ledger_entries')).rows[0].sum, '0');
});

test('only BIDDER can deposit and client identity and internal fields are rejected', async () => {
  assert.equal((await deposit('10', 'x', tokens.auctioneer)).status, 403);
  assert.equal((await deposit('10', 'x', null)).status, 401);
  for (const field of ['userId', 'walletId', 'balanceCents', 'role', 'transactionId']) {
    assert.equal((await request('/deposits', { method: 'POST', key: 'extra', body: { amountCents: '1', [field]: users.bidder2 } })).status, 400);
  }
  assert.equal((await database.pool.query('SELECT count(*) FROM ledger_transactions')).rows[0].count, '0');
});

test('deposit rejects invalid money, malformed keys and values above BIGINT', async () => {
  for (const amount of [1, 0, null, true, '', '0', '-1', '01', '+1', ' 1', '1.1', '1e2', '9223372036854775808']) {
    assert.equal((await deposit(amount)).status, 400, String(amount));
  }
  for (const key of [undefined, '', 'with spaces', 'a,b', 'x'.repeat(129)]) {
    assert.equal((await request('/deposits', { method: 'POST', key, body: { amountCents: '1' } })).status, 400);
  }
  assert.equal((await deposit('9223372036854775807')).status, 201);
  assert.equal((await balances()).balanceCents, '9223372036854775807');
  const overflow = await deposit('1', 'overflow');
  assert.equal(overflow.status, 409);
  assert.equal((await balances()).balanceCents, '9223372036854775807');
});

test('sequential idempotency returns the original receipt after other deposits and conflicts on changed amount', async () => {
  const original = await (await deposit('9007199254740993')).json();
  assert.equal((await deposit('7', 'other')).status, 201);
  const retry = await deposit('9007199254740993');
  assert.equal(retry.status, 201);
  assert.deepEqual(await retry.json(), original);
  assert.equal((await deposit('8')).status, 409);
  assert.equal((await balances()).balanceCents, '9007199254741000');
});

test('concurrent same-key deposits credit once, while distinct keys do not lose updates', async () => {
  const repeated = await Promise.all(Array.from({ length: 10 }, () => deposit('15', 'same')));
  const receipts = await Promise.all(repeated.map(async (response) => { assert.equal(response.status, 201); return response.json(); }));
  receipts.forEach((receipt) => assert.deepEqual(receipt, receipts[0]));
  const distinct = await Promise.all(Array.from({ length: 10 }, (_, index) => deposit('20', `unique-${index}`)));
  distinct.forEach((response) => assert.equal(response.status, 201));
  assert.equal((await balances()).balanceCents, '215');
  assert.equal((await database.pool.query('SELECT count(*) FROM ledger_entries')).rows[0].count, '22');
});

test('concurrent same key with different amounts has one success and one conflict', async () => {
  const results = await Promise.all([deposit('5', 'race'), deposit('6', 'race')]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.ok(['5', '6'].includes((await balances()).balanceCents));
});

test('same client key is independent across users and history exposes only own entries', async () => {
  await deposit('11', 'shared');
  await deposit('22', 'shared', tokens.bidder2);
  await deposit('33', 'third');
  const response = await request('/transactions?limit=1&skip=1');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.total, 2);
  assert.equal(body.transactions.length, 1);
  assert.equal(body.transactions[0].amountCents, '11');
  assert.deepEqual(body.transactions[0].entries.map((entry) => entry.amountCents), ['11']);
  const serialized = JSON.stringify(body);
  for (const secret of ['password', 'email', users.bidder2, 'SIMULATION_CLEARING', 'idempotencyKey']) assert.ok(!serialized.includes(secret));
  for (const query of ['limit=0', 'limit=101', 'skip=-1', 'userId=other', 'limit=1&limit=2']) assert.equal((await request(`/transactions?${query}`)).status, 400);
  assert.equal((await request('/transactions', { token: null })).status, 401);
});

test('a ledger insertion failure rolls back credit, transaction and both entries and permits retry', async () => {
  await database.pool.query("CREATE FUNCTION reject_entry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.amount_cents < 0 THEN RAISE EXCEPTION 'secret postgres failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_entry BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION reject_entry()");
  try {
    const failed = await deposit();
    assert.equal(failed.status, 500);
    assert.ok(!(await failed.text()).includes('secret postgres'));
    assert.equal((await balances()).balanceCents, '0');
    assert.equal((await database.pool.query('SELECT count(*) FROM ledger_transactions')).rows[0].count, '0');
    assert.equal((await database.pool.query('SELECT count(*) FROM ledger_entries')).rows[0].count, '0');
  } finally { await database.pool.query('DROP TRIGGER reject_entry ON ledger_entries; DROP FUNCTION reject_entry()'); }
  assert.equal((await deposit()).status, 201);
});

test('available balance excludes reserves and invalid stored invariants prevent credits', async () => {
  await deposit('100');
  await database.pool.query('UPDATE wallets SET reserved_cents=40 WHERE user_id=$1', [users.bidder1]);
  assert.deepEqual(await balances(), { balanceCents: '100', reservedCents: '40', availableCents: '60' });
  for (const [balance, reserved] of [['-1', '0'], ['100', '-1'], ['100', '101']]) {
    await database.pool.query('UPDATE wallets SET balance_cents=$1, reserved_cents=$2 WHERE user_id=$3', [balance, reserved, users.bidder1]);
    assert.equal((await request()).status, 409);
    assert.equal((await deposit('1', 'invalid-state')).status, 409);
  }
  assert.equal((await database.pool.query('SELECT count(*) FROM ledger_transactions')).rows[0].count, '1');
});

test('missing zero wallet and account are provisioned idempotently under concurrent requests', async () => {
  await database.pool.query('DELETE FROM ledger_accounts WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id=$1)', [users.bidder1]);
  await database.pool.query('DELETE FROM wallets WHERE user_id=$1', [users.bidder1]);
  const responses = await Promise.all(Array.from({ length: 6 }, () => request()));
  responses.forEach((response) => assert.equal(response.status, 200));
  assert.equal((await database.pool.query('SELECT count(*) FROM wallets WHERE user_id=$1', [users.bidder1])).rows[0].count, '1');
  assert.equal((await database.pool.query('SELECT count(*) FROM ledger_accounts a JOIN wallets w ON w.id=a.wallet_id WHERE w.user_id=$1', [users.bidder1])).rows[0].count, '1');
});

test('reconciliation compares ledger with total balance, ignores reserves and reports divergence without fixing it', async () => {
  const service = new WalletService(new DrizzleWalletRepository(database.db));
  await deposit('100');
  await database.pool.query('UPDATE wallets SET reserved_cents=30 WHERE user_id=$1', [users.bidder1]);
  let result = await service.reconcile(users.bidder1);
  assert.equal(result.consistent, true);
  assert.equal(result.ledgerBalanceCents, '100');
  await database.pool.query('UPDATE wallets SET balance_cents=101 WHERE user_id=$1', [users.bidder1]);
  result = await service.reconcile(users.bidder1);
  assert.equal(result.consistent, false);
  assert.equal(result.differenceCents, '1');
  assert.equal((await balances()).balanceCents, '101');
});

test('idempotency survives new service instances and retains the original receipt at maximum balance', async () => {
  const original = (await (await deposit('9223372036854775807')).json()).deposit;
  const service = new WalletService(new DrizzleWalletRepository(database.db));
  const receipt = await service.deposit(users.bidder1, 9223372036854775807n, 'deposit-1');
  assert.deepEqual(JSON.parse(JSON.stringify(receipt)), original);
  assert.equal((await database.pool.query('SELECT count(*) FROM ledger_transactions')).rows[0].count, '1');
});

test('simultaneous deposits close to BIGINT limit allow only the credit that fits', async () => {
  await deposit('9223372036854775806');
  const results = await Promise.all([deposit('1', 'last-1'), deposit('1', 'last-2')]);
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 409]);
  assert.equal((await balances()).balanceCents, '9223372036854775807');
});

test('balance update failure rolls back already inserted ledger records', async () => {
  await database.pool.query("CREATE FUNCTION reject_credit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'secret credit failure'; END $$; CREATE TRIGGER reject_credit BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION reject_credit()");
  try {
    const response = await deposit();
    assert.equal(response.status, 500);
    assert.ok(!(await response.text()).includes('secret credit'));
    assert.equal((await balances()).balanceCents, '0');
    assert.equal((await database.pool.query('SELECT count(*) FROM ledger_transactions')).rows[0].count, '0');
    assert.equal((await database.pool.query('SELECT count(*) FROM ledger_entries')).rows[0].count, '0');
  } finally { await database.pool.query('DROP TRIGGER reject_credit ON wallets; DROP FUNCTION reject_credit()'); }
});

test('missing or ambiguous clearing accounts reject deposits without leaving partial credits', async () => {
  await database.pool.query("INSERT INTO ledger_accounts (id,type,created_at) VALUES (gen_random_uuid(),'SIMULATION_CLEARING',now())");
  assert.equal((await deposit()).status, 409);
  await database.pool.query("DELETE FROM ledger_accounts WHERE type='SIMULATION_CLEARING'");
  assert.equal((await deposit()).status, 409);
  assert.equal((await balances()).balanceCents, '0');
  assert.equal((await database.pool.query('SELECT count(*) FROM ledger_transactions')).rows[0].count, '0');
  await database.pool.query("INSERT INTO ledger_accounts (id,type,created_at) VALUES (gen_random_uuid(),'SIMULATION_CLEARING',now())");
});

test('a missing account on a funded wallet is reported without hiding the accounting problem', async () => {
  await database.pool.query('DELETE FROM ledger_accounts WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id=$1)', [users.bidder1]);
  await database.pool.query('UPDATE wallets SET balance_cents=50 WHERE user_id=$1', [users.bidder1]);
  assert.equal((await request()).status, 409);
  assert.equal((await deposit()).status, 409);
  assert.equal((await database.pool.query('SELECT count(*) FROM ledger_accounts a JOIN wallets w ON a.wallet_id=w.id WHERE w.user_id=$1', [users.bidder1])).rows[0].count, '0');
});

test('ledger writer cannot persist unbalanced entries, even inside a caller-owned transaction', async () => {
  await assert.rejects(database.db.transaction(async (tx) => {
    const account = (await database.pool.query('SELECT id FROM ledger_accounts LIMIT 1')).rows[0].id;
    await new DrizzleLedgerRepository(tx).append({ id: randomUUID(), type: 'DEPOSIT', idempotencyKey: 'bad-ledger', createdAt: new Date() }, [{ accountId: account, amountCents: 1n }, { accountId: account, amountCents: -2n }]);
  }), { code: 'UNBALANCED_LEDGER' });
  assert.equal((await database.pool.query('SELECT count(*) FROM ledger_transactions')).rows[0].count, '0');
});

test('history orders timestamp ties by transaction UUID before applying pagination', async () => {
  for (const key of ['tie-1', 'tie-2', 'tie-3']) await deposit('1', key);
  await database.pool.query("UPDATE ledger_transactions SET created_at='2026-01-01 00:00:00'");
  const ordered = (await database.pool.query('SELECT id FROM ledger_transactions ORDER BY id ASC')).rows;
  const page = await (await request('/transactions?limit=1&skip=1')).json();
  assert.equal(page.total, 3);
  assert.equal(page.transactions[0].id, ordered[1].id);
});

test('duplicate idempotency headers are rejected instead of selecting an arbitrary key', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(`${http.url}/wallet/deposits`, { method: 'POST', headers: {
      authorization: `Bearer ${tokens.bidder1}`, 'content-type': 'application/json', 'Idempotency-Key': ['first', 'second'],
    } }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    req.on('error', reject);
    req.end(JSON.stringify({ amountCents: '1' }));
  });
  assert.equal(status, 400);
  assert.equal((await balances()).balanceCents, '0');
});

test('reconciliation waits for the wallet lock and observes a concurrent credit and its ledger together', async () => {
  const client = await database.pool.connect();
  let pending;
  try {
    await client.query('BEGIN');
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const row = (await client.query('SELECT w.id, a.id AS account_id FROM wallets w JOIN ledger_accounts a ON a.wallet_id=w.id WHERE w.user_id=$1 FOR UPDATE OF w', [users.bidder1])).rows[0];
    await client.query('UPDATE wallets SET balance_cents=7 WHERE id=$1', [row.id]);
    const transactionId = randomUUID();
    await client.query("INSERT INTO ledger_transactions (id,type,idempotency_key,created_at) VALUES ($1,'DEPOSIT','locked-credit',now())", [transactionId]);
    const clearingId = (await client.query("SELECT id FROM ledger_accounts WHERE type='SIMULATION_CLEARING'")).rows[0].id;
    await client.query('INSERT INTO ledger_entries (id,transaction_id,account_id,amount_cents,created_at) VALUES ($1,$2,$3,7,now()),($4,$2,$5,-7,now())', [randomUUID(), transactionId, row.account_id, randomUUID(), clearingId]);
    pending = new WalletService(new DrizzleWalletRepository(database.db)).reconcile(users.bidder1);
    let blocked = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = await database.pool.query('SELECT count(*) FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))', [pid]);
      if (result.rows[0].count !== '0') { blocked = true; break; }
      await setTimeout(20);
    }
    assert.ok(blocked, 'Reconciliation must wait for the wallet row lock');
    await client.query('COMMIT');
    const result = await pending;
    assert.equal(result.consistent, true);
    assert.equal(result.balanceCents, '7');
    assert.equal(result.ledgerBalanceCents, '7');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pending;
  }
});
