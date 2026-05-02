# Sportfolio — Fantasy Sports Stock Market Platform

A fantasy sports trading platform where users buy and sell shares of professional athletes like stocks. Built with real-time market data, player mining mechanics, and a Robinhood-inspired trading interface.

**Live:** [sportfolio.market](https://www.sportfolio.market)

---

## Quickstart

```bash
# Install dependencies
npm install

# Development (requires DATABASE_URL)
npm run dev

# Production build
npm run build
npm start
```

### Required Environment Variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `MYSPORTSFEEDS_API_KEY` | Live sports data (NBA schedule, rosters, stats) |
| `SPORTFOLIO_MCP_TOKEN` | Agent-facing MCP server auth |

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | React 18, TypeScript, Vite, TanStack Query, Wouter, Tailwind CSS, Radix UI |
| Backend | Express.js, TypeScript, Drizzle ORM, WebSockets |
| Database | PostgreSQL (Neon serverless) |
| Data Sources | MySportsFeeds API (NBA), MLB StatsAPI / pybaseball via MCP |
| Auth | Replit Auth (Google, GitHub, email/password) |

---

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — System design, WebSocket events, cache invalidation, database schema
- **[MCP_INTEGRATION.md](MCP_INTEGRATION.md)** — Agent API surface: 140+ tools, staged actions, response shapes, truncation handling
- **[EXTERNAL_APIS.md](EXTERNAL_APIS.md)** — MySportsFeeds and MLB StatsAPI data source documentation
- **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** — Known quirks, common errors, parameter gotchas
- **[design_guidelines.md](design_guidelines.md)** — UI/UX design system (Robinhood + Bloomberg Terminal hybrid)

---

## Core Rules

1. **No mock data.** All player stats, prices, and schedules come from live APIs. If data is unavailable, show empty states or loading indicators.
2. **Shares persist across seasons.** A user's holdings never expire. Player identity is tied to a global ID (e.g., MySportsFeeds numeric ID) that remains constant year over year.
3. **All write operations are staged.** Trades, scout assignments, boosts, and LP actions require explicit confirmation via a two-step flow.

---

## Public vs. Authenticated Access

| Feature | Public (no auth) | Authenticated |
|---------|------------------|---------------|
| Browse contests | ✅ | ✅ |
| View leaderboards | ✅ | ✅ |
| View player prices | ✅ | ✅ |
| Trade shares | ❌ | ✅ |
| Enter contests | ❌ | ✅ |
| Mine players | ❌ | ✅ |
| Boost / Scout | ❌ | ✅ |

---

## License

MIT
