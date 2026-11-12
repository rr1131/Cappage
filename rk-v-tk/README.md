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
the cached dataset. Mock games are labeled as demo data. Page entry and the manual
refresh control request a shared refresh, subject to the server's limits, then
read the cache. There is no automatic network polling.

## Odds ingestion

`ODDS_PROVIDER=mock` is the default. The mock provider needs no upstream API key,
but normal database and Cognito setup still applies. To use the selected external
provider, configure `ODDS_PROVIDER=the-odds-api` and a server-only `ODDS_API_KEY`
in `.env.local`. Real ingestion also requires `ODDS_BILLING_ANCHOR`: a confirmed
UTC instant when the provider's usage credits reset. The account owner confirmed
the first of each month at 00:00 UTC. Set
`ODDS_BILLING_ANCHOR=2027-11-01T00:00:00Z` locally and in the Amplify server runtime;
this fixed anchor repeats monthly and does not need monthly edits. See
[reset configuration](../docs/ODDS_INTEGRATION.md#configuration).

Defaults cap paid ingestion at **300 credits per configured monthly period**,
**three paid attempts per Eastern calendar day**, and **at least six hours between
paid attempts**, including failed requests. Each paid call reserves three credits
atomically in PostgreSQL; ambiguous failures keep that reservation. All app
instances and CLI invocations using this allocation must share the same database.
Separate databases using the same API key cannot coordinate these limits.

`npm run odds:sync` runs once and obeys the same lease, budgets, cooldown, and
upstream credit reserve as the browser's authenticated refresh request. No
scheduler or idle ingestion runs. Quotes are labeled stale after five minutes and
hidden after 24 hours or at kickoff; the cost controls intentionally permit stale
display data between refreshes. This milestone does not accept wagers.

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

Integration tests use real PostgreSQL and the committed migrations in isolated
temporary databases. They cover persistence across connections, uniqueness,
concurrent registration, account isolation, migration replay, and odds ingestion/
cache behavior. Provider tests use fixtures and mocked HTTP, never live odds.
Budget tests cover concurrent reservations, daily/monthly boundaries, and failed
paid attempts. Integration tests fail explicitly without `TEST_DATABASE_URL`,
never fall back to `DATABASE_URL`, and
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
in `_test`, and the account needs permission to create/drop test databases. Tests
clean up only their generated databases. Run integration tests before merging database changes.

## Amplify Hosting

See [database and Amplify setup](../docs/DATABASE_SETUP.md) for `WEB_COMPUTE`
runtime configuration, secret handling, migration sequencing, and rollback.

Keep the committed lockfile compatible with Node 22/npm 10 as well as local
macOS installs. npm 10 requires a separate esbuild `0.28.2` installation for
Vitest's nested Vite optional peer; the lockfile includes all 26 platform packages
at that location, including `@esbuild/linux-x64`. Having them only under `tsx`
can pass local npm 11 installation but fail npm 10's `npm ci` validation.
To repair lock metadata, copy `package.json` and the existing `package-lock.json`
to a temporary directory without `node_modules`, then run:

```sh
npm exec --yes --package=npm@10.9.4 -- npm install --package-lock-only --include=optional --ignore-scripts --no-audit --no-fund
```

Review the diff before copying the repaired lockfile back; preserve existing
versions and platform metadata. Do not delete the lockfile or upgrade packages
to repair missing platform entries. Validate with a clean Linux x64 `npm ci`
and `npm run build`. Amplify's existing `npm ci` command needs no change.
The repaired lockfile was verified in a fresh Linux x64 container with Node
22.23.5/npm 10.9.9: the original lockfile failed with missing esbuild entries,
and the repaired lockfile completed `npm ci` with install scripts enabled.
Existing deployment settings are preserved. No AWS or Neon resources are created.
The odds sync command also needs server-side environment configuration wherever
it runs. The existing `amplify:env` allowlist includes the server-only provider
key, quota-reset anchor, and limits. Authenticated page-entry/manual refreshes
use the same ingestion service as the CLI; GET endpoints only read cached data.
No scheduler, Redis, or new AWS resources are introduced. Existing hosting and
database requests can still incur charges under their configured plans.
See [API contracts](../docs/API_CONTRACTS.md) for response and error behavior.
