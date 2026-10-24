import type { AuditEvent } from '../contracts/audit.js';
import type { AuditEventRecord } from '../infrastructure/schema.js';
import { auditEvents } from '../infrastructure/schema.js';
import { sql } from 'drizzle-orm';
import { AuditCorruptionError } from '../contracts/errors.js';

export const MAX_AUDIT_EVENTS = 10000;
export const auditSelection = { record: auditEvents,
  timestampCanonical: sql<boolean>`${auditEvents.createdAt} = date_trunc('milliseconds', ${auditEvents.createdAt})` };

export function selectedAuditEvent(row: { record: AuditEventRecord; timestampCanonical: boolean }): AuditEvent {
  if (!row.timestampCanonical) throw new AuditCorruptionError('Noncanonical audit timestamp');
  return auditEvent(row.record);
}

export function auditEvent(record: AuditEventRecord): AuditEvent {
  return { ...record, eventType: record.eventType as AuditEvent['eventType'],
    payload: record.payload as AuditEvent['payload'], createdAt: record.createdAt.toISOString() };
}
