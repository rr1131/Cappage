import "server-only";
import { authenticatedSubject } from "../auth/identity";
import { withDatabase } from "../db/client";
import { configuredProviderName } from "../providers/odds-provider";
import { oddsHandlers } from "./http";
import { oddsRepository } from "./repository";
import { oddsSettings } from "./settings";

// Reads never construct a provider or perform upstream requests. This remains
// true when the cache is empty, stale, or the upstream key is misconfigured.
export const nflHandlers = oddsHandlers({
  authenticate: authenticatedSubject,
  listGames: (now, days) => withDatabase((db) => oddsRepository(db, oddsSettings()).listGames(configuredProviderName(), now, days)),
  gameOdds: (gameId, now) => withDatabase((db) => oddsRepository(db, oddsSettings()).gameOdds(configuredProviderName(), gameId, now)),
});
