# RkVTk

Free-to-play NFL simulation. Cognito-authenticated profiles and cached DraftKings/
FanDuel NFL odds browsing are implemented. Odds development defaults to synthetic
fixtures. Wager placement, settlement, parlays, and social features are not implemented.

## Local setup

Use a supported Node.js LTS release (Node 22 recommended) and npm. Run commands
from this directory (`rk-v-tk/`), not the repository root.

```sh
npm ci
cp .env.example .env.local
```

Fill in the existing Cognito pool/client identifiers and a **development** Neon
PostgreSQL connection string in `.env.local`. Percent-encode special characters
in credentials. Use Neon's pooled URL with TLS enabled. Never commit credentials
or use a `NEXT_PUBLIC_` prefix for `DATABASE_URL`.

Inspect the versioned SQL in `drizzle/`, confirm the URL points at the intended
development database, then explicitly apply migrations and populate mock odds:

```sh
npm run db:migrate
npm run odds:sync
npm run dev
```

Visit http://localhost:3000, sign in through the existing Amplify Authenticator,
and choose a profile username. Reloading or signing in again retrieves the same
profile. Cognito login usernames and profile usernames are separate. Sign-in
behavior and the existing Cognito resources are unchanged.

The NFL browser below the profile compares moneylines, spreads, and totals from
the cached dataset. Mock games are labeled as demo data. Its refresh control reads
the database; it never requests new sportsbook data.

## Odds ingestion

`ODDS_PROVIDER=mock` is the default. The mock provider needs no upstream API key,
but normal database and Cognito setup still applies. To use the selected external
provider, configure `ODDS_PROVIDER=the-odds-api` and a server-only `ODDS_API_KEY`
in `.env.local`, then run `npm run odds:sync`.

The sync command runs once and respects the shared database lease, retry cooldown,
refresh interval, and credit reserve. It is not a scheduler. The six-hour default
interval fits occasional free-tier browsing; quotes are labeled stale after five
minutes and hidden after 24 hours or at kickoff. Running the command repeatedly
does not bypass those protections.

See [odds setup and architecture](../docs/ODDS_INTEGRATION.md) for configuration,
current-cache semantics, local mocks, and operating the sync command. Provider
selection, verified prices, and limitations are in
[provider notes](../docs/PROVIDER_NOTES.md).

## Database and authentication

- Schema: `lib/db/schema.ts`; committed SQL and metadata: `drizzle/`.
- `lib/db/client.ts` uses the Neon serverless WebSocket driver in the Node runtime.
  Each request closes its pool in `finally`; importing it needs no credentials.
- `GET /api/me` retrieves your profile. `POST /api/me` accepts `username` and
  optional `displayName`. There is no profile edit endpoint in this milestone.
- Requests carry a Cognito **access token** in `Authorization: Bearer …`. The
  server verifies signature, issuer, expiry, client ID, and token use before
  resolving the subject. Client-supplied identity fields are rejected.
- Unique database constraints protect registration across retries and races.
  Repeated creation returns the first profile without overwriting it.
- The SQL migration includes a database trigger maintaining `updated_at`.
  Timestamps use `timestamptz`; API responses serialize UTC ISO strings.

```sh
npm run db:generate   # Generate SQL after schema changes; review and commit it
npm run db:migrate    # Explicitly apply outstanding migrations
```

Migration commands load Next.js environment files, including `.env.local`.
Exported variables take precedence. Generation works without database credentials.
Migrations never run on server startup or during builds. Do not use schema push
against shared environments.

## Validation

```sh
npm run typecheck
npm test
npm run lint
npm run build
```

Unit/API tests need no credentials. Token tests use real RSA signatures with local
test keys; only JWKS retrieval is stubbed. The production build needs no database
or Cognito credentials. The existing Google Fonts setup requires network access.

Integration tests use real PostgreSQL and the committed migration in an isolated
temporary schema. They cover persistence across connections, uniqueness,
concurrent registration, account isolation, migration replay, and odds ingestion/
cache behavior. Provider tests use fixtures and mocked HTTP, never live odds.
Integration tests fail
explicitly without `TEST_DATABASE_URL`, never fall back to `DATABASE_URL`, and
never silently skip coverage. For example, with Docker running:

```sh
docker run --rm --name rkvtk-profile-test \
  -e POSTGRES_PASSWORD=local-test-only -e POSTGRES_DB=rkvtk_test \
  -p 127.0.0.1:55432:5432 -d postgres:17
# Wait for readiness: docker exec rkvtk-profile-test pg_isready -U postgres
TEST_DATABASE_URL='postgresql://postgres:local-test-only@127.0.0.1:55432/rkvtk_test' npm run test:integration
docker stop rkvtk-profile-test
```

An existing disposable PostgreSQL instance also works. The database name must end
in `_test`, and the account needs create/drop schema permission. Tests clean up
only their generated schema. Run integration tests before merging database changes.

## Amplify Hosting

See [database and Amplify setup](../docs/DATABASE_SETUP.md) for `WEB_COMPUTE`
runtime configuration, secret handling, migration sequencing, and rollback.
Existing deployment settings are preserved. No AWS or Neon resources are created.
The odds sync command also needs server-side environment configuration wherever
it runs. Automated production refresh requires a separately configured scheduler;
it is not performed by Amplify SSR requests or the browser.
See [API contracts](../docs/API_CONTRACTS.md) for response and error behavior.
