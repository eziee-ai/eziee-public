CREATE TABLE "auth_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"binding" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"title" text NOT NULL,
	"model" text NOT NULL,
	"protocol" text DEFAULT 'auto' NOT NULL,
	"chain_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_accounts" (
	"address" text PRIMARY KEY NOT NULL,
	"balance_microusd" bigint DEFAULT 0 NOT NULL,
	"held_microusd" bigint DEFAULT 0 NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	CONSTRAINT "credit_held_within_balance" CHECK ("credit_accounts"."held_microusd" >= 0 AND "credit_accounts"."held_microusd" <= GREATEST("credit_accounts"."balance_microusd", 0))
);
--> statement-breakpoint
CREATE TABLE "credit_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"amount_microusd" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"delta_microusd" bigint NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"test" boolean DEFAULT false NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_ledger_ref_unique" UNIQUE("ref")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text NOT NULL,
	"chat_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"role" text NOT NULL,
	"parts" jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_chat_id_id_pk" PRIMARY KEY("chat_id","id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"address" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_address_users_address_fk" FOREIGN KEY ("address") REFERENCES "public"."users"("address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_address_users_address_fk" FOREIGN KEY ("address") REFERENCES "public"."users"("address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_address_users_address_fk" FOREIGN KEY ("address") REFERENCES "public"."users"("address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_address_users_address_fk" FOREIGN KEY ("address") REFERENCES "public"."users"("address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_address_users_address_fk" FOREIGN KEY ("address") REFERENCES "public"."users"("address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chats_address_updated_idx" ON "chats" USING btree ("address","updated_at");--> statement-breakpoint
CREATE INDEX "credit_holds_open_idx" ON "credit_holds" USING btree ("address","released_at");--> statement-breakpoint
CREATE INDEX "credit_ledger_address_idx" ON "credit_ledger" USING btree ("address","created_at");--> statement-breakpoint
CREATE INDEX "messages_chat_position_idx" ON "messages" USING btree ("chat_id","position");--> statement-breakpoint
CREATE INDEX "sessions_address_idx" ON "sessions" USING btree ("address");