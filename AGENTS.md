# RkVTk engineering instructions

## Product contract
- RkVTk is **free-to-play simulation only**. Never implement deposits, cash-outs, real wagers, or links that submit real bets.
- V1 sports: **NFL only** (`americanfootball_nfl`). Markets: moneyline (`h2h`), spread (`spreads`), total (`totals`), and cross-game parlays. No player props, in-play bets, or same-game parlays in V1.
- Compare **DraftKings and FanDuel** quotes through a permitted data provider. Never scrape bookmaker sites or rely on unofficial authentication bypasses.
- A user can commit **10.0 units per Eastern-time ISO week** in 0.1u increments. Winnings never increase the allowance; no rollover. Wagers remain attributed to their placement week even if settled later.
- Simulated odds are immutable after acceptance. The backend chooses the quote and checks staleness/start time; the browser cannot dictate the final accepted price.

## Code and architecture
- Next.js 15 App Router, React, TypeScript, PostgreSQL, Drizzle, Amplify Gen 2 (Cognito Google auth), and AWS Lambda/EventBridge for scheduled workers.
- Prefer a modular monolith with pure functions under `lib/domain`. Avoid microservices, message brokers, Redis or WebSockets without measured need.
- The Odds API integration lives behind `lib/providers/odds-provider.ts`. Store provider IDs and timestamps; never use display names as primary IDs.
- In a single database transaction, verify identity, deduplicate the idempotency key, verify up-to-date quotes, commit weekly stake atomically, and create the wager and legs. A concurrent request must never exceed 100 tenths.
- Settlement is idempotent, replayable and auditable; avoid dual sources of balance/P&L truth. Use `settlement_events` for corrections. Push/void handling must adjust parlay payout fairly.
- AI receives deterministic SQL-derived counts. Never ask the LLM to grade results or invent pick counts.
- Date windows use `America/New_York`, including DST; store timestamps in UTC.

## Implementation style
- Inspect existing code and tests first. Make small, reviewable changes, keep `README.md` and `docs/` updated.
- Validate with `npm run typecheck`, `npm test`, and `npm run build` after meaningful changes. Add unit/integration tests for transaction races, duplicate jobs, outages, changed odds, pushes, and delayed/corrected results.
- Never store credentials or user data in the repository. Keep `.env.local`, `amplify_outputs.json`, and keys ignored.
- Do not create paid AWS resources, run `npx ampx sandbox`, deploy, modify remote IAM/Cognito, or purchase odds/API plans without explicit user approval. If changing infrastructure, describe expected cost and rollback.
- Do not copy original Onyx take-home source, production secrets, or databases. This is a new independent project.

## Suggested build order
1. Identity and profiles
2. DB migration and odds sync
3. Atomic placement endpoint
4. Scheduled result ingestion and settlement
5. Social feed and leaderboards
6. AI consensus, AWS jobs, deployment, observability

See `docs/IMPLEMENTATION_PLAN.md` and `docs/API_CONTRACTS.md` before implementing milestones.
