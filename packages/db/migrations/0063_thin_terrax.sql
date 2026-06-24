ALTER TABLE "cloud_resources" ADD COLUMN "config" jsonb;--> statement-breakpoint
ALTER TABLE "cloud_resources" ADD COLUMN "config_fetched_at" timestamp with time zone;