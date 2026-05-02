# Troubleshooting & Known Quirks

This document catalogs discovered behavior, common errors, and parameter gotchas for the Sportfolio platform and its external data integrations.

---

## Platform Rules

### No Mock Data
**Never use mock, sample, or placeholder data.** All displayed data must come from live API sources. If data is unavailable, show empty states or loading indicators.

### Shares Persist Across Seasons
Player holdings never expire. A user's shares of Stephen Curry in 2025 are the exact same shares in 2026, 2027, and beyond. Only `player_game_stats` tracks seasonality.

---

## MCP Server Quirks

### `content` vs `structuredContent`
Every tool response has both fields. `content` is LLM-facing fluff ("Found 4 player result(s)."). **Real data lives in `structuredContent`.** Code that only reads `content` will appear to get no data.

```python
# ✅ Correct
data = result["structuredContent"]

# ❌ Wrong
summary = result["content"][0]["text"]  # Just a sentence, not the data
```

### Staged Actions Require Confirmation
All write operations return a `pendingBundle`. You **must** call `confirm_pending_action` with `threadId` and `pendingBundleId`. There is no direct execution.

### `get_market_data` Does Not Exist
There is no tool named `get_market_data`. Use:
- `get_market_scanners` for scanner buckets
- `search_players` for price discovery
- `list_market_opportunities` for top picks
- `get_player_detail` for per-player market context

### No Bulk Price API
There is no single tool that returns prices for all players. Prices must be fetched per-player via `get_player_detail` or discovered through `search_players` / `get_market_scanners`.

### `get_player_recent_games` May Return Empty
Some active players return no recent game data even when they have recorded stats. This is a server-side data gap, not a parameter error.

### Schema Sensitivity
Several MLB tools are strict about parameter shapes and will 500 if given incompatible values:
- `get_standings` — 500s on some season/parameter combinations
- `get_team_roster` — season format must match server expectations exactly
- `get_boxscore` — `gameId` format must be exact

When a tool 500s, test with **minimal params first**, then iterate.

### CamelCase Only
All parameter keys are camelCase:
```python
# ✅ Correct
{"playerId": "mlb_596", "slotTier": 2}

# ❌ Wrong
{"player_id": "mlb_596", "slot_tier": 2}
```

### Leader Categories Are Strings
`mlb_mcp__get_league_leader_data` expects `leader_categories` as a **single string**, not an array:
```python
# ✅ Correct
{"leader_categories": "homeRuns"}

# ❌ Wrong
{"leader_categories": ["homeRuns"]}
```

---

## Boost System

### Must Own Shares to Boost
Daily boosts require owning at least 1 share of the target player. The workflow is:
1. `stage_market_buy` → `confirm_pending_action`
2. `stage_daily_boost_assign` → `confirm_pending_action`

### `slotTier` Is Required
`stage_daily_boost_assign` requires `slotTier` (integer, typically 1–4). Omitting it produces a schema error.

### Boost Consumes Exactly 1 Share
Your available share count drops by 1 when a boost is applied. The share is locked in the boost slot for that day.

---

## Statcast Truncation

### Problem
Large Statcast responses (~80–150K chars) are truncated by the MCP server at ~8K chars.

### Solution: Pagination
Use `start_row` and `end_row` parameters. This returns a clean, untruncated slice:
```python
client.call_tool("mlb_mcp__get_statcast_batter_exitvelo_barrels", {
    "year": 2026,
    "start_row": 0,
    "end_row": 50
})
```

### Strategy for "Top N"
1. Fetch rows 0–50
2. Parse full JSON
3. Sort locally by desired metric
4. Take top N

This is more reliable than `get_league_leader_data` for Statcast metrics (exit velocity, barrels, xwOBA) because the leaderboard tool only supports traditional counting stats.

---

## MySportsFeeds

### Rate Limiting
- **Throttle:** 5-second backoff between requests
- **Ceiling:** ~100 requests / minute
- **Mitigation:** Use `force=false` to hit cached data

### Season Keywords
- `current` — Returns 400 during offseason
- `latest` — Safe year-round (most recent completed or in-progress season)
- `upcoming` — Future season that has been added but not started

### LIVE Tier Not Included
In-progress game stats do not stream live. They update every ~15 minutes via the Daily Games endpoint.

---

## Unusable Tools

Four visualization tools require a **pandas DataFrame object** as input. They cannot be called via text-based MCP:

- `create_strike_zone_plot`
- `create_spraychart_plot`
- `create_bb_profile_plot`
- `create_teams_plot`

These are notebook-only tools.

---

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Pool is not initialized for this player yet.` | Player has no AMM pool | Trade not possible until pool is created |
| `Daily boosts always consume exactly one available share...` | Insufficient shares for target player | Buy at least 1 share first |
| `invalid_type` on `leader_categories` | Passed an array instead of a string | Pass a single category string |
| `Method not allowed` | GET instead of POST, or missing JSON-RPC method | Use POST with valid `method` field |
| `No valid session ID provided` | Missing `mcp-session-id` header | Run `initialize` first, extract session ID |
| `Invalid token` / `Unauthorized` | Wrong auth format or expired token | Use `Authorization: Bearer <token>` exactly |
| `Not Acceptable` | Missing `Accept` header | Add `Accept: application/json, text/event-stream` |
| `Response truncated (N chars).` | Payload exceeded ~8K char limit | Use `start_row`/`end_row` or narrow filters |
| 500 from `get_standings` | Incompatible parameter combination | Test with minimal params, iterate |

---

## Domain Separation Checklist

When analyzing or reporting, keep these separate:

- [ ] **MLB on-field stats** → exit velocity, OPS, ERA, Statcast percentiles
- [ ] **Sportfolio market data** → share prices, volume, market cap
- [ ] **Sportfolio game mechanics** → scouts, boosts, LP positions, milestones

Do not conflate them in summaries or trading advice.
