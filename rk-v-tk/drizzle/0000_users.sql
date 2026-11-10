CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cognito_sub" text NOT NULL,
	"username" varchar(30) NOT NULL,
	"display_name" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_cognito_sub_unique" UNIQUE("cognito_sub"),
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_username_format" CHECK ("users"."username" ~ '^[a-z0-9_]{3,30}$'),
	CONSTRAINT "users_cognito_sub_nonempty" CHECK (length(trim("users"."cognito_sub")) > 0)
);
--> statement-breakpoint
-- Drizzle does not model triggers. Keep this database-owned timestamp behavior
-- in the SQL migration so direct SQL updates follow the same rule as the app.
CREATE FUNCTION "set_users_updated_at"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "users_updated_at" BEFORE UPDATE ON "users"
FOR EACH ROW EXECUTE FUNCTION "set_users_updated_at"();
