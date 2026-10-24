import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../../shared/database/client.js';
import { auctions } from '../../auctions/infrastructure/schema.js';
import type { AuditAppender, AuditEvent, AuditInput } from '../contracts/audit.js';
import { checkChain, GENESIS_HASH, hashEvent, validateInput } from '../domain/cryptography.js';
import { auditAnchors, auditEvents } from '../infrastructure/schema.js';
import { auditSelection, selectedAuditEvent, MAX_AUDIT_EVENTS } from './audit-record.js';

export class DrizzleAuditAppender implements AuditAppender {
  constructor(private readonly tx: DatabaseTransaction) {}

  async append(input: AuditInput): Promise<AuditEvent> {
    validateInput(input);
    const candidate = structuredClone(input);
    // Parent first: the caller may already own this reentrant lock for its business write.
    const [auction] = await this.tx.select({ id: auctions.id }).from(auctions)
      .where(eq(auctions.id, candidate.auctionId)).for('update');
    if (!auction) throw new Error('Cannot append audit event for missing auction');
    const records = await this.tx.select(auditSelection).from(auditEvents).where(eq(auditEvents.auctionId, candidate.auctionId))
      .orderBy(asc(auditEvents.sequence)).limit(MAX_AUDIT_EVENTS + 1);
    if (records.length >= MAX_AUDIT_EVENTS) throw new Error('Audit event limit of 10000 exceeded');
    const events = records.map(selectedAuditEvent);
    const chain = checkChain(candidate.auctionId, events);
    if (!chain.valid) throw new Error(`Cannot append to invalid audit chain: ${chain.reason ?? 'unknown reason'}`);
    const previous = events.at(-1);
    const unsigned = { ...candidate, id: randomUUID(), sequence: (previous?.sequence ?? 0n) + 1n,
      previousHash: previous?.eventHash ?? GENESIS_HASH, hashVersion: 1 };
    const event = { ...unsigned, eventHash: hashEvent(unsigned) };
    await this.tx.insert(auditEvents).values({ ...event, createdAt: new Date(event.createdAt) });
    await this.tx.insert(auditAnchors).values({ id: randomUUID(), auctionId: event.auctionId,
      lastSequence: event.sequence, lastHash: event.eventHash, externalReference: null, anchoredAt: new Date(event.createdAt) });
    return event;
  }
}
