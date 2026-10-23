import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { verify } from 'argon2';
import { eq } from 'drizzle-orm';
import { isolatedDatabase, seedConfig } from '../helpers/database.js';
import { seed } from '../../src/shared/database/seed.ts';
import { users, wallets, ledgerAccounts } from '../../src/shared/database/schema.ts';

let database;
beforeEach(async () => { database = await isolatedDatabase(); });
afterEach(async () => { await database?.close(); });

test('seed creates three Argon2id users, zeroed wallets and four linked ledger accounts', async () => {
  await seed(database.db, seedConfig);
  const people = await database.db.select().from(users).orderBy(users.email);
  assert.equal(people.length, 3);
  assert.deepEqual(people.map((user) => user.role).sort(), ['AUCTIONEER', 'BIDDER', 'BIDDER']);
  for (const user of people) {
    assert.match(user.passwordHash, /^\$argon2id\$/);
    const password = user.role === 'AUCTIONEER' ? seedConfig.auctioneerPassword : user.email.startsWith('bidder1') ? seedConfig.bidder1Password : seedConfig.bidder2Password;
    assert.equal(await verify(user.passwordHash, password), true);
  }
  const accounts = await database.db.select().from(ledgerAccounts);
  const purses = await database.db.select().from(wallets);
  assert.equal(purses.length, 3);
  assert.equal(accounts.length, 4);
  for (const user of people) {
    const wallet = purses.find((wallet) => wallet.userId === user.id);
    assert.ok(wallet);
    assert.equal(wallet.balanceCents, 0n);
    assert.equal(wallet.reservedCents, 0n);
    assert.equal(accounts.filter((account) => account.walletId === wallet.id && account.type === 'USER_WALLET').length, 1);
  }
  assert.equal(accounts.filter((account) => account.type === 'SIMULATION_CLEARING' && account.walletId === null).length, 1);
});

test('sequential and concurrent reruns preserve ids, hashes and balances without duplicates', async () => {
  await Promise.all([seed(database.db, seedConfig), seed(database.db, seedConfig)]);
  const before = await database.db.select().from(users).orderBy(users.id);
  const [wallet] = await database.db.select().from(wallets);
  await database.db.update(wallets).set({ balanceCents: 123n }).where(eq(wallets.id, wallet.id));
  await Promise.all([seed(database.db, seedConfig), seed(database.db, { ...seedConfig, auctioneerPassword: 'Changed-demo-password!' })]);
  assert.deepEqual(await database.db.select().from(users).orderBy(users.id), before);
  assert.equal((await database.db.select().from(wallets)).length, 3);
  assert.equal((await database.db.select().from(ledgerAccounts)).length, 4);
  assert.equal((await database.db.select().from(wallets).where(eq(wallets.id, wallet.id)))[0].balanceCents, 123n);
});

test('rerunning seed repairs missing wallet/account relationships and clearing account', async () => {
  await seed(database.db, seedConfig);
  const people = await database.db.select().from(users).orderBy(users.id);
  await database.db.delete(ledgerAccounts);
  await database.db.delete(wallets);
  await seed(database.db, seedConfig);
  assert.deepEqual(await database.db.select().from(users).orderBy(users.id), people);
  assert.equal((await database.db.select().from(wallets)).length, 3);
  assert.equal((await database.db.select().from(ledgerAccounts)).length, 4);
});

test('conflicting ledger account type aborts seed without changing existing records', async () => {
  await seed(database.db, seedConfig);
  const [wallet] = await database.db.select().from(wallets);
  await database.db.update(ledgerAccounts).set({ type: 'SIMULATION_CLEARING' }).where(eq(ledgerAccounts.walletId, wallet.id));
  const before = await database.db.select().from(ledgerAccounts).orderBy(ledgerAccounts.id);
  await assert.rejects(seed(database.db, seedConfig), /type conflict/);
  assert.deepEqual(await database.db.select().from(ledgerAccounts).orderBy(ledgerAccounts.id), before);
});

test('a conflicting existing role rolls back all newly created seed records', async () => {
  await database.pool.query("INSERT INTO users VALUES (gen_random_uuid(), 'bidder2@verzel.local', 'existing', 'Existing', 'AUCTIONEER', now(), now())");
  await assert.rejects(seed(database.db, seedConfig), /role/i);
  assert.equal((await database.db.select().from(users)).length, 1);
  assert.equal((await database.db.select().from(wallets)).length, 0);
  assert.equal((await database.db.select().from(ledgerAccounts)).length, 0);
});
