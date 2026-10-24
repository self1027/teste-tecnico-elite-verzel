import { AppError } from '../../../shared/http/app-error.js';
import { MAX_CENTS } from '../contracts/ledger.js';

export function assertBalanced(entries: { amountCents: bigint }[]): void {
  if (entries.length < 2 || entries.some(({ amountCents }) => amountCents === 0n || amountCents > MAX_CENTS || amountCents < -MAX_CENTS)
    || entries.reduce((sum, entry) => sum + entry.amountCents, 0n) !== 0n) {
    throw new AppError(409, 'UNBALANCED_LEDGER', 'Ledger entries must be nonzero, within BIGINT limits and sum to zero');
  }
}
