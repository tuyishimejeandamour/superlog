CREATE TABLE "cloud_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"region" text NOT NULL,
	"scrape_role_arn" text,
	"external_id_ciphertext" "bytea" NOT NULL,
	"external_id_nonce" "bytea" NOT NULL,
	"external_id_key_version" integer DEFAULT 1 NOT NULL,
	"account_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cloud_connections" ADD CONSTRAINT "cloud_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_connections" ADD CONSTRAINT "cloud_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cloud_connections_project_idx" ON "cloud_connections" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_connections_active_role_idx" ON "cloud_connections" USING btree ("project_id","scrape_role_arn") WHERE revoked_at IS NULL;