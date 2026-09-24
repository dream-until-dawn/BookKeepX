CREATE TYPE "public"."account_kind" AS ENUM('wechat', 'alipay', 'bank_debit', 'credit_card', 'cash', 'other');--> statement-breakpoint
CREATE TYPE "public"."category_group" AS ENUM('expense', 'income', 'neutral');--> statement-breakpoint
CREATE TYPE "public"."ledger_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."file_type" AS ENUM('csv', 'xlsx', 'pdf');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('previewing', 'committed', 'reverted', 'expired');--> statement-breakpoint
CREATE TYPE "public"."rule_match" AS ENUM('all', 'any');--> statement-breakpoint
CREATE TYPE "public"."rule_origin" AS ENUM('manual', 'learned', 'agent');--> statement-breakpoint
CREATE TYPE "public"."category_source" AS ENUM('manual', 'user_rule', 'system_rule', 'source_hint', 'none');--> statement-breakpoint
CREATE TYPE "public"."direction" AS ENUM('income', 'expense', 'neutral');--> statement-breakpoint
CREATE TYPE "public"."time_precision" AS ENUM('second', 'day');--> statement-breakpoint
CREATE TYPE "public"."transaction_source" AS ENUM('manual', 'import');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ledger_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "account_kind" NOT NULL,
	"institution" text,
	"card_last4" text,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_ledger_name_uq" UNIQUE("ledger_id","name"),
	CONSTRAINT "accounts_id_ledger_uq" UNIQUE("id","ledger_id"),
	CONSTRAINT "accounts_card_last4_format" CHECK ("accounts"."card_last4" IS NULL OR "accounts"."card_last4" ~ '^[0-9]{4}$'),
	CONSTRAINT "accounts_name_not_blank" CHECK (btrim("accounts"."name") <> '')
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ledger_id" uuid NOT NULL,
	"parent_id" uuid,
	"group" "category_group" NOT NULL,
	"name" text NOT NULL,
	"preset_key" text,
	"icon" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_ledger_preset_uq" UNIQUE("ledger_id","preset_key"),
	CONSTRAINT "categories_sibling_name_uq" UNIQUE NULLS NOT DISTINCT("ledger_id","group","parent_id","name"),
	CONSTRAINT "categories_id_ledger_uq" UNIQUE("id","ledger_id"),
	CONSTRAINT "categories_id_ledger_group_uq" UNIQUE("id","ledger_id","group"),
	CONSTRAINT "categories_not_own_parent" CHECK ("categories"."parent_id" IS NULL OR "categories"."parent_id" <> "categories"."id"),
	CONSTRAINT "categories_name_not_blank" CHECK (btrim("categories"."name") <> '')
);
--> statement-breakpoint
CREATE TABLE "ledger_members" (
	"ledger_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "ledger_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_members_ledger_id_user_id_pk" PRIMARY KEY("ledger_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "ledgers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"preset_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "sessions_token_hash_format" CHECK ("sessions"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"default_ledger_id" uuid,
	"self_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ledger_id" uuid NOT NULL,
	"created_by" uuid,
	"account_id" uuid,
	"status" "import_status" DEFAULT 'previewing' NOT NULL,
	"file_name" text NOT NULL,
	"file_sha256" text NOT NULL,
	"file_size" integer NOT NULL,
	"template_id" text NOT NULL,
	"template_version" integer NOT NULL,
	"detect_score" real NOT NULL,
	"holder_name" text,
	"period_start" date,
	"period_end" date,
	"verify_result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"preview" jsonb,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"imported_rows" integer DEFAULT 0 NOT NULL,
	"skipped_rows" integer DEFAULT 0 NOT NULL,
	"duplicate_rows" integer DEFAULT 0 NOT NULL,
	"committed_at" timestamp with time zone,
	"reverted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_batches_id_ledger_uq" UNIQUE("id","ledger_id"),
	CONSTRAINT "import_batches_sha_format" CHECK ("import_batches"."file_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "import_batches_counts_non_negative" CHECK ("import_batches"."total_rows" >= 0 AND "import_batches"."imported_rows" >= 0 AND "import_batches"."skipped_rows" >= 0 AND "import_batches"."duplicate_rows" >= 0),
	CONSTRAINT "import_batches_score_range" CHECK ("import_batches"."detect_score" >= 0 AND "import_batches"."detect_score" <= 1),
	CONSTRAINT "import_batches_committed_at" CHECK ("import_batches"."status" <> 'committed' OR "import_batches"."committed_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "import_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"file_type" "file_type" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"definition" jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_templates_user_name_uq" UNIQUE("user_id","name"),
	CONSTRAINT "import_templates_version_positive" CHECK ("import_templates"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "category_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ledger_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"match" "rule_match" DEFAULT 'all' NOT NULL,
	"conditions" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"origin" "rule_origin" DEFAULT 'manual' NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_rules_id_ledger_uq" UNIQUE("id","ledger_id"),
	CONSTRAINT "category_rules_hit_count_non_negative" CHECK ("category_rules"."hit_count" >= 0),
	CONSTRAINT "category_rules_conditions_array" CHECK (jsonb_typeof("category_rules"."conditions") = 'array'),
	CONSTRAINT "category_rules_action_object" CHECK (jsonb_typeof("category_rules"."action") = 'object')
);
--> statement-breakpoint
CREATE TABLE "source_hint_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ledger_id" uuid NOT NULL,
	"source" text NOT NULL,
	"hint" text NOT NULL,
	"category_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_hint_mappings_uq" UNIQUE("ledger_id","source","hint")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ledger_id" uuid NOT NULL,
	"created_by" uuid,
	"account_id" uuid,
	"category_id" uuid,
	"direction" "direction" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"time_precision" time_precision DEFAULT 'second' NOT NULL,
	"counterparty" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"source" "transaction_source" NOT NULL,
	"import_batch_id" uuid,
	"external_source" text,
	"external_id" text,
	"dedupe_key" text,
	"balance_after_cents" bigint,
	"payment_method" text,
	"source_category" text,
	"raw" jsonb,
	"category_source" "category_source" DEFAULT 'none' NOT NULL,
	"category_rule_id" uuid,
	"is_refund" boolean DEFAULT false NOT NULL,
	"refund_of_id" uuid,
	"duplicate_of_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_id_ledger_uq" UNIQUE("id","ledger_id"),
	CONSTRAINT "transactions_amount_range" CHECK ("transactions"."amount_cents" > 0 AND "transactions"."amount_cents" <= 9007199254740991),
	CONSTRAINT "transactions_balance_range" CHECK ("transactions"."balance_after_cents" IS NULL OR abs("transactions"."balance_after_cents") <= 9007199254740991),
	CONSTRAINT "transactions_refund_of_requires_flag" CHECK ("transactions"."refund_of_id" IS NULL OR "transactions"."is_refund"),
	CONSTRAINT "transactions_refund_not_self" CHECK ("transactions"."refund_of_id" IS NULL OR "transactions"."refund_of_id" <> "transactions"."id"),
	CONSTRAINT "transactions_duplicate_not_self" CHECK ("transactions"."duplicate_of_id" IS NULL OR "transactions"."duplicate_of_id" <> "transactions"."id"),
	CONSTRAINT "transactions_category_source" CHECK (("transactions"."category_id" IS NULL) = ("transactions"."category_source" = 'none')),
	CONSTRAINT "transactions_rule_requires_user_rule" CHECK ("transactions"."category_rule_id" IS NULL OR "transactions"."category_source" = 'user_rule'),
	CONSTRAINT "transactions_external_pair" CHECK (("transactions"."external_id" IS NULL) = ("transactions"."external_source" IS NULL)),
	CONSTRAINT "transactions_import_batch_source" CHECK ("transactions"."import_batch_id" IS NULL OR "transactions"."source" = 'import')
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_fk" FOREIGN KEY ("parent_id","ledger_id","group") REFERENCES "public"."categories"("id","ledger_id","group") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_members" ADD CONSTRAINT "ledger_members_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_members" ADD CONSTRAINT "ledger_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_default_ledger_id_ledgers_id_fk" FOREIGN KEY ("default_ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_account_fk" FOREIGN KEY ("account_id","ledger_id") REFERENCES "public"."accounts"("id","ledger_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_templates" ADD CONSTRAINT "import_templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_rules" ADD CONSTRAINT "category_rules_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_hint_mappings" ADD CONSTRAINT "source_hint_mappings_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_hint_mappings" ADD CONSTRAINT "source_hint_mappings_category_fk" FOREIGN KEY ("category_id","ledger_id") REFERENCES "public"."categories"("id","ledger_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_fk" FOREIGN KEY ("account_id","ledger_id") REFERENCES "public"."accounts"("id","ledger_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_fk" FOREIGN KEY ("category_id","ledger_id") REFERENCES "public"."categories"("id","ledger_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_import_batch_fk" FOREIGN KEY ("import_batch_id","ledger_id") REFERENCES "public"."import_batches"("id","ledger_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_rule_fk" FOREIGN KEY ("category_rule_id","ledger_id") REFERENCES "public"."category_rules"("id","ledger_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_refund_of_fk" FOREIGN KEY ("refund_of_id","ledger_id") REFERENCES "public"."transactions"("id","ledger_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_duplicate_of_fk" FOREIGN KEY ("duplicate_of_id","ledger_id") REFERENCES "public"."transactions"("id","ledger_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_members_user_idx" ON "ledger_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "import_batches_ledger_idx" ON "import_batches" USING btree ("ledger_id","created_at");--> statement-breakpoint
CREATE INDEX "import_batches_sha_idx" ON "import_batches" USING btree ("ledger_id","file_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_external_uq" ON "transactions" USING btree ("ledger_id","external_source","external_id") WHERE "transactions"."external_id" IS NOT NULL AND "transactions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "transactions_ledger_time_idx" ON "transactions" USING btree ("ledger_id","occurred_at");--> statement-breakpoint
CREATE INDEX "transactions_ledger_category_idx" ON "transactions" USING btree ("ledger_id","category_id");--> statement-breakpoint
CREATE INDEX "transactions_ledger_batch_idx" ON "transactions" USING btree ("ledger_id","import_batch_id");--> statement-breakpoint
CREATE INDEX "transactions_ledger_dedupe_idx" ON "transactions" USING btree ("ledger_id","dedupe_key");