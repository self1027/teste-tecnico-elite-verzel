CREATE TYPE "user_role" AS ENUM('AUCTIONEER', 'BIDDER');--> statement-breakpoint
CREATE TYPE "auction_status" AS ENUM('PUBLISHED', 'CANCELLED', 'SETTLED', 'CLOSED_NO_BIDS');--> statement-breakpoint
CREATE TYPE "reservation_status" AS ENUM('ACTIVE', 'RELEASED', 'CAPTURED');--> statement-breakpoint
CREATE TYPE "ledger_account_type" AS ENUM('USER_WALLET', 'SIMULATION_CLEARING');--> statement-breakpoint
CREATE TYPE "ledger_transaction_type" AS ENUM('DEPOSIT', 'AUCTION_SETTLEMENT');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY,
	"email" varchar(255) NOT NULL UNIQUE,
	"password_hash" text NOT NULL,
	"display_name" varchar(150) NOT NULL,
	"role" "user_role" NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_snapshots" (
	"id" uuid PRIMARY KEY,
	"external_id" varchar(255) NOT NULL,
	"source" varchar(100) NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"image_url" text,
	"attributes" json,
	"captured_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auctions" (
	"id" uuid PRIMARY KEY,
	"auctioneer_id" uuid NOT NULL,
	"product_snapshot_id" uuid NOT NULL,
	"current_bid_id" uuid,
	"starting_bid_cents" bigint NOT NULL,
	"min_increment_cents" bigint NOT NULL,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"status" "auction_status" NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bids" (
	"id" uuid PRIMARY KEY,
	"auction_id" uuid NOT NULL,
	"bidder_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"sequence" bigint NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auction_settlements" (
	"id" uuid PRIMARY KEY,
	"auction_id" uuid NOT NULL UNIQUE,
	"winning_bid_id" uuid NOT NULL UNIQUE,
	"ledger_transaction_id" uuid NOT NULL UNIQUE,
	"amount_cents" bigint NOT NULL,
	"receipt_token" uuid NOT NULL UNIQUE,
	"settled_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_reservations" (
	"id" uuid PRIMARY KEY,
	"wallet_id" uuid NOT NULL,
	"auction_id" uuid NOT NULL,
	"bid_id" uuid NOT NULL UNIQUE,
	"amount_cents" bigint NOT NULL,
	"status" "reservation_status" NOT NULL,
	"created_at" timestamp NOT NULL,
	"released_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL UNIQUE,
	"balance_cents" bigint DEFAULT 0 NOT NULL,
	"reserved_cents" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY,
	"wallet_id" uuid UNIQUE,
	"type" "ledger_account_type" NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY,
	"type" "ledger_transaction_type" NOT NULL,
	"reference_id" uuid,
	"idempotency_key" varchar(255) NOT NULL UNIQUE,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_anchors" (
	"id" uuid PRIMARY KEY,
	"auction_id" uuid NOT NULL,
	"last_sequence" bigint NOT NULL,
	"last_hash" varchar(64) NOT NULL,
	"external_reference" text,
	"anchored_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY,
	"auction_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"payload" json NOT NULL,
	"previous_hash" varchar(64) NOT NULL,
	"event_hash" varchar(64) NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bids_auction_id_sequence_unique" ON "bids" ("auction_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_anchors_auction_id_last_sequence_unique" ON "audit_anchors" ("auction_id","last_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_auction_id_sequence_unique" ON "audit_events" ("auction_id","sequence");--> statement-breakpoint
ALTER TABLE "auctions" ADD CONSTRAINT "auctions_auctioneer_id_users_id_fkey" FOREIGN KEY ("auctioneer_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "auctions" ADD CONSTRAINT "auctions_product_snapshot_id_product_snapshots_id_fkey" FOREIGN KEY ("product_snapshot_id") REFERENCES "product_snapshots"("id");--> statement-breakpoint
ALTER TABLE "auctions" ADD CONSTRAINT "auctions_current_bid_id_bids_id_fkey" FOREIGN KEY ("current_bid_id") REFERENCES "bids"("id");--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_auction_id_auctions_id_fkey" FOREIGN KEY ("auction_id") REFERENCES "auctions"("id");--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_bidder_id_users_id_fkey" FOREIGN KEY ("bidder_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "auction_settlements" ADD CONSTRAINT "auction_settlements_auction_id_auctions_id_fkey" FOREIGN KEY ("auction_id") REFERENCES "auctions"("id");--> statement-breakpoint
ALTER TABLE "auction_settlements" ADD CONSTRAINT "auction_settlements_winning_bid_id_bids_id_fkey" FOREIGN KEY ("winning_bid_id") REFERENCES "bids"("id");--> statement-breakpoint
ALTER TABLE "auction_settlements" ADD CONSTRAINT "auction_settlements_HI0VRMfGKNtb_fkey" FOREIGN KEY ("ledger_transaction_id") REFERENCES "ledger_transactions"("id");--> statement-breakpoint
ALTER TABLE "wallet_reservations" ADD CONSTRAINT "wallet_reservations_wallet_id_wallets_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id");--> statement-breakpoint
ALTER TABLE "wallet_reservations" ADD CONSTRAINT "wallet_reservations_auction_id_auctions_id_fkey" FOREIGN KEY ("auction_id") REFERENCES "auctions"("id");--> statement-breakpoint
ALTER TABLE "wallet_reservations" ADD CONSTRAINT "wallet_reservations_bid_id_bids_id_fkey" FOREIGN KEY ("bid_id") REFERENCES "bids"("id");--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_wallet_id_wallets_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "ledger_transactions"("id");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id");--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD CONSTRAINT "audit_anchors_auction_id_auctions_id_fkey" FOREIGN KEY ("auction_id") REFERENCES "auctions"("id");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_auction_id_auctions_id_fkey" FOREIGN KEY ("auction_id") REFERENCES "auctions"("id");