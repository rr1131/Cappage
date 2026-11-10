CREATE TABLE "odds_provider_budget" (
	"provider" text PRIMARY KEY NOT NULL,
	"billing_anchor" timestamp with time zone NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"credits_charged" integer DEFAULT 0 NOT NULL,
	"monthly_credit_cap" integer NOT NULL,
	"daily_paid_refresh_limit" integer NOT NULL,
	"day" text NOT NULL,
	"daily_paid_refreshes" integer DEFAULT 0 NOT NULL,
	"next_paid_attempt_at" timestamp with time zone,
	CONSTRAINT "odds_budget_provider" CHECK ("odds_provider_budget"."provider" = 'the-odds-api'),
	CONSTRAINT "odds_budget_limits" CHECK ("odds_provider_budget"."monthly_credit_cap" BETWEEN 0 AND 300 AND "odds_provider_budget"."daily_paid_refresh_limit" BETWEEN 0 AND 3),
	CONSTRAINT "odds_budget_counts" CHECK ("odds_provider_budget"."credits_charged" >= 0 AND "odds_provider_budget"."daily_paid_refreshes" BETWEEN 0 AND 3),
	CONSTRAINT "odds_budget_period" CHECK ("odds_provider_budget"."period_start" < "odds_provider_budget"."period_end")
);
--> statement-breakpoint
CREATE TABLE "odds_provider_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"day" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"charged_credits" integer DEFAULT 3 NOT NULL,
	"status" text DEFAULT 'uncertain' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"provider_used" integer,
	CONSTRAINT "odds_request_cost" CHECK ("odds_provider_requests"."charged_credits" BETWEEN 0 AND 3),
	CONSTRAINT "odds_request_status" CHECK ("odds_provider_requests"."status" IN ('uncertain', 'confirmed'))
);
--> statement-breakpoint
ALTER TABLE "nfl_current_odds" DROP CONSTRAINT "nfl_odds_selection";--> statement-breakpoint
ALTER TABLE "nfl_current_odds" ADD COLUMN "unavailable_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "odds_provider_requests" ADD CONSTRAINT "odds_provider_requests_provider_odds_provider_budget_provider_fk" FOREIGN KEY ("provider") REFERENCES "public"."odds_provider_budget"("provider") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "odds_requests_period_idx" ON "odds_provider_requests" USING btree ("provider","period_start");--> statement-breakpoint
ALTER TABLE "nfl_current_odds" ADD CONSTRAINT "nfl_odds_selection" CHECK ((
    ("nfl_current_odds"."market" = 'h2h' AND "nfl_current_odds"."selection" IN ('home', 'away') AND "nfl_current_odds"."point" IS NULL) OR
    ("nfl_current_odds"."market" = 'spreads' AND "nfl_current_odds"."selection" IN ('home', 'away') AND "nfl_current_odds"."point" IS NOT NULL) OR
    ("nfl_current_odds"."market" = 'totals' AND "nfl_current_odds"."selection" IN ('over', 'under') AND "nfl_current_odds"."point" IS NOT NULL AND "nfl_current_odds"."point" > 0)
  ));