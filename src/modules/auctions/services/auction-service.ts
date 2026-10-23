import { randomUUID } from 'node:crypto';
import { AppError } from '../../../shared/http/app-error.js';
import type { Auction, AuctionListInput, AuctionPage, AuctionRepository, AuctionUseCases, AuctionView, AuctionWithSnapshot, AuctionWriteContext, CreateAuctionInput, EditAuctionInput } from '../contracts/auctions.js';
import { lifecycleState } from '../lifecycle.js';

const maxBigint = 9223372036854775807n;

function validateTerms(input: Pick<CreateAuctionInput, 'startingBidCents' | 'minIncrementCents' | 'startsAt' | 'endsAt'>, now: Date): void {
  for (const value of [input.startingBidCents, input.minIncrementCents]) {
    if (value <= 0n || value > maxBigint) throw new AppError(400, 'INVALID_AUCTION_AMOUNT', 'Amounts must be positive BIGINT values');
  }
  if (!Number.isFinite(+input.startsAt) || !Number.isFinite(+input.endsAt) || input.startsAt <= now || input.endsAt <= input.startsAt) {
    throw new AppError(400, 'INVALID_AUCTION_DATES', 'Start must be in the future and end must follow start');
  }
}

function present(auction: AuctionWithSnapshot, now: Date): AuctionView {
  return { ...auction, startingBidCents: auction.startingBidCents.toString(),
    minIncrementCents: auction.minIncrementCents.toString(), lifecycleState: lifecycleState(auction, now) };
}

export class AuctionService implements AuctionUseCases {
  constructor(private readonly auctions: AuctionRepository) {}

  create(auctioneerId: string, input: CreateAuctionInput): Promise<AuctionView> {
    return this.auctions.transaction(async (tx) => {
      if (!await tx.snapshotExists(input.productSnapshotId)) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product snapshot not found');
      const now = await tx.databaseNow();
      validateTerms(input, now);
      const auction = await tx.insert({ ...input, id: randomUUID(), auctioneerId,
        status: 'PUBLISHED', currentBidId: null, createdAt: now, updatedAt: now });
      return present(auction, now);
    });
  }

  async list(input: AuctionListInput): Promise<AuctionPage<AuctionView>> {
    const page = await this.auctions.list(input);
    return { ...page, auctions: page.auctions.map((auction) => present(auction, page.asOf)) };
  }

  async mine(auctioneerId: string, input: AuctionListInput): Promise<AuctionPage<AuctionView>> {
    const page = await this.auctions.list({ ...input, auctioneerId });
    return { ...page, auctions: page.auctions.map((auction) => present(auction, page.asOf)) };
  }

  async get(id: string): Promise<AuctionView> {
    const { auction, asOf } = await this.auctions.findById(id);
    if (!auction) throw new AppError(404, 'AUCTION_NOT_FOUND', 'Auction not found');
    return present(auction, asOf);
  }

  edit(id: string, auctioneerId: string, input: EditAuctionInput): Promise<AuctionView> {
    return this.changeOwned(id, auctioneerId, async (tx, auction, now) => {
      if (now >= auction.startsAt) throw new AppError(409, 'AUCTION_ALREADY_STARTED', 'Started auctions cannot be edited');
      const terms = {
        startingBidCents: input.startingBidCents ?? auction.startingBidCents,
        minIncrementCents: input.minIncrementCents ?? auction.minIncrementCents,
        startsAt: input.startsAt ?? auction.startsAt, endsAt: input.endsAt ?? auction.endsAt,
      };
      validateTerms(terms, now);
      return present(await tx.update(id, { ...terms, updatedAt: now }), now);
    });
  }

  cancel(id: string, auctioneerId: string): Promise<AuctionView> {
    return this.changeOwned(id, auctioneerId, async (tx, auction, now) => {
      if (now >= auction.endsAt) throw new AppError(409, 'AUCTION_EXPIRED', 'Ended auctions cannot be cancelled');
      return present(await tx.update(id, { status: 'CANCELLED', updatedAt: now }), now);
    });
  }

  private changeOwned(
    id: string, ownerId: string,
    change: (tx: AuctionWriteContext, auction: Auction, now: Date) => Promise<AuctionView>,
  ): Promise<AuctionView> {
    return this.auctions.transaction(async (tx) => {
      const auction = await tx.lock(id);
      if (!auction) throw new AppError(404, 'AUCTION_NOT_FOUND', 'Auction not found');
      if (auction.auctioneerId !== ownerId) throw new AppError(403, 'FORBIDDEN', 'Only the auction owner can modify it');
      if (auction.status !== 'PUBLISHED') throw new AppError(409, 'AUCTION_NOT_PUBLISHED', 'Auction is no longer published');
      if (auction.currentBidId !== null || await tx.hasBids(id)) throw new AppError(409, 'AUCTION_HAS_BIDS', 'Auctions with bids cannot be modified');
      // Read the wall clock after the parent row lock and bid check, never before a lock wait.
      const now = await tx.databaseNow();
      return change(tx, auction, now);
    });
  }
}
