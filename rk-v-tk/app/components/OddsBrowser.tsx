"use client";

import { fetchAuthSession } from "aws-amplify/auth";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import styles from "./OddsBrowser.module.css";

type Market = "h2h" | "spreads" | "totals";
type Bookmaker = "draftkings" | "fanduel";
type Selection = "home" | "away" | "over" | "under";
type Game = {
  id: string;
  homeTeam: { id: string; name: string };
  awayTeam: { id: string; name: string };
  startsAt: string;
  status: "scheduled";
  league: "NFL";
  seasonYear: number;
  seasonSource: "derived";
};
type FeedMeta = {
  provider: "mock" | "the-odds-api";
  isMock: boolean;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  nextRefreshAt: string | null;
  stale: boolean;
  refreshError: string | null;
  asOf: string;
};
type Quote = {
  id: string;
  revision: number;
  gameId: string;
  bookmaker: Bookmaker;
  market: Market;
  selection: Selection;
  point: number | null;
  americanOdds: number;
  decimalOdds: number;
  providerUpdatedAt: string;
  ingestedAt: string;
  stale: boolean;
  freshUntil?: string;
  expiresAt?: string;
};
type GamesResponse = { games: Game[]; meta: FeedMeta };
type OddsResponse = {
  game: Game;
  quotes: Quote[];
  markets: { bookmaker: Bookmaker; market: Market; available: boolean; complete: boolean }[];
  meta: FeedMeta;
};

const markets: { key: Market; label: string; description: string }[] = [
  { key: "h2h", label: "Moneyline", description: "Compare each team's price to win." },
  { key: "spreads", label: "Spread", description: "Compare the handicap and price together; lines may differ by sportsbook." },
  { key: "totals", label: "Total", description: "Compare the over/under line and price for combined game points." },
];
const books: { key: Bookmaker; name: string }[] = [
  { key: "draftkings", name: "DraftKings" },
  { key: "fanduel", name: "FanDuel" },
];

const kickoffFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit", timeZoneName: "short",
});
const updatedFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

function formatTime(value: string, kickoff = false) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : (kickoff ? kickoffFormatter : updatedFormatter).format(date);
}

function signed(value: number) { return value > 0 ? `+${value}` : String(value); }

async function getOddsData<T>(path: string, signal: AbortSignal, method = "GET"): Promise<T> {
  const { tokens } = await fetchAuthSession();
  if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
  if (!tokens?.accessToken) throw new Error("Sign in again to browse NFL odds.");
  const response = await fetch(path, {
    method, signal, cache: "no-store", headers: { Authorization: `Bearer ${tokens.accessToken.toString()}` },
  });
  const data = await response.json().catch(() => {
    throw new Error("The odds service is temporarily unavailable. Please try again.");
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("Your session has expired. Sign in again to browse NFL odds.");
    if (data.error?.code === "ODDS_NOT_SYNCED") {
      throw new Error("NFL odds are not available yet. Please check back shortly.");
    }
    if (response.status === 404) throw new Error("This game is no longer available. Refresh the game list to see upcoming games.");
    throw new Error(data.error?.message ?? "Unable to load NFL odds. Please try again.");
  }
  return data as T;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unable to load NFL odds. Please try again.";
}

function QuoteCell({ quote, market, now }: { quote: Quote | undefined; market: Market; now: number }) {
  if (!quote) return <td className={styles.quoteCell}><span className={styles.unavailable}>Unavailable</span></td>;
  if (quote.expiresAt && Date.parse(quote.expiresAt) <= now) {
    return <td className={styles.quoteCell}><span className={styles.unavailable}>Quote expired</span></td>;
  }
  const stale = quote.stale || (quote.freshUntil ? Date.parse(quote.freshUntil) <= now : false);
  return (
    <td className={styles.quoteCell}>
      <div className={styles.price}>
        {market !== "h2h" && quote.point !== null && (
          <span className={styles.line}>{market === "spreads" ? signed(quote.point) : quote.point}</span>
        )}
        <strong>{signed(quote.americanOdds)}</strong>
      </div>
      <span className={styles.decimal}>{quote.decimalOdds.toFixed(3)} decimal</span>
      <time className={styles.quoteTime} dateTime={quote.providerUpdatedAt}>
        Updated {formatTime(quote.providerUpdatedAt)}
      </time>
      {stale && <span className={styles.staleLabel}>Stale quote</span>}
    </td>
  );
}

export default function OddsBrowser() {
  const [gamesData, setGamesData] = useState<GamesResponse | null>(null);
  const [gamesLoading, setGamesLoading] = useState(true);
  const [gamesError, setGamesError] = useState("");
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [oddsData, setOddsData] = useState<OddsResponse | null>(null);
  const [oddsLoading, setOddsLoading] = useState(false);
  const [oddsError, setOddsError] = useState("");
  const [market, setMarket] = useState<Market>("h2h");
  const [refresh, setRefresh] = useState(0);
  const [oddsRefresh, setOddsRefresh] = useState(0);
  const [refreshError, setRefreshError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const deadlines = [
      ...(gamesData?.games.map((game) => game.startsAt) ?? []),
      ...(oddsData?.quotes.flatMap((quote) => [quote.freshUntil, quote.expiresAt]) ?? []),
    ].filter((value): value is string => typeof value === "string").map(Date.parse);
    const nextDeadline = deadlines.filter((deadline) => deadline > now).sort((a, b) => a - b)[0];
    if (nextDeadline === undefined) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(nextDeadline - Date.now() + 25, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [gamesData, oddsData, now]);

  useEffect(() => {
    const controller = new AbortController();
    setGamesLoading(true);
    setGamesError("");
    setRefreshError("");
    // Demand is expressed once on entry or a deliberate refresh. Even when an
    // update fails, the last successful shared cache remains available to read.
    const loadGames = async () => {
      try {
        await getOddsData("/api/nfl/refresh", controller.signal, "POST");
      } catch (error) {
        if (controller.signal.aborted) throw error;
        setRefreshError("The latest odds update is unavailable. Showing stored prices where available.");
      }
      return getOddsData<GamesResponse>("/api/nfl/games", controller.signal);
    };
    loadGames().then((data) => {
      if (controller.signal.aborted) return;
      const sorted = [...data.games].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
      setGamesData({ ...data, games: sorted });
      setSelectedGameId((current) => sorted.some((game) => game.id === current) ? current : sorted[0]?.id ?? null);
      setOddsRefresh((value) => value + 1);
      setNow(Date.now());
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setGamesError(errorMessage(error));
    }).finally(() => { if (!controller.signal.aborted) setGamesLoading(false); });
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (!selectedGameId || gamesLoading) {
      setOddsData(null);
      setOddsLoading(false);
      setOddsError("");
      return;
    }
    const controller = new AbortController();
    setOddsLoading(true);
    setOddsError("");
    setOddsData(null);
    getOddsData<OddsResponse>(`/api/nfl/games/${encodeURIComponent(selectedGameId)}/odds`, controller.signal).then((data) => {
      if (!controller.signal.aborted) setOddsData(data);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setOddsError(errorMessage(error));
    }).finally(() => { if (!controller.signal.aborted) setOddsLoading(false); });
    return () => controller.abort();
  }, [selectedGameId, oddsRefresh, gamesLoading]);

  const selectedGame = gamesData?.games.find((game) => game.id === selectedGameId);
  const selectedMarket = markets.find((entry) => entry.key === market)!;
  const visibleOdds = oddsData?.game.id === selectedGameId ? oddsData : null;
  const started = selectedGame ? Date.parse(selectedGame.startsAt) <= now : false;
  const selections: Selection[] = market === "totals" ? ["over", "under"] : ["away", "home"];
  const meta = visibleOdds?.meta ?? gamesData?.meta;
  const hasAgedQuotes = visibleOdds?.quotes.some((quote) => quote.stale || (quote.freshUntil ? Date.parse(quote.freshUntil) <= now : false));

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const key = event.key;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
    event.preventDefault();
    const next = key === "Home" ? 0 : key === "End" ? markets.length - 1 :
      (index + (key === "ArrowRight" ? 1 : -1) + markets.length) % markets.length;
    setMarket(markets[next].key);
    tabRefs.current[next]?.focus();
  }

  return (
    <section className={styles.browser} aria-labelledby="nfl-odds-heading">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>NFL · Pregame</p>
          <h2 id="nfl-odds-heading">Compare the lines</h2>
          <p className={styles.intro}>DraftKings and FanDuel prices, side by side. Free-to-play simulation only.</p>
        </div>
        <button className={styles.refreshButton} type="button" disabled={gamesLoading || oddsLoading}
          onClick={() => setRefresh((value) => value + 1)}>
          {gamesLoading ? "Loading…" : "Refresh odds"}
        </button>
      </header>

      {refreshError && <p className={styles.notice} role="status">{refreshError}</p>}

      {meta && (
        <div className={styles.feedInfo}>
          <span className={meta.isMock ? styles.demoBadge : styles.sourceBadge}>
            {meta.isMock ? "Demo data · Not current odds" : "Source: The Odds API"}
          </span>
          {meta.lastSuccessAt && <span>Last received <time dateTime={meta.lastSuccessAt}>{formatTime(meta.lastSuccessAt)}</time></span>}
        </div>
      )}
      {meta && (meta.stale || meta.refreshError || hasAgedQuotes) && (
        <p className={styles.notice} role="status">
          {meta.refreshError ? "The latest odds update is unavailable. " : ""}
          {meta.stale || hasAgedQuotes ? "Stored prices may be out of date. Check each quote's update time." : "Showing the most recently received prices."}
        </p>
      )}
      {gamesError && <p className={styles.error} role="alert">{gamesError}</p>}
      {gamesLoading && !gamesData && <p className={styles.empty} role="status">Loading upcoming NFL games…</p>}
      {!gamesLoading && !gamesError && gamesData?.games.length === 0 && (
        <div className={styles.empty}>
          <h3>No upcoming games</h3>
          <p>NFL games will appear here when scheduling data is available.</p>
        </div>
      )}

      {!!gamesData?.games.length && (
        <div className={styles.content}>
          <div className={styles.gameList} aria-busy={gamesLoading}>
            <h3>Upcoming games</h3>
            <p className={styles.timezone}>All times Eastern</p>
            <ul>
              {gamesData.games.map((game) => (
                <li key={game.id}>
                  <button type="button" className={`${styles.gameButton} ${selectedGameId === game.id ? styles.selectedGame : ""}`}
                    aria-pressed={selectedGameId === game.id} aria-controls="nfl-game-odds"
                    onClick={() => setSelectedGameId(game.id)}>
                    <time dateTime={game.startsAt}>{formatTime(game.startsAt, true)}</time>
                    <span className={styles.teamName}>{game.awayTeam.name}</span>
                    <span className={styles.homeTeam}><span>at </span>{game.homeTeam.name}</span>
                    {Date.parse(game.startsAt) <= now && <span className={styles.staleLabel}>Pregame closed</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div id="nfl-game-odds" className={styles.details} aria-busy={oddsLoading}>
            {selectedGame && (
              <>
                <div className={styles.matchup}>
                  <p className={styles.eyebrow}>{selectedGame.seasonYear} NFL season</p>
                  <h3>{selectedGame.awayTeam.name} <span>at</span> {selectedGame.homeTeam.name}</h3>
                  <time dateTime={selectedGame.startsAt}>{formatTime(selectedGame.startsAt, true)}</time>
                </div>
                <div className={styles.tabs} role="tablist" aria-label="Odds market">
                  {markets.map((entry, index) => (
                    <button key={entry.key} type="button" role="tab" id={`odds-tab-${entry.key}`}
                      aria-selected={market === entry.key} aria-controls="odds-market-panel" tabIndex={market === entry.key ? 0 : -1}
                      ref={(element) => { tabRefs.current[index] = element; }}
                      onKeyDown={(event) => moveTab(event, index)} onClick={() => setMarket(entry.key)}>
                      {entry.label}
                    </button>
                  ))}
                </div>
                <div id="odds-market-panel" role="tabpanel" aria-labelledby={`odds-tab-${market}`} tabIndex={0}>
                  <p className={styles.marketDescription}>{selectedMarket.description}</p>
                  {started ? <p className={styles.empty} role="status">Pregame odds are closed because the scheduled kickoff has passed.</p> : (
                    <>
                      {oddsLoading && <p className={styles.empty} role="status">Loading sportsbook prices…</p>}
                      {oddsError && <p className={styles.error} role="alert">{oddsError}</p>}
                      {visibleOdds && !oddsLoading && (
                        <>
                          <table className={styles.oddsTable}>
                            <caption className={styles.srOnly}>{selectedMarket.label} odds for {selectedGame.awayTeam.name} at {selectedGame.homeTeam.name}</caption>
                            <thead><tr><th scope="col">Selection</th>{books.map((book) => <th key={book.key} scope="col">{book.name}</th>)}</tr></thead>
                            <tbody>{selections.map((selection) => (
                              <tr key={selection}>
                                <th scope="row">{selection === "home" ? selectedGame.homeTeam.name : selection === "away" ? selectedGame.awayTeam.name : selection === "over" ? "Over" : "Under"}
                                  {(selection === "home" || selection === "away") && <span className={styles.selectionRole}>{selection}</span>}
                                </th>
                                {books.map((book) => <QuoteCell key={book.key} market={market} now={now}
                                  quote={visibleOdds.quotes.find((quote) => quote.market === market && quote.bookmaker === book.key && quote.selection === selection)} />)}
                              </tr>
                            ))}</tbody>
                          </table>
                          {books.map((book) => {
                            const availability = visibleOdds.markets.find((entry) => entry.bookmaker === book.key && entry.market === market);
                            return availability && !availability.complete ? (
                              <p key={book.key} className={styles.availability}>{book.name}: {availability.available ? "This market is incomplete; some selections are unavailable." : "This market is currently unavailable."}</p>
                            ) : null;
                          })}
                        </>
                      )}
                    </>
                  )}
                </div>
                <p className={styles.footnote}>Prices are for comparison. No wagers can be placed here.</p>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
