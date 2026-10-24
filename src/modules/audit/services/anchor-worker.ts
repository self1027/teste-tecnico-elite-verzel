import type { AnchorPublisher, AnchorVerifier } from '../contracts/anchors.js';
import type { AuditRepository } from '../contracts/audit.js';
import { inspectSnapshot } from './audit-verifier.js';

/** Polling durable outbox: a restart simply constructs another worker over the same repository. */
export class AnchorWorker {
  private running = false;
  constructor(private readonly repository: AuditRepository, private readonly external: AnchorPublisher & AnchorVerifier) {}

  async runOnce(limit = 100): Promise<{ confirmed: number; failed: number }> {
    if (this.running) return { confirmed: 0, failed: 0 };
    this.running = true;
    let confirmed = 0, failed = 0;
    try {
      for (const pending of await this.repository.pending(limit)) {
        try {
          const head = await this.external.latest(pending.auctionId);
          const snapshot = await this.repository.snapshot(pending.auctionId);
          if (!snapshot) throw new Error('Missing audit snapshot');
          const check = inspectSnapshot(snapshot, head);
          if (check.status === 'TAMPERED' || check.operationalCoverage !== 'CONSISTENT') throw new Error('Invalid audit state');
          const event = snapshot.events.find((item) => item.sequence === pending.sequence);
          if (!event || event.eventHash !== pending.hash) throw new Error('Outbox commitment mismatch');
          if (head && BigInt(head.sequence) >= pending.sequence) {
            // A later external head already commits this validated prefix. Never overwrite its local receipt.
            await this.repository.confirm(pending.id, head.reference, head.publishedAt, pending);
          } else {
            const receipt = await this.external.publish({ auctionId: pending.auctionId, sequence: String(pending.sequence), hash: pending.hash }, head);
            await this.repository.confirm(pending.id, receipt.reference, receipt.publishedAt, pending);
          }
          confirmed++;
        } catch { failed++; }
      }
      return { confirmed, failed };
    } finally { this.running = false; }
  }
}
