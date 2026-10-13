CREATE TABLE IF NOT EXISTS "payment_tokens" (
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"symbol" text NOT NULL,
	"decimals" integer NOT NULL,
	"microusd_per_token" bigint NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"faucet" boolean DEFAULT false NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_tokens_chain_id_address_pk" PRIMARY KEY("chain_id","address"),
	CONSTRAINT "payment_token_price_positive" CHECK ("payment_tokens"."microusd_per_token" > 0)
);
