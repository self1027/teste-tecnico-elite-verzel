import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { SeedConfig } from '../config.js';
import type { Database } from './client.js';
import { users, wallets, ledgerAccounts } from './schema.js';
import { ArgonPasswords } from '../../modules/auth/infrastructure/argon-passwords.js';

export async function seed(db: Database, config: SeedConfig): Promise<void> {
  const passwords = new ArgonPasswords();
  const people = [
    { email: 'auctioneer@verzel.local', displayName: 'Demo Auctioneer', role: 'AUCTIONEER', password: config.auctioneerPassword },
    { email: 'bidder1@verzel.local', displayName: 'Demo Bidder 1', role: 'BIDDER', password: config.bidder1Password },
    { email: 'bidder2@verzel.local', displayName: 'Demo Bidder 2', role: 'BIDDER', password: config.bidder2Password },
  ] as const;

  await db.transaction(async (tx) => {
    // The schema has no unique constraint on clearing type; serialize seed executions.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(742193, 1)`);
    for (const person of people) {
      const now = new Date();
      const [existing] = await tx.select().from(users).where(eq(users.email, person.email)).limit(1);
      if (existing && existing.role !== person.role) throw new Error(`Seed role conflict for ${person.email}`);
      const userId = existing?.id ?? randomUUID();
      if (!existing) {
        await tx.insert(users).values({
          id: userId, email: person.email, displayName: person.displayName, role: person.role,
          passwordHash: await passwords.hash(person.password), createdAt: now, updatedAt: now,
        });
      }
      await tx.insert(wallets).values({ id: randomUUID(), userId, createdAt: now, updatedAt: now })
        .onConflictDoNothing({ target: wallets.userId });
      const [wallet] = await tx.select({ id: wallets.id }).from(wallets).where(eq(wallets.userId, userId)).limit(1);
      if (!wallet) throw new Error('Seed wallet missing');
      await tx.insert(ledgerAccounts).values({ id: randomUUID(), walletId: wallet.id, type: 'USER_WALLET', createdAt: now })
        .onConflictDoNothing({ target: ledgerAccounts.walletId });
      const [account] = await tx.select({ id: ledgerAccounts.id }).from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.walletId, wallet.id), eq(ledgerAccounts.type, 'USER_WALLET'))).limit(1);
      if (!account) throw new Error('Seed ledger account type conflict');
    }
    const clearing = await tx.select({ walletId: ledgerAccounts.walletId }).from(ledgerAccounts)
      .where(eq(ledgerAccounts.type, 'SIMULATION_CLEARING'));
    if (clearing.length > 1 || clearing.some((account) => account.walletId !== null)) {
      throw new Error('Seed clearing account conflict');
    }
    if (clearing.length === 0) {
      await tx.insert(ledgerAccounts).values({ id: randomUUID(), type: 'SIMULATION_CLEARING', createdAt: new Date() });
    }
  });
}
