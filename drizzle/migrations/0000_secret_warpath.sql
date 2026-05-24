CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint,
	"event_type" text NOT NULL,
	"severity" text NOT NULL,
	"content_hash" text,
	"content_excerpt" text,
	"categories" jsonb,
	"moderation_scores" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"persona_id" integer,
	"title" text,
	"document_text" text,
	"document_name" text,
	"document_tokens" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"group_chat_id" bigint,
	"bot_message_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"conversation_id" bigint NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tg_message_id" bigint,
	"tokens_input" integer,
	"tokens_output" integer,
	"cost_usd" numeric(12, 8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personas" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name_key" text NOT NULL,
	"description_key" text NOT NULL,
	"emoji" text NOT NULL,
	"system_prompt" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personas_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "usage_stats_daily" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"user_id" bigint,
	"text_messages" integer DEFAULT 0 NOT NULL,
	"voice_messages" integer DEFAULT 0 NOT NULL,
	"documents" integer DEFAULT 0 NOT NULL,
	"tokens_input" bigint DEFAULT 0 NOT NULL,
	"tokens_output" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"reporter_user_id" bigint,
	"message_id" bigint,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tg_id" bigint NOT NULL,
	"tg_username" text,
	"first_name" text,
	"language_code" text DEFAULT 'en',
	"tos_accepted_at" timestamp with time zone,
	"tos_version" text,
	"age_confirmed_at" timestamp with time zone,
	"age_rejected_at" timestamp with time zone,
	"active_persona_id" integer,
	"active_conversation_id" bigint,
	"flag_count_total" integer DEFAULT 0 NOT NULL,
	"flag_count_week" integer DEFAULT 0 NOT NULL,
	"flag_count_week_reset_at" timestamp with time zone DEFAULT now() NOT NULL,
	"banned_until" timestamp with time zone,
	"banned_permanent" boolean DEFAULT false NOT NULL,
	"ban_reason" text,
	"voice_output_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_tg_id_unique" UNIQUE("tg_id")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_stats_daily" ADD CONSTRAINT "usage_stats_daily_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_user" ON "audit_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_event" ON "audit_log" USING btree ("event_type","created_at");--> statement-breakpoint
CREATE INDEX "idx_conversations_user_active" ON "conversations" USING btree ("user_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_conversations_group_thread" ON "conversations" USING btree ("group_chat_id","bot_message_id");--> statement-breakpoint
CREATE INDEX "idx_messages_conv" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_messages_tg_msg" ON "messages" USING btree ("tg_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_usage_date_user" ON "usage_stats_daily" USING btree ("date","user_id");--> statement-breakpoint
CREATE INDEX "idx_usage_date" ON "usage_stats_daily" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_tg_id" ON "users" USING btree ("tg_id");--> statement-breakpoint
CREATE INDEX "idx_users_banned" ON "users" USING btree ("banned_until");