import type { LedgerWriteContext } from '../../ledger/contracts/ledger.js';

export interface WalletState {
  id: string;
  userId: string;
  balanceCents: bigint;
  reservedCents: bigint;
}

export interface WalletBalance {
  balanceCents: string;
  reservedCents: string;
  availableCents: string;
}

export interface DepositReceipt {
  transactionId: string;
  amountCents: string;
  createdAt: Date;
}

export interface WalletQuery { limit: number; skip: number }
export interface WalletHistory {
  transactions: {
    id: string;
    type: 'DEPOSIT' | 'AUCTION_SETTLEMENT';
    amountCents: string;
    createdAt: Date;
    entries: { id: string; amountCents: string }[];
  }[];
  total: number;
  limit: number;
  skip: number;
}

export interface Reconciliation {
  walletId: string;
  balanceCents: string;
  ledgerBalanceCents: string;
  differenceCents: string;
  consistent: boolean;
}

export interface WalletWriteContext {
  ledger: LedgerWriteContext;
  provisionAndLock(userId: string): Promise<{ wallet: WalletState; accountId: string }>;
  credit(walletId: string, balanceCents: bigint): Promise<void>;
  history(accountId: string, query: WalletQuery): Promise<WalletHistory>;
}

export interface WalletRepository {
  transaction<T>(work: (context: WalletWriteContext) => Promise<T>): Promise<T>;
}

export interface WalletUseCases {
  get(userId: string): Promise<WalletBalance>;
  deposit(userId: string, amountCents: bigint, key: string): Promise<DepositReceipt>;
  history(userId: string, query: WalletQuery): Promise<WalletHistory>;
  reconcile(userId: string): Promise<Reconciliation>;
}
