export type NFLTeam = { id: string; name: string; abbreviation: string };

const teams: [string, string, string][] = [
  ["ari", "Arizona Cardinals", "ARI"], ["atl", "Atlanta Falcons", "ATL"],
  ["bal", "Baltimore Ravens", "BAL"], ["buf", "Buffalo Bills", "BUF"],
  ["car", "Carolina Panthers", "CAR"], ["chi", "Chicago Bears", "CHI"],
  ["cin", "Cincinnati Bengals", "CIN"], ["cle", "Cleveland Browns", "CLE"],
  ["dal", "Dallas Cowboys", "DAL"], ["den", "Denver Broncos", "DEN"],
  ["det", "Detroit Lions", "DET"], ["gb", "Green Bay Packers", "GB"],
  ["hou", "Houston Texans", "HOU"], ["ind", "Indianapolis Colts", "IND"],
  ["jax", "Jacksonville Jaguars", "JAX"], ["kc", "Kansas City Chiefs", "KC"],
  ["lv", "Las Vegas Raiders", "LV"], ["lac", "Los Angeles Chargers", "LAC"],
  ["lar", "Los Angeles Rams", "LAR"], ["mia", "Miami Dolphins", "MIA"],
  ["min", "Minnesota Vikings", "MIN"], ["ne", "New England Patriots", "NE"],
  ["no", "New Orleans Saints", "NO"], ["nyg", "New York Giants", "NYG"],
  ["nyj", "New York Jets", "NYJ"], ["phi", "Philadelphia Eagles", "PHI"],
  ["pit", "Pittsburgh Steelers", "PIT"], ["sf", "San Francisco 49ers", "SF"],
  ["sea", "Seattle Seahawks", "SEA"], ["tb", "Tampa Bay Buccaneers", "TB"],
  ["ten", "Tennessee Titans", "TEN"], ["was", "Washington Commanders", "WAS"],
];

// These application IDs remain stable when a provider changes a display name.
// Name resolution is restricted to this adapter-boundary whitelist.
export const NFL_TEAMS: Readonly<Record<string, NFLTeam>> = Object.freeze(Object.fromEntries(
  teams.map(([id, name, abbreviation]) => [`nfl:${id}`, Object.freeze({ id: `nfl:${id}`, name, abbreviation })]),
));
const byName = new Map(Object.values(NFL_TEAMS).map((team) => [team.name.toLowerCase(), team]));
for (const [alias, id] of [["LA Rams", "nfl:lar"], ["LA Chargers", "nfl:lac"]]) {
  byName.set(alias.toLowerCase(), NFL_TEAMS[id]);
}

export function resolveTeam(nameOrId: unknown): NFLTeam | null {
  if (typeof nameOrId !== "string") return null;
  return (Object.hasOwn(NFL_TEAMS, nameOrId) ? NFL_TEAMS[nameOrId] : null)
    ?? byName.get(nameOrId.trim().toLowerCase()) ?? null;
}
