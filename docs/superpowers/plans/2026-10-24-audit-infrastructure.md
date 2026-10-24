# Audit infrastructure implementation plan

> Execution: specialized subagents in parallel, integrated and reviewed by the lead agent.

**Goal:** public verification of per-auction commitments against an independent signed witness.
**Spec:** user execution prompt and requirements.pdf, pages 2, 3, 4 and 5 (all seven pages read visually).
**Architecture:** domain ports, transaction-bound Drizzle appender, durable outbox in audit_anchors,
HTTP witness outside the audited database, public read-only verification.
**Stack:** existing TypeScript/Express/Drizzle/PostgreSQL; native SHA-256, Ed25519 and fetch.

## Constraints and decisions

- Preserve existing work (only untracked temp/ at start), no push, <=500 added+deleted lines per commit.
- Work in the provided checkout; all mutations/shared migrations and commits owned by lead.
- Two execution waves because the environment permits three child agents plus the lead.
- No private credentials or witness data/key inside application DB/container volume.
- Witness is independently operated HTTP service, append-only API, durable journal and Ed25519 signatures.
- Trust excludes compromise/rollback of the witness and compromise of application runtime/publish credentials.
- An attacker with SQL access can rewrite an unanchored suffix; never report it VERIFIED.
- No production anchor configured means VERIFICATION_UNAVAILABLE, not a simulated verification success.
- Existing events without hash version receive version 0; verifier rejects rather than silently endorsing them.
- Existing auctions without baseline are NOT_RECORDED; never backfill a trusted historic baseline silently.
- Future bids and settlements use typed, strict public payloads with per-auction bidder pseudonyms.

## Ownership and dependencies

1. Lead defines contracts/audit.ts and contracts/anchors.ts before dispatch.
2. A: domain/ (canonical JSON, event validation, hashing, chain validation), tests/audit-domain.test.js.
3. B: repositories/ (transaction-bound appender, outbox/read repository),
   auctions/repositories/drizzle-auction-audit-reader.ts, tests/integration/audit-persistence.test.js.
   Consumes domain functions specified below. No schema or migration edits.
4. C: infrastructure/http-anchor-provider.ts, witness/*, tests/audit-witness.test.js.
   Consumes anchor ports; HTTP provider verifies pinned public key, namespace and signatures.
5. Lead: schema/migration, services/verifier, services/anchor-worker, controller/composition/config;
   inject audit appenders into existing auction persistence; tests covering public verification and attacks.
6. Second wave: E independently reviews attacks and adds adversarial tests; F reviews PDF adherence/docs;
   A/B/C review other components when ownership is released. Lead integrates fixes.

## Shared domain API (A)

- canonicalJson(value: unknown): string; reject non-JSON, unsafe/non-integer numbers, cycles/prototypes.
- validateInput(input: AuditInput): void; strict per-type payload fields, canonical UTC millisecond dates.
- hashEvent(event: Omit<AuditEvent, 'eventHash'>): string; versioned domain-separated SHA-256, includes id.
- checkChain(auctionId: string, events: AuditEvent[]): { valid: boolean; reason: string | null }.
- GENESIS_HASH: 64 zeroes. Sequence starts at 1, strictly contiguous, hashVersion=1.
- bidderReference(auctionId: string, bidderId: string): string; SHA-256 per-auction pseudonym.
- auction payload: all AuctionCommitment fields, spread at root.
- BID_ACCEPTED payload: BidCommitment fields plus endsAt (post anti-sniping).
- AUCTION_SETTLED payload: SettlementCommitment fields.
- AUCTION_CLOSED_NO_BIDS payload: empty object.

## Checks and delivery

- [x] Record baseline npm test/test:db/lint/typecheck/build.
- [x] Each implementer writes tests before implementation and records red/green commands.
- [x] Validate canonicalization, chain continuity, privacy, rollback and concurrent appends.
- [x] Exercise independent witness publication, retries, lost response, restart, immutable references.
- [x] Verify direct SQL update/insert/delete/truncation/rewrites, bid changes, no-login endpoint.
- [x] Validate same-transaction auction writes; no network before commit; lock auction first.
- [x] Re-run all five mandatory checks after integration; record exact results.
- [x] Write docs/implementation-reports/audit-infrastructure.md sections A-H in Portuguese.
- [x] Commit cohesive groups only after checking staged added+deleted <=500; no push.

## Review focus

- Never trust a deleted/forged local audit_anchors row to discover the latest external head.
- Never return raw tampered JSON (could contain attacker-injected PII) in public event pages.
- Distinguish snapshot/provider races from corruption; re-read DB after reading external head.
- Pending outbox survives crash between commit/publication and publication/confirmation.
- Confirmation is compare-and-set; external duplicate sequence/different hash conflicts.
- Full verification is bounded; exceeding bounds returns unavailable, never partial VERIFIED.

## Deferred assessment

Reservation implementation is optional after audit stabilizes; do not expand into BidService or
capture/settlement without sufficient integration evidence. Existing reservation ports remain intact.
