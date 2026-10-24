export const MAX_CENTS = 9223372036854775807n;

export interface LedgerTransactionInput {
  id: string;
  type: 'DEPOSIT' | 'AUCTION_SETTLEMENT';
  referenceId?: string | null;
  idempotencyKey: string;
  createdAt: Date;
}

export interface StoredTransaction {
  transaction: { id: string; type: 'DEPOSIT' | 'AUCTION_SETTLEMENT'; referenceId: string | null; createdAt: Date };
  entries: { accountId: string; amountCents: bigint }[];
}

// Bound to the caller's PostgreSQL transaction; never starts or commits one.
export interface LedgerWriteContext {
  findByKey(key: string): Promise<StoredTransaction | null>;
  clearingAccounts(): Promise<{ id: string; walletId: string | null }[]>;
  append(transaction: LedgerTransactionInput, entries: { accountId: string; amountCents: bigint }[]): Promise<void>;
  balance(accountId: string): Promise<bigint>;
}
