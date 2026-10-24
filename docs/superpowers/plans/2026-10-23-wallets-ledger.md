# Wallets & Ledger Implementation Plan

> Execute inline with TDD; preserve the existing modular architecture.

**Goal:** simulated deposits, own-wallet history, reconciliation and future reservation contracts.

**Architecture:** wallet controller/service/repository; a ledger adapter bound to the caller's Drizzle transaction. Existing unique wallet/account/key constraints suffice. No schema changes or new dependencies.

**Constraints:** monetary API strings, bigint arithmetic, authenticated identity, BIDDER-only deposits, append-only ledger, PostgreSQL locks, no bids or settlement implementation.

## Tasks

- [x] Write financial integration tests and observe missing wallet routes fail (404 instead of 401).
- [x] Define wallet, ledger and transaction-bound reservation contracts before classes.
- [x] Implement atomic provisioning, wallet locking, scoped persistent idempotency and balanced ledger append.
- [x] Add authenticated HTTP routes, history and internal reconciliation.
- [x] Exercise limits, concurrent retries, independent deposits, rollback, isolation and corrupt balances on real PostgreSQL.
- [x] Document lock order, receipts, reservation pre/postconditions and next-phase work.
- [x] Run npm test (24), npm run test:db (65), lint, typecheck and build; all exit 0. Independent read-only review found no actionable defect.

## Review focus

Retry after later deposits must return the original receipt; overflow must precede writes; missing accounts on funded wallets must not hide lost accounting; reconciliation must use a consistent snapshot; duplicate headers and extra fields must be rejected.

## Decisions

- Receipt contains transactionId, amountCents and createdAt, never a changing balance.
- Store `deposit:<authenticated UUID>:<client key>` in the existing unique idempotency key, wallet ID in referenceId, amount in ledger entries.
- Require the seeded clearing account; do not create alternative clearing accounts during requests.
- Reserve/release/capture are contracts for the next phase, with no executable reservation or settlement workflow in this phase.
- Future locks: auction row first, wallet rows ordered by UUID, reservation rows, then ledger writes. Deposits lock only their wallet.
