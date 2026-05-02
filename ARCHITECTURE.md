# System Architecture

## Overview

Sportfolio is a full-stack fantasy sports stock market. The frontend is a React SPA; the backend is an Express server with PostgreSQL persistence and WebSocket broadcasting. All market data and player statistics are sourced live from external APIs.

---

## Frontend

### Stack
- **React 18** + TypeScript + Vite
- **Wouter** for lightweight routing
- **TanStack Query** for server state and caching
- **Tailwind CSS** + **Radix UI** (via shadcn/ui) for components
- **Recharts** for charts and sparklines

### Design System
- **Typography:** Inter for UI, JetBrains Mono for prices and financial data
- **Layout:** 12-column grid on desktop, single-column on mobile
- **Theme:** Dark mode by default (toggleable to light)
- **Reference:** [design_guidelines.md](design_guidelines.md) — Robinhood + Bloomberg Terminal hybrid

### Key Patterns

#### Cache Invalidation
A centralized utility (`client/src/lib/cache-invalidation.ts`) invalidates all portfolio-related queries on every mutation (trade, mining, contest entry, cash operation) and every WebSocket event. This guarantees zero stale data across Dashboard, Portfolio, Marketplace, Player pages, and the persistent header balance.

```typescript
// Used by all mutations and WebSocket handlers
invalidatePortfolioQueries();
```

#### Real-Time Updates (WebSocket)
A single shared WebSocket connection (`client/src/lib/websocket.tsx`) auto-reconnects on disconnect (3-second delay) and broadcasts events to all subscribed components.

| Page | Events Subscribed |
|------|-------------------|
| Dashboard | `portfolio`, `mining`, `trade` |
| Marketplace | `trade`, `orderBook` |
| Portfolio | `portfolio`, `trade`, `orderBook` |
| Player Pages | `trade`, `orderBook`, `portfolio` |
| Header Balance | `portfolio` |
| Global Leaderboards | `mining`, `portfolio`, `trade` |
| Contest Leaderboards | `contestUpdate`, `liveStats` |

**WebSocket Event Types:**
- `portfolio` — balance/holdings changes
- `mining` — mining activity
- `trade` — trade executions
- `orderBook` — order book changes
- `liveStats` — live game stat updates
- `contestUpdate` — contest state changes

### Mobile-First
- Bottom tab bar navigation on mobile
- Responsive card layouts that collapse to single column
- Optimized touch targets and condensed data views

---

## Backend

### Stack
- **Express.js** with TypeScript
- **Drizzle ORM** for type-safe SQL
- **PostgreSQL** (Neon serverless)
- **Zod** for request/response validation
- **Custom WebSocket server** for live broadcasts

### Domain Models
- `users` — accounts, balances, premium status
- `players` — athlete identity, sport, team, position
- `holdings` — user share ownership (persists across seasons)
- `orders` / `trades` — market activity
- `mining` — share generation over time
- `contests` / `contest_entries` / `contest_lineups` — fantasy contest system
- `player_game_stats` — seasonal game statistics
- `price_history` — historical price data

### Critical: Player Share Persistence

Player shares are **permanent across all seasons**. Each player has a globally unique ID (e.g., MySportsFeeds numeric ID "9218" for Stephen Curry) that never changes. When a user owns 100 shares, those exact shares persist into future seasons. Only `player_game_stats` tracks seasonality via a `season` field — player identity and ownership never change.

### API Design
- **REST** for data endpoints (JSON)
- **WebSocket** for live price and trade updates
- **Atomic balance updates** for all financial operations
- **Timezone handling:** All NBA scheduling uses Eastern Time via `date-fns-tz`

### Background Jobs (Cron)

| Job | Frequency | Purpose |
|-----|-----------|---------|
| `roster_sync` | Daily | Sync player rosters from MySportsFeeds |
| `schedule_sync` | Every minute | Update live game scores |
| `stats_sync` | Hourly | Pull completed game statistics |
| `settle_contests` | Every 5 minutes | Grade contest entries and distribute payouts |

---

## Authentication

- **Replit Auth** for production (Google, GitHub, email/password OAuth)
- PostgreSQL-backed session storage
- Automatic user creation on first login (`upsertUser` pattern)
- New users receive **$10,000 starting balance** automatically

---

## Database Indexing Strategy

| Table | Indexed Columns | Reason |
|-------|----------------|--------|
| `holdings` | `user_id`, `player_id` | Fast portfolio lookups |
| `orders` | `player_id`, `status`, `created_at` | Order book queries |
| `trades` | `buyer_id`, `seller_id`, `player_id`, `created_at` | Trade history |
| `player_game_stats` | `player_id`, `season`, `game_date` | Seasonal stat queries |
| `contest_entries` | `contest_id`, `user_id` | Leaderboard aggregation |

---

## External Data Flow

```
MySportsFeeds API (NBA)
    ↓
Backend Cron Jobs
    ↓
PostgreSQL (players, schedules, stats, game logs)
    ↓
Express REST API + WebSocket
    ↓
React Frontend (TanStack Query + WebSocket listeners)
```

MLB data follows a separate path via the embedded MCP server (see [MCP_INTEGRATION.md](MCP_INTEGRATION.md)).

---

## Deployment

Built for containerized deployment (Cloud Run / Railway). The production build bundles the frontend via Vite and the backend via esbuild into a single `dist/` directory.

```bash
npm run build   # vite build + esbuild server bundle
npm start       # NODE_ENV=production node dist/index.js
```
