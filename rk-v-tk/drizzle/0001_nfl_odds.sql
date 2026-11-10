CREATE TABLE "nfl_current_odds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"game_id" uuid NOT NULL,
	"bookmaker" text NOT NULL,
	"market" text NOT NULL,
	"selection" text NOT NULL,
	"point" numeric(7, 2),
	"american_odds" integer NOT NULL,
	"provider_updated_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "nfl_odds_slot_unique" UNIQUE("provider","game_id","bookmaker","market","selection"),
	CONSTRAINT "nfl_odds_book" CHECK ("nfl_current_odds"."bookmaker" IN ('draftkings', 'fanduel')),
	CONSTRAINT "nfl_odds_price" CHECK ("nfl_current_odds"."american_odds" <= -100 OR "nfl_current_odds"."american_odds" >= 100),
	CONSTRAINT "nfl_odds_revision" CHECK ("nfl_current_odds"."revision" > 0),
	CONSTRAINT "nfl_odds_selection" CHECK ((
    ("nfl_current_odds"."market" = 'h2h' AND "nfl_current_odds"."selection" IN ('home', 'away') AND "nfl_current_odds"."point" IS NULL) OR
    ("nfl_current_odds"."market" = 'spreads' AND "nfl_current_odds"."selection" IN ('home', 'away') AND "nfl_current_odds"."point" IS NOT NULL) OR
    ("nfl_current_odds"."market" = 'totals' AND "nfl_current_odds"."selection" IN ('over', 'under') AND "nfl_current_odds"."point" > 0)
  ))
);
--> statement-breakpoint
CREATE TABLE "nfl_game_provider_ids" (
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"game_id" uuid NOT NULL,
	CONSTRAINT "nfl_game_provider_ids_provider_provider_event_id_pk" PRIMARY KEY("provider","provider_event_id"),
	CONSTRAINT "nfl_game_provider_game_unique" UNIQUE("provider","game_id"),
	CONSTRAINT "nfl_game_provider_name" CHECK ("nfl_game_provider_ids"."provider" IN ('mock', 'the-odds-api'))
);
--> statement-breakpoint
CREATE TABLE "nfl_games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"home_team_id" text NOT NULL,
	"away_team_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"season_year" integer NOT NULL,
	"season_source" text DEFAULT 'derived' NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nfl_games_distinct_teams" CHECK ("nfl_games"."home_team_id" <> "nfl_games"."away_team_id"),
	CONSTRAINT "nfl_games_status" CHECK ("nfl_games"."status" IN ('scheduled', 'unavailable')),
	CONSTRAINT "nfl_games_season_source" CHECK ("nfl_games"."season_source" = 'derived')
);
--> statement-breakpoint
CREATE TABLE "odds_sync_state" (
	"provider" text PRIMARY KEY NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"snapshot_at" timestamp with time zone,
	"next_refresh_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"quota_remaining" integer,
	"quota_used" integer,
	"quota_last_cost" integer,
	"warnings_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "odds_sync_provider_name" CHECK ("odds_sync_state"."provider" IN ('mock', 'the-odds-api'))
);
--> statement-breakpoint
ALTER TABLE "nfl_current_odds" ADD CONSTRAINT "nfl_current_odds_provider_game_id_nfl_game_provider_ids_provider_game_id_fk" FOREIGN KEY ("provider","game_id") REFERENCES "public"."nfl_game_provider_ids"("provider","game_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nfl_game_provider_ids" ADD CONSTRAINT "nfl_game_provider_ids_game_id_nfl_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."nfl_games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nfl_games_start_idx" ON "nfl_games" USING btree ("starts_at");