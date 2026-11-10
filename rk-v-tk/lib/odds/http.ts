import "server-only";
import { ProfileError } from "../domain/profile";
import type { oddsRepository } from "./repository";
import { OddsError } from "./errors";

type Repository = ReturnType<typeof oddsRepository>;
type Dependencies = {
  authenticate: (request: Request) => Promise<string>;
  listGames: (now: Date, days: number) => ReturnType<Repository["listGames"]>;
  gameOdds: (gameId: string, now: Date) => ReturnType<Repository["gameOdds"]>;
  clock?: () => Date;
};
function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store", Vary: "Authorization" } });
}
function failure(error: unknown) {
  if (error instanceof ProfileError || error instanceof OddsError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  return json({ error: { code: "SERVICE_UNAVAILABLE", message: "NFL odds are temporarily unavailable. Please try again." } }, 503);
}
const invalid = () => new OddsError("INVALID_PARAMETERS", "Provide valid NFL game parameters.", 400);

export function oddsHandlers(deps: Dependencies) {
  return {
    async games(request: Request) {
      try {
        await deps.authenticate(request);
        const params = new URL(request.url).searchParams;
        if ([...params.keys()].some((key) => key !== "days") || params.getAll("days").length > 1) throw invalid();
        const raw = params.get("days") ?? "14";
        if (!/^([1-9]|1[0-4])$/.test(raw)) throw invalid();
        return json(await deps.listGames(deps.clock?.() ?? new Date(), Number(raw)));
      } catch (error) { return failure(error); }
    },
    async odds(request: Request, gameId: string) {
      try {
        await deps.authenticate(request);
        if (new URL(request.url).search || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(gameId)) throw invalid();
        return json(await deps.gameOdds(gameId, deps.clock?.() ?? new Date()));
      } catch (error) { return failure(error); }
    },
  };
}
