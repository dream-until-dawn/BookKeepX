CREATE TYPE "public"."direction" AS ENUM('income', 'expense', 'neutral');--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"direction" "direction" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"category_key" text,
	"counterparty" text DEFAULT '' NOT NULL,
	"is_refund" boolean DEFAULT false NOT NULL,
	"refund_of_id" uuid,
	"duplicate_of_id" uuid,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "amount_positive" CHECK ("transactions"."amount_cents" > 0),
	CONSTRAINT "amount_safe_integer" CHECK ("transactions"."amount_cents" <= 9007199254740991),
	CONSTRAINT "refund_not_self" CHECK ("transactions"."refund_of_id" IS NULL OR "transactions"."refund_of_id" <> "transactions"."id"),
	CONSTRAINT "refund_of_requires_flag" CHECK ("transactions"."refund_of_id" IS NULL OR "transactions"."is_refund")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_refund_of_fk" FOREIGN KEY ("refund_of_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_duplicate_of_fk" FOREIGN KEY ("duplicate_of_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_user_time_idx" ON "transactions" USING btree ("user_id","occurred_at");