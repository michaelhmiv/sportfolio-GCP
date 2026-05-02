# External Data Sources

Sportfolio sources live sports data from two primary providers: **MySportsFeeds** (NBA schedules, rosters, and game statistics) and **MLB StatsAPI / pybaseball** (MLB data via the embedded MCP server).

---

## MySportsFeeds (NBA)

### Authentication
- **Method:** Basic Auth
- **Username:** Your API Key
- **Password:** `MYSPORTSFEEDS`
- **Base URL:** `https://api.mysportsfeeds.com/v2.1/pull/nba`

### Subscription Tiers

| Tier | Included? | Data |
|------|-----------|------|
| **CORE** | ✅ Base | Games, schedule, venues, current season |
| **STATS** | ✅ Addon | Player gamelogs, team gamelogs, seasonal stats, standings |
| **DETAILED** | ❌ | Boxscore, play-by-play, lineup, injuries, player database |
| **ODDS** | ❌ | Game lines, futures |
| **PROJECTIONS** | ❌ | DFS projections, player projections |
| **DFS** | ❌ | Daily fantasy data |
| **EXTRAS** | ❌ | Draft information |

### Rate Limits
- **Throttle:** 5-second backoff between requests
- **Max:** ~100 requests / minute
- **Tip:** Set `force=false` to use cached data and avoid throttling restrictions

### Season Format
- Pattern: `{start_year}-{end_year}-{type}`
- Examples: `2025-2026-regular`, `2024-playoff`
- Keywords: `current`, `latest`, `upcoming`

### Key Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/{season}/games.{format}` | All games for a season |
| `/{season}/date/{date}/games.{format}` | Games on a specific date |
| `/{season}/date/{date}/player_gamelogs.{format}` | Player stats per game |
| `/{season}/player_stats_totals.{format}` | Season totals per player |
| `/{season}/standings.{format}` | League standings |
| `/current_season.{format}` | Current season metadata |

### Game Status Values
- `unplayed` — Scheduled
- `in-progress` — Live
- `postgame-reviewing` — Over, under review
- `final` — Confirmed final

### LIVE Tier Note
The LIVE tier is **not** included. In-progress game stats update every ~15 minutes via the **Daily Games** endpoint.

---

## MLB StatsAPI / pybaseball (via MCP)

MLB data is served through ~40 embedded tools inside the Sportfolio MCP server. These wrap the official MLB StatsAPI and the `pybaseball` Python library.

### Tool Categories

| Category | Tools |
|----------|-------|
| **Lookup** | `lookup_player`, `get_playerid_lookup`, `reverse_lookup_player` |
| **Schedule / Standings** | `get_schedule`, `get_standings`, `get_pybaseball_standings`, `get_schedule_and_record` |
| **Player Stats** | `get_player_stats`, `get_league_leader_data`, `get_team_leaders`, `get_player_splits` |
| **Game Data** | `get_boxscore`, `get_linescore`, `get_last_game`, `get_next_game`, `get_game_pace`, `get_game_scoring_play_data`, `get_game_highlight_data`, `get_statcast_single_game` |
| **Statcast — Batters** | `get_statcast_batter_exitvelo_barrels`, `get_statcast_batter_expected_stats`, `get_statcast_batter_percentile_ranks`, `get_statcast_batter_pitch_arsenal` |
| **Statcast — Pitchers** | `get_statcast_pitcher_exitvelo_barrels`, `get_statcast_pitcher_expected_stats`, `get_statcast_pitcher_percentile_ranks`, `get_statcast_pitcher_pitch_arsenal` |
| **Team Stats** | `get_team_batting`, `get_team_fielding`, `get_team_pitching`, `get_team_roster` |
| **Pitching** | `get_pitching_stats`, `get_pitching_stats_bref`, `get_pitching_stats_range` |
| **Prospects** | `get_top_prospects` |
| **Meta** | `get_meta`, `get_available_endpoints`, `get_notes` |
| **Visualization** | `create_strike_zone_plot`, `create_spraychart_plot`, `create_bb_profile_plot`, `create_teams_plot` |

### Player ID Lookup

```python
# Requires "last" (required). Optional "first".
client.call_tool("mlb_mcp__get_playerid_lookup", {
    "last": "Holmes",
    "first": "Grant"
})
```

### Statcast: Exit Velocity Leaders

```python
client.call_tool("mlb_mcp__get_statcast_batter_exitvelo_barrels", {
    "year": 2026,
    "start_row": 0,
    "end_row": 10
})
```

### Traditional Leaderboards

Valid `leader_categories` strings:

- **Hitting:** `homeRuns`, `avg`, `ops`, `slg`, `rbi`, `stolenBases`, `hits`, `doubles`, `triples`, `runs`, `baseOnBalls`, `strikeouts`, `totalBases`, `groundIntoDoublePlay`, `hitByPitch`
- **Pitching:** `wins`, `era`, `strikeouts`, `whip`, `saves`, `holds`, `inningsPitched`, `baseOnBalls`, `hits`, `runs`, `homeRuns`

```python
client.call_tool("mlb_mcp__get_league_leader_data", {
    "leader_categories": "homeRuns",
    "season": 2026,
    "limit": 5,
    "stat_group": "hitting"
})
```

---

## Data Freshness

| Source | Update Frequency | Latency |
|--------|-----------------|---------|
| MySportsFeeds NBA schedule | Cron: daily | ~1 day |
| MySportsFeeds live scores | Cron: every minute | ~1 minute |
| MySportsFeeds game stats | Cron: hourly | ~1 hour |
| MLB StatsAPI / pybaseball | On-demand via MCP | Real-time (API dependent) |
| Contest settlement | Cron: every 5 minutes | ~5 minutes |

---

## Response Codes

### MySportsFeeds
- `200` — Success
- `304` — Not Modified (when `force=false`)
- `400` — Bad Request (e.g., invalid season keyword during offseason)
- `404` — Not Found

### MLB StatsAPI (via MCP)
- Tool responses are wrapped in the MCP envelope
- Server-side 500s may occur for schema-sensitive tools (e.g., `get_standings` with incompatible params)
- See [MCP_INTEGRATION.md](MCP_INTEGRATION.md) for truncation and pagination strategies
