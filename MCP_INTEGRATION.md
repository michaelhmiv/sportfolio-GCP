# MCP Integration

Sportfolio exposes a Model Context Protocol (MCP) server at `https://www.sportfolio.market/mcp` for agent integrations. This document describes the ~140 tool API surface, authentication, response semantics, and known quirks.

---

## Authentication

```
Authorization: Bearer <SPORTFOLIO_MCP_TOKEN>
Content-Type: application/json
Accept: application/json, text/event-stream
```

The server is stateful: you must call `initialize` first, capture the `mcp-session-id` response header, and include it on all subsequent requests.

---

## Tool Catalog

Tools are grouped by domain. **R** = read-only. **W** = write/state-changing.

### Account

| Tool | Type | Description |
|------|------|-------------|
| `get_balance_state` | R | Cash balance, open boost slots, community shares |
| `get_account_profile` | R | Core profile (username, balance, premium status) |
| `get_activity_feed` | R | Account activity feed |
| `list_api_tokens` | R | List API tokens |
| `revoke_api_token` | W | Revoke a token |
| `update_username` | W | Update username |
| `update_profile_image` | W | Update profile image |
| `complete_onboarding` | W | Mark onboarding complete |

### Market

| Tool | Type | Description |
|------|------|-------------|
| `list_market_opportunities` | R | Strongest current market-facing opportunities |
| `get_market_scanners` | R | Scanner buckets (undervalued, premium, sentiment, momentum) |
| `get_amm_pool_state` | R | AMM pool state for a player |
| `get_trade_quote` | R | Buy or sell quote preview |
| `get_trade_history` | R | Recent market activity for user |
| `stage_market_buy` | W | Stage a buy order |
| `stage_market_sell` | W | Stage a sell order |

### Players

| Tool | Type | Description |
|------|------|-------------|
| `search_players` | R | Search by name, team, position |
| `get_player_detail` | R | Detail, stats, recent games, market context, holding state |
| `get_player_stats` | R | Season stats |
| `get_player_recent_games` | R | Recent game logs |
| `get_player_financial_metrics` | R | Market and financial metrics |
| `get_player_shares_info` | R | Share structure info |

### Portfolio

| Tool | Type | Description |
|------|------|-------------|
| `get_portfolio_summary` | R | Summary + operator overview |
| `get_holdings` | R | Holdings, multiplier state, available shares |
| `get_portfolio_history` | R | Portfolio history snapshots |
| `get_holding_multiplier_state` | R | Multiplier & share state for a player |
| `stage_stack_shares` | W | Stage Stack Shares action |

### Scouting

| Tool | Type | Description |
|------|------|-------------|
| `get_scout_status` | R | Scout count, assignment totals, next distribution |
| `list_scout_assignments` | R | Current scout assignments |
| `list_scout_opportunities` | R | Platform-recommended targets |
| `get_scout_roster` | R | Who else is scouting a player |
| `stage_scout_assignment` | W | Stage scout reallocation |

### Boosts

| Tool | Type | Description |
|------|------|-------------|
| `list_daily_boosts` | R | Active daily boosts |
| `list_daily_boost_history` | R | Recent boost history & payouts |
| `list_daily_boost_eligible_players` | R | Holdings eligible for daily boost |
| `list_boost_candidates` | R | Ranked best daily boost candidates |
| `stage_daily_boost_assign` | W | Stage a boost assignment |
| `stage_daily_boost_remove` | W | Stage a boost removal |

### Liquidity (LP)

| Tool | Type | Description |
|------|------|-------------|
| `list_lp_positions` | R | User's LP positions |
| `get_lp_position` | R | Single LP position by player ID |
| `list_lp_history` | R | Recent LP transaction history |
| `get_lp_zap_quote` | R | Preview quote for single-sided LP zap |
| `stage_lp_add` | W | Stage fixed-ratio LP add |
| `stage_lp_add_optimal` | W | Stage optimal-ratio LP add |
| `stage_lp_zap_add` | W | Stage single-sided LP zap |
| `stage_lp_remove` | W | Stage LP removal |

### Games

| Tool | Type | Description |
|------|------|-------------|
| `get_games_today` | R | Games for today or requested date |
| `get_game_insights` | R | Game-centric view with user context |

### Dashboard & Advisory

| Tool | Type | Description |
|------|------|-------------|
| `get_dashboard_overview` | R | Composed overview: balance, portfolio, boosts, scouts, watchlists |
| `review_idle_cash` | R | Idle balance deployment context |
| `review_portfolio_cleanup` | R | Stale / overexposed cleanup levers |
| `review_setup` | R | Broad gameplay setup review |

### Watchlists

| Tool | Type | Description |
|------|------|-------------|
| `list_watchlists` | R | User's watchlists |
| `list_watchlist_player_ids` | R | Every player ID across watchlists |
| `get_watchlist_items` | R | Player IDs in a watchlist |
| `create_watchlist` | W | Create watchlist |
| `update_watchlist` | W | Update watchlist |
| `delete_watchlist` | W | Delete watchlist |
| `add_watchlist_player` | W | Add player to watchlist |
| `remove_watchlist_player` | W | Remove player from watchlist |

### Threads (Agent Conversations)

| Tool | Type | Description |
|------|------|-------------|
| `list_agent_threads` | R | Recent agent threads |
| `get_thread_state` | R | Thread state & messages |
| `list_thread_messages` | R | Messages for a thread |
| `list_thread_research_sources` | R | Research sources attached |
| `get_pending_action` | R | Active pending action bundle |
| `create_agent_thread` | W | Create agent thread |
| `send_agent_message` | W | Send message into thread |
| `confirm_pending_action` | W | **Finalize** staged pending action |
| `cancel_pending_action` | W | **Cancel** staged pending action |

### MLB StatsAPI / pybaseball

~40 read-only tools exposing StatsAPI and pybaseball data:

`get_stats`, `get_schedule`, `get_player_stats`, `get_standings`, `get_team_leaders`, `lookup_player`, `get_boxscore`, `get_team_roster`, `get_game_pace`, `get_meta`, `get_available_endpoints`, `get_notes`, `get_game_scoring_play_data`, `get_last_game`, `get_league_leader_data`, `get_linescore`, `get_next_game`, `get_game_highlight_data`, `get_statcast_data`, `get_statcast_batter_data`, `get_statcast_pitcher_data`, `get_statcast_batter_exitvelo_barrels`, `get_statcast_pitcher_exitvelo_barrels`, `get_statcast_batter_expected_stats`, `get_statcast_pitcher_expected_stats`, `get_statcast_batter_percentile_ranks`, `get_statcast_pitcher_percentile_ranks`, `get_statcast_batter_pitch_arsenal`, `get_statcast_pitcher_pitch_arsenal`, `get_statcast_single_game`, `create_strike_zone_plot`, `create_spraychart_plot`, `create_bb_profile_plot`, `create_teams_plot`, `get_pitching_stats_bref`, `get_pitching_stats_range`, `get_pitching_stats`, `get_playerid_lookup`, `reverse_lookup_player`, `get_schedule_and_record`, `get_player_splits`, `get_pybaseball_standings`, `get_team_batting`, `get_team_fielding`, `get_team_pitching`, `get_top_prospects`

---

## Critical Semantics

### `content` vs `structuredContent`

Every tool result has **two** top-level fields:

| Field | Purpose |
|-------|---------|
| `content` | Natural-language summary: `[{type: "text", text: "Found 4 player result(s)."}]` |
| `structuredContent` | **Actual JSON payload** with arrays, objects, IDs, prices |

**Always read `structuredContent` first.** Code that only reads `content` will appear to get no data.

```python
result = client.call_tool("search_players", {"query": "Alvarez"})
data = result.get("structuredContent", result)   # ← correct
players = data.get("results", [])                  # ← actual array
```

### Staged Confirmation Flow

All state-changing operations (trades, scout assignments, boosts, LP actions) use a **two-step stage/confirm flow**:

1. **Stage** the action → receive a `pendingBundle` with `threadId` and `pendingBundleId`
2. **Confirm** via `confirm_pending_action` with those IDs

```python
# Step 1: Stage
resp = client.call_tool("stage_market_buy", {
    "playerId": "mlb_596",
    "amount": 10
})
sc = resp["structuredContent"]
thread_id = sc["threadId"]
bundle_id = sc["pendingBundle"]["id"]

# Step 2: Confirm
client.call_tool("confirm_pending_action", {
    "threadId": thread_id,
    "pendingBundleId": bundle_id
})
```

**Never execute state-changing tools directly without confirmation.**

---

## Response Shape Examples

### `search_players`
```json
{
  "summary": "Found 4 player result(s).",
  "results": [
    {
      "id": "mlb_596",
      "firstName": "Yordan",
      "lastName": "Alvarez",
      "fullName": "Yordan Alvarez",
      "sport": "MLB",
      "team": "HOU",
      "position": "OF",
      "lastTradePrice": null,
      "priceChange24h": "0.00"
    }
  ]
}
```

### `get_balance_state`
```json
{
  "availableBalance": 3077,
  "openDailyBoostSlots": 4,
  "communitySharesAvailable": 58
}
```

### `get_portfolio_summary`
```json
{
  "summary": "Loaded portfolio summary.",
  "operatorOverview": {
    "availableBalance": 3077,
    "portfolioPlayerCount": 6,
    "totalPlayerShares": 38700,
    "topHoldings": [
      {
        "playerId": "mlb_555",
        "name": "Garrett Crochet",
        "sport": "MLB",
        "shares": 8580,
        "multiplier": 1,
        "availableShares": 8580,
        "nextGameAt": "2026-05-01T23:10:00.000Z"
      }
    ]
  }
}
```

### `stage_market_buy` (success)
```json
{
  "threadId": "uuid",
  "pendingBundleId": "uuid",
  "summary": "Buy $10.00 of Cam Schlittler",
  "warnings": [
    "Pool prices can move before you confirm, so the final fill can differ slightly from the preview."
  ],
  "confirmationRequired": true,
  "pendingBundle": {
    "id": "uuid",
    "status": "pending_confirmation",
    "actions": [
      {
        "playerId": "mlb_2183925",
        "sbAmount": 10,
        "actionType": "pool_buy",
        "playerName": "Cam Schlittler",
        "maxSlippage": 0.05,
        "estimatedSharesOut": 1.3923,
        "availableBalanceAfter": 3067,
        "estimatedPricePerShare": 7.3255,
        "estimatedSlippagePercent": 1.0920
      }
    ]
  }
}
```

### `get_market_scanners`
```json
{
  "summary": "Loaded ALL market scanners.",
  "sport": "ALL",
  "scanners": {
    "undervalued": [
      {
        "player": {
          "id": "mlb_2183925",
          "firstName": "Cam",
          "lastName": "Schlittler",
          "currentPrice": "7.2463768115942029",
          "priceChange24h": "0.00",
          "volume24h": 0
        }
      }
    ],
    "premium": [],
    "sentiment": [],
    "momentum": [],
    "summary": []
  }
}
```

---

## Parameter Conventions

| What you might guess | Actual field name |
|----------------------|-------------------|
| `player_id` | `playerId` |
| `shares` | `quantity` (holdings), `amount` (trades) |
| `price` | `currentPrice`, `lastTradePrice` |
| `price_change_24h` | `priceChange24h` |
| `volume_24h` | `volume24h` |
| `avg_price` | `avgCostBasis` |
| `available_balance` | `availableBalance` |
| `open_boost_slots` | `openDailyBoostSlots` |
| `total_shares` | `totalSharesOutstanding` |
| `user_holding` | `userHolding` |
| `first_name` | `firstName` |
| `full_name` | `fullName` |

**All parameter keys are camelCase.** Do not use snake_case.

### Leaderboard Tools Quirk

`mlb_mcp__get_league_leader_data` accepts `leader_categories` as a **string**, not an array:

```python
# ✅ Correct
client.call_tool("mlb_mcp__get_league_leader_data", {
    "leader_categories": "homeRuns",
    "season": 2026,
    "limit": 5,
    "stat_group": "hitting"
})

# ❌ Wrong — produces "invalid_type" error
client.call_tool("mlb_mcp__get_league_leader_data", {
    "leader_categories": ["homeRuns"]
})
```

---

## Truncation Handling

Large Statcast and schedule responses are aggressively truncated by the MCP server (~8K char limit). Instead of parsing truncation envelopes, use **pagination parameters** where available.

### Statcast Pagination

All Statcast leaderboard tools accept `start_row` and `end_row`. When provided, the server returns only that slice — **no truncation**.

```python
# Returns exactly 5 players, ~3K chars, never truncated
client.call_tool("mlb_mcp__get_statcast_batter_exitvelo_barrels", {
    "year": 2026,
    "start_row": 0,
    "end_row": 5
})
```

| Tool | Pagination Works? | Max Safe Rows |
|------|-------------------|---------------|
| `get_statcast_batter_exitvelo_barrels` | ✅ | ~50 |
| `get_statcast_batter_expected_stats` | ✅ | ~50 |
| `get_statcast_batter_percentile_ranks` | ✅ | ~50 |
| `get_statcast_pitcher_exitvelo_barrels` | ✅ | ~50 |
| `get_statcast_pitcher_expected_stats` | ✅ | ~50 |
| `get_statcast_pitcher_percentile_ranks` | ✅ | ~50 |
| `get_statcast_data` | ❌ | Use narrow date ranges |
| `get_pitching_stats_range` | ❌ | Use narrow date ranges |

**Strategy for "top N by X":**
1. Call with `start_row=0, end_row=50`
2. Parse full JSON
3. Sort locally by desired metric
4. Take top N

### Affected Tools (High Truncation Risk)

| Tool | Typical Size |
|------|-------------|
| `get_statcast_batter_exitvelo_barrels` | ~150K chars |
| `get_statcast_batter_expected_stats` | ~100K chars |
| `get_statcast_batter_percentile_ranks` | ~80K chars |
| `get_statcast_pitcher_*` | ~80-120K chars |
| `get_schedule` | ~20-50K chars |
| `get_team_roster` | ~5-15K chars |
| `get_pybaseball_standings` | ~5K chars |

---

## Unusable Tools

Four visualization tools require a **pandas DataFrame object** as input. They cannot be used via text-based MCP:

- `create_strike_zone_plot`
- `create_spraychart_plot`
- `create_bb_profile_plot`
- `create_teams_plot`

These are designed for interactive Jupyter/notebook use only.

---

## Domain Separation

Keep these three domains separate in analysis and reporting:

1. **MLB on-field stats** → exit velocity, OPS, ERA, Statcast percentiles (from `mlb_mcp__*` tools)
2. **Sportfolio market data** → share prices, volume, market cap (from `search_players`, `get_player_detail`, etc.)
3. **Sportfolio game mechanics** → scouts, boosts, LP positions, milestones (from `get_scout_status`, `list_daily_boosts`, etc.)
