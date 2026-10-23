import type { Auction, LifecycleState } from './contracts/auctions.js';

export function lifecycleState(
  auction: Pick<Auction, 'status' | 'startsAt' | 'endsAt'>, now: Date,
): LifecycleState {
  if (auction.status !== 'PUBLISHED') return auction.status;
  if (now < auction.startsAt) return 'SCHEDULED';
  if (now < auction.endsAt) return 'LIVE';
  return 'FINALIZING';
}
