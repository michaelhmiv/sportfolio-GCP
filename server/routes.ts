import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer } from "ws";
import { storage } from "./storage";
import { fetchActivePlayers, calculateFantasyPoints, fetchPlayerSeasonStats, fetchPlayerGameLogs } from "./mysportsfeeds";
import type { InsertPlayer, Player, User, Holding } from "@shared/schema";
import { jobScheduler } from "./jobs/scheduler";
import { addClient, removeClient, broadcast } from "./websocket";
import { calculateAccrualUpdate } from "@shared/mining-utils";
import { createContests } from "./jobs/create-contests";

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);

  // Initialize WebSocket server
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    addClient(ws);
    ws.on('close', () => removeClient(ws));
  });

  // Helper: Get authenticated user ID from session
  const getUserId = (req: any): string => {
    return "some-user-id";
  };

  // Helper: Get last trade price for a player
  async function getLastTradePrice(playerId: string): Promise<string | null> {
    const recentTrades = await storage.getRecentTrades(playerId, 1);
    return recentTrades.length > 0 ? recentTrades[0].price : null;
  }

  // Helper: Enrich player data with last trade price (market value)
  async function enrichPlayerWithMarketValue(player: Player): Promise<Player & { lastTradePrice: string | null }> {
    // Get last trade price if not already in the database
    let lastTradePrice: string | null = player.lastTradePrice;
    if (!lastTradePrice) {
      lastTradePrice = await getLastTradePrice(player.id);
    }
    return {
      ...player,
      lastTradePrice, // null if no trades, otherwise the last traded price
    };
  }

  // Helper: Calculate P&L for holdings - returns null values if no market price exists
  function calculatePnL(quantity: number, avgCost: string, lastTradePrice: string | null) {
    // If no market price exists (no trades), return null values
    if (!lastTradePrice) {
      return {
        currentValue: null,
        pnl: null,
        pnlPercent: null,
      };
    }
    
    const cost = parseFloat(avgCost);
    const price = parseFloat(lastTradePrice);
    const totalValue = quantity * price;
    const totalCost = quantity * cost;
    const pnl = totalValue - totalCost;
    const pnlPercent = totalCost > 0 ? (pnl / totalCost) * 100 : 0;
    
    return {
      currentValue: totalValue.toFixed(2),
      pnl: pnl.toFixed(2),
      pnlPercent: pnlPercent.toFixed(2),
    };
  }

  // Helper: Accrue mining shares based on elapsed time
  async function accrueMiningShares(userId: string) {
    const user = await storage.getUser(userId);
    if (!user) return;

    const miningData = await storage.getMining(userId);
    if (!miningData) return;
    
    // Check if using multi-player mining (splits)
    const splits = await storage.getMiningSplits(userId);
    const usingSplits = splits.length > 0;
    
    // If using splits but no splits configured, or using single player but no player selected, return
    if (!usingSplits && !miningData.playerId) return;

    const now = new Date();
    // Force non-premium rates for demo user (100 shares/hour total, 2400 cap)
    const capLimit = 2400;
    const totalSharesPerHour = 100;

    // If already at cap, don't accrue more - clear residual time
    if (miningData.sharesAccumulated >= capLimit) {
      if (!miningData.capReachedAt || miningData.residualMs !== 0) {
        await storage.updateMining(userId, { 
          capReachedAt: now,
          residualMs: 0,
          updatedAt: now,
        });
      }
      return;
    }

    // Initialize lastAccruedAt if missing (fallback to updatedAt or now)
    const effectiveLastAccruedAt = miningData.lastAccruedAt || miningData.updatedAt || now;
    
    // If we had to initialize, update the database immediately
    if (!miningData.lastAccruedAt) {
      await storage.updateMining(userId, {
        lastAccruedAt: effectiveLastAccruedAt,
        updatedAt: now,
      });
    }

    // Use shared utility to calculate accrual update
    const update = calculateAccrualUpdate({
      sharesAccumulated: miningData.sharesAccumulated,
      residualMs: miningData.residualMs || 0,
      lastAccruedAt: effectiveLastAccruedAt,
      sharesPerHour: totalSharesPerHour,
      capLimit,
    }, now);

    // Only update if shares were actually earned
    const sharesEarned = update.sharesAccumulated - miningData.sharesAccumulated;
    if (sharesEarned > 0) {
      await storage.updateMining(userId, {
        sharesAccumulated: update.sharesAccumulated,
        residualMs: update.residualMs,
        lastAccruedAt: update.lastAccruedAt,
        updatedAt: now,
        capReachedAt: update.capReached ? now : null,
      });
    }
    // If no shares earned yet, DON'T update anything - leave baseline unchanged
  }

  // Helper: Match orders (FIFO) - Only for limit orders
  async function matchOrders(playerId: string) {
    const orderBook = await storage.getOrderBook(playerId);
    const player = await storage.getPlayer(playerId);
    
    if (!player) return;

    // Match buy and sell limit orders
    for (const buyOrder of orderBook.bids) {
      if (buyOrder.status !== "open" || buyOrder.filledQuantity >= buyOrder.quantity) continue;
      if (!buyOrder.limitPrice) continue; // Skip if no limit price (shouldn't happen for limit orders)

      for (const sellOrder of orderBook.asks) {
        if (sellOrder.status !== "open" || sellOrder.filledQuantity >= sellOrder.quantity) continue;
        if (!sellOrder.limitPrice) continue; // Skip if no limit price (shouldn't happen for limit orders)

        // Check if prices match
        const buyPrice = parseFloat(buyOrder.limitPrice);
        const sellPrice = parseFloat(sellOrder.limitPrice);
        
        if (buyPrice >= sellPrice) {
          // Execute trade
          const remainingBuy = buyOrder.quantity - buyOrder.filledQuantity;
          const remainingSell = sellOrder.quantity - sellOrder.filledQuantity;
          const tradeQuantity = Math.min(remainingBuy, remainingSell);
          const tradePrice = sellPrice; // Price-time priority

          // Create trade record
          await storage.createTrade({
            playerId,
            buyerId: buyOrder.userId,
            sellerId: sellOrder.userId,
            buyOrderId: buyOrder.id,
            sellOrderId: sellOrder.id,
            quantity: tradeQuantity,
            price: tradePrice.toFixed(2),
          });

          // Update orders
          const newBuyFilled = buyOrder.filledQuantity + tradeQuantity;
          const newSellFilled = sellOrder.filledQuantity + tradeQuantity;

          await storage.updateOrder(buyOrder.id, {
            filledQuantity: newBuyFilled,
            status: newBuyFilled >= buyOrder.quantity ? "filled" : "partial",
          });

          await storage.updateOrder(sellOrder.id, {
            filledQuantity: newSellFilled,
            status: newSellFilled >= sellOrder.quantity ? "filled" : "partial",
          });

          // Update holdings for buyer (Average Cost Method)
          const buyerHolding = await storage.getHolding(buyOrder.userId, "player", playerId);
          if (buyerHolding) {
            const newQuantity = buyerHolding.quantity + tradeQuantity;
            const newTotalCost = parseFloat(buyerHolding.totalCostBasis) + (tradeQuantity * tradePrice);
            const newAvgCost = newTotalCost / newQuantity;
            await storage.updateHolding(buyOrder.userId, "player", playerId, newQuantity, newAvgCost.toFixed(4));
          } else {
            await storage.updateHolding(buyOrder.userId, "player", playerId, tradeQuantity, tradePrice.toFixed(4));
          }

          // Update holdings for seller
          const sellerHolding = await storage.getHolding(sellOrder.userId, "player", playerId);
          if (sellerHolding) {
            const newQuantity = sellerHolding.quantity - tradeQuantity;
            await storage.updateHolding(sellOrder.userId, "player", playerId, newQuantity, sellerHolding.avgCostBasis);
          }

          // Update balances
          const buyer = await storage.getUser(buyOrder.userId);
          const seller = await storage.getUser(sellOrder.userId);
          
          if (buyer && seller) {
            const tradeCost = tradeQuantity * tradePrice;
            await storage.updateUserBalance(buyOrder.userId, (parseFloat(buyer.balance) - tradeCost).toFixed(2));
            await storage.updateUserBalance(sellOrder.userId, (parseFloat(seller.balance) + tradeCost).toFixed(2));
          }

          // Update player price
          await storage.upsertPlayer({
            ...player,
            currentPrice: tradePrice.toFixed(2),
            volume24h: player.volume24h + tradeQuantity,
          });

          // Broadcast updates after each match iteration
          broadcast({
            type: "trade",
            playerId,
            price: tradePrice.toFixed(2),
            quantity: tradeQuantity,
          });
          
          broadcast({ type: "orderBook", playerId }); // Update order book depth in real-time
          
          // Broadcast portfolio updates for both parties
          const updatedBuyer = await storage.getUser(buyOrder.userId);
          const updatedSeller = await storage.getUser(sellOrder.userId);
          if (updatedBuyer) {
            broadcast({ type: "portfolio", userId: buyOrder.userId, balance: updatedBuyer.balance });
          }
          if (updatedSeller) {
            broadcast({ type: "portfolio", userId: sellOrder.userId, balance: updatedSeller.balance });
          }
        }
      }
    }
  }

  // API ROUTES

  // Auth endpoints
  app.get("/api/auth/user", async (req: any, res) => {
    try {
      const userId = "some-user-id";
      const user = await storage.getUser(userId);
      res.json(user);
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ error: "Failed to fetch user" });
    }
  });

  // Dashboard
  app.get("/api/dashboard", async (req, res) => {
    try {
      const userId = "some-user-id";
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      // Accrue mining shares based on elapsed time
      await accrueMiningShares(user.id);
      
      const allPlayers = await storage.getPlayers();
      const userHoldings = await storage.getUserHoldings(user.id);
      const allContests = await storage.getContests("open");
      const recentTrades = await storage.getRecentTrades(undefined, 10);
      const miningData = await storage.getMining(user.id);

      // Calculate portfolio value
      let portfolioValue = 0;
      for (const holding of userHoldings) {
        if (holding.assetType === "player") {
          const player = await storage.getPlayer(holding.assetId);
          if (player) {
            portfolioValue += holding.quantity * parseFloat(player.currentPrice);
          }
        }
      }

      // Get hot players (top 5 by 24h volume) with market values
      const hotPlayersRaw = allPlayers
        .sort((a, b) => b.volume24h - a.volume24h)
        .slice(0, 5);
      const hotPlayers = await Promise.all(hotPlayersRaw.map(enrichPlayerWithMarketValue));

      // Get top 3 holdings by value
      const topHoldings = [];
      for (const holding of userHoldings) {
        if (holding.assetType === "player") {
          const player = await storage.getPlayer(holding.assetId);
          if (player) {
            const enrichedPlayer = await enrichPlayerWithMarketValue(player);
            const { currentValue, pnl, pnlPercent } = calculatePnL(
              holding.quantity,
              holding.avgCostBasis,
              enrichedPlayer.lastTradePrice
            );
            topHoldings.push({
              player: enrichedPlayer,
              quantity: holding.quantity,
              value: currentValue,
              pnl,
              pnlPercent,
            });
          }
        }
      }
      // Sort by value, putting null values at the end
      topHoldings.sort((a, b) => {
        if (a.value === null && b.value === null) return 0;
        if (a.value === null) return 1;
        if (b.value === null) return -1;
        return parseFloat(b.value) - parseFloat(a.value);
      });

      // Get mining data
      const miningSplits = await storage.getMiningSplits(user.id);
      let miningPlayer = undefined;
      let miningPlayers: Array<{ player: Player | undefined; sharesPerHour: number }> = [];
      
      if (miningSplits.length > 0) {
        // Multi-player mining
        miningPlayers = await Promise.all(
          miningSplits.map(async (split) => ({
            player: await storage.getPlayer(split.playerId),
            sharesPerHour: split.sharesPerHour,
          }))
        );
      } else if (miningData?.playerId) {
        // Legacy single-player mining
        miningPlayer = await storage.getPlayer(miningData.playerId);
      }

      res.json({
        user: {
          balance: user.balance,
          portfolioValue: portfolioValue.toFixed(2),
        },
        hotPlayers,
        mining: miningData ? {
          ...miningData,
          player: miningPlayer,
          players: miningPlayers,
          capLimit: 2400,
          sharesPerHour: 100,
        } : null,
        contests: allContests.slice(0, 5),
        recentTrades: await Promise.all(
          recentTrades.map(async (trade) => ({
            ...trade,
            player: await storage.getPlayer(trade.playerId),
          }))
        ),
        topHoldings: topHoldings.slice(0, 3),
        portfolioHistory: [], // Placeholder
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Today's games (in ET timezone where NBA games are scheduled)
  app.get("/api/games/today", async (req, res) => {
    try {
      // Get current time in ET timezone
      const now = new Date();
      const etOffset = -5; // ET is UTC-5 (EST) or UTC-4 (EDT), using -5 for simplicity
      const nowET = new Date(now.getTime() + (etOffset * 60 * 60 * 1000));
      
      // Get start and end of day in ET, then convert back to UTC for database query
      const startOfDayET = new Date(nowET.getFullYear(), nowET.getMonth(), nowET.getDate(), 0, 0, 0);
      const endOfDayET = new Date(nowET.getFullYear(), nowET.getMonth(), nowET.getDate(), 23, 59, 59);
      
      // Convert ET boundaries to UTC for database query
      const startOfDayUTC = new Date(startOfDayET.getTime() - (etOffset * 60 * 60 * 1000));
      const endOfDayUTC = new Date(endOfDayET.getTime() - (etOffset * 60 * 60 * 1000));
      
      const games = await storage.getDailyGames(startOfDayUTC, endOfDayUTC);
      res.json(games);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Games for a specific date (YYYY-MM-DD format)
  app.get("/api/games/date/:date", async (req, res) => {
    try {
      const { date } = req.params;
      
      // Parse the date string (expected format: YYYY-MM-DD)
      const dateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!dateMatch) {
        return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
      }
      
      const [, year, month, day] = dateMatch;
      const etOffset = -5; // ET is UTC-5 (EST) or UTC-4 (EDT), using -5 for simplicity
      
      // Create date in ET timezone
      const startOfDayET = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), 0, 0, 0);
      const endOfDayET = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), 23, 59, 59);
      
      // Convert ET boundaries to UTC for database query
      const startOfDayUTC = new Date(startOfDayET.getTime() - (etOffset * 60 * 60 * 1000));
      const endOfDayUTC = new Date(endOfDayET.getTime() - (etOffset * 60 * 60 * 1000));
      
      const games = await storage.getDailyGames(startOfDayUTC, endOfDayUTC);
      res.json(games);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Game stats - get player box scores for a specific game
  app.get("/api/games/:gameId/stats", async (req, res) => {
    try {
      const { gameId } = req.params;
      const gameIdNum = parseInt(gameId);
      
      if (isNaN(gameIdNum)) {
        return res.status(400).json({ error: "Invalid game ID" });
      }
      
      // Get all player stats for this game
      const stats = await storage.getGameStatsByGameId(gameIdNum);
      
      if (!stats || stats.length === 0) {
        return res.json({
          gameId,
          homeTeam: { players: [], totals: null },
          awayTeam: { players: [], totals: null },
          topPerformers: null,
          message: "No stats available yet"
        });
      }

      // Get player details for all stats
      const statsWithPlayers = await Promise.all(
        stats.map(async (stat) => {
          const player = await storage.getPlayer(stat.playerId);
          return {
            playerId: stat.playerId,
            playerName: player ? `${player.firstName} ${player.lastName}` : 'Unknown',
            team: player?.team || stat.opponentTeam,
            minutes: stat.minutes,
            points: stat.points,
            threePointersMade: stat.threePointersMade,
            rebounds: stat.rebounds,
            assists: stat.assists,
            steals: stat.steals,
            blocks: stat.blocks,
            turnovers: stat.turnovers,
            fantasyPoints: parseFloat(stat.fantasyPoints),
            homeAway: stat.homeAway,
          };
        })
      );

      // Group by home/away
      const homeStats = statsWithPlayers.filter(s => s.homeAway === "home");
      const awayStats = statsWithPlayers.filter(s => s.homeAway === "away");
      
      const calculateTeamTotals = (teamStats: typeof statsWithPlayers) => ({
        points: teamStats.reduce((sum, s) => sum + s.points, 0),
        rebounds: teamStats.reduce((sum, s) => sum + s.rebounds, 0),
        assists: teamStats.reduce((sum, s) => sum + s.assists, 0),
        steals: teamStats.reduce((sum, s) => sum + s.steals, 0),
        blocks: teamStats.reduce((sum, s) => sum + s.blocks, 0),
        turnovers: teamStats.reduce((sum, s) => sum + s.turnovers, 0),
      });

      // Find top performers across both teams
      const allStats = [...homeStats, ...awayStats];
      const topScorer = allStats.reduce((max, s) => s.points > max.points ? s : max, allStats[0]);
      const topRebounder = allStats.reduce((max, s) => s.rebounds > max.rebounds ? s : max, allStats[0]);
      const topAssister = allStats.reduce((max, s) => s.assists > max.assists ? s : max, allStats[0]);

      res.json({
        gameId,
        homeTeam: {
          players: homeStats,
          totals: homeStats.length > 0 ? calculateTeamTotals(homeStats) : null,
        },
        awayTeam: {
          players: awayStats,
          totals: awayStats.length > 0 ? calculateTeamTotals(awayStats) : null,
        },
        topPerformers: allStats.length > 0 ? {
          topScorer,
          topRebounder,
          topAssister,
        } : null,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Add cash to user balance ($1)
  app.post("/api/user/add-cash", async (req, res) => {
    try {
      const userId = "some-user-id";
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      const updatedUser = await storage.addUserBalance(user.id, 1.00);
      
      if (updatedUser) {
        broadcast({ type: "portfolio", userId: user.id, balance: updatedUser.balance });
        res.json({ balance: updatedUser.balance });
      } else {
        res.status(500).json({ error: "Failed to update balance" });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Update username
  app.post("/api/user/update-username", async (req, res) => {
    try {
      const userId = "some-user-id";
      const { username } = req.body;

      // Validate username
      if (!username || typeof username !== 'string') {
        return res.status(400).json({ error: "Username is required" });
      }

      // Check length (3-20 characters)
      if (username.length < 3 || username.length > 20) {
        return res.status(400).json({ error: "Username must be between 3 and 20 characters" });
      }

      // Check format (alphanumeric, underscores, hyphens only)
      if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
        return res.status(400).json({ error: "Username can only contain letters, numbers, underscores, and hyphens" });
      }

      // Check if username is already taken by another user
      const existingUser = await storage.getUserByUsername(username);
      if (existingUser && existingUser.id !== userId) {
        return res.status(409).json({ error: "Username is already taken" });
      }

      const updatedUser = await storage.updateUsername(userId, username);
      if (updatedUser) {
        res.json({ username: updatedUser.username });
      } else {
        res.status(500).json({ error: "Failed to update username" });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Admin endpoint to manually trigger sync jobs
  app.post("/api/admin/sync/:jobName", async (req, res) => {
    try {
      const { jobName } = req.params;
      const result = await jobScheduler.triggerJob(jobName);
      res.json({
        success: true,
        jobName,
        ...result,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Players / Marketplace
  app.get("/api/teams", async (req, res) => {
    try {
      const teams = await storage.getDistinctTeams();
      res.json(teams);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/players", async (req, res) => {
    try {
      const { search, team, position } = req.query;
      const playersRaw = await storage.getPlayers({
        search: search as string,
        team: team as string,
        position: position as string,
      });
      // Enrich with market values (last trade prices)
      const players = await Promise.all(playersRaw.map(enrichPlayerWithMarketValue));
      res.json(players);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Player detail page
  app.get("/api/player/:id", async (req, res) => {
    try {
      const userId = "some-user-id";
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      const playerRaw = await storage.getPlayer(req.params.id);
      
      if (!playerRaw) {
        return res.status(404).json({ error: "Player not found" });
      }

      // Enrich with market value
      const player = await enrichPlayerWithMarketValue(playerRaw);
      
      const orderBook = await storage.getOrderBook(player.id);
      const recentTrades = await storage.getRecentTrades(player.id, 20);
      const userHolding = await storage.getHolding(user.id, "player", player.id);

      // Mock price history - use last trade price if available, otherwise use currentPrice as placeholder
      const basePrice = player.lastTradePrice || player.currentPrice || "10.00";
      const basePriceNum = parseFloat(basePrice);
      
      // Guard against NaN
      const priceHistory = Array.from({ length: 24 }, (_, i) => ({
        timestamp: new Date(Date.now() - (23 - i) * 3600000).toISOString(),
        price: (!isNaN(basePriceNum) ? (basePriceNum + (Math.random() - 0.5) * 2) : 10).toFixed(2),
      }));

      res.json({
        player,
        priceHistory,
        orderBook: {
          bids: orderBook.bids.slice(0, 10).map(o => ({
            price: o.limitPrice,
            quantity: o.quantity - o.filledQuantity,
          })),
          asks: orderBook.asks.slice(0, 10).map(o => ({
            price: o.limitPrice,
            quantity: o.quantity - o.filledQuantity,
          })),
        },
        recentTrades: await Promise.all(
          recentTrades.map(async (trade) => ({
            ...trade,
            buyer: await storage.getUser(trade.buyerId),
            seller: await storage.getUser(trade.sellerId),
          }))
        ),
        userBalance: user.balance,
        userHolding,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Player season stats (PPG, RPG, APG, etc.)
  app.get("/api/player/:id/stats", async (req, res) => {
    try {
      const player = await storage.getPlayer(req.params.id);
      
      if (!player) {
        return res.status(404).json({ error: "Player not found" });
      }

      // Fetch season stats from MySportsFeeds
      const seasonStats = await fetchPlayerSeasonStats(player.id);
      
      if (!seasonStats || !seasonStats.stats) {
        return res.json({ 
          player: { firstName: player.firstName, lastName: player.lastName },
          team: { abbreviation: player.team },
          stats: null 
        });
      }

      // Extract and format stats with defensive null checks
      // MySportsFeeds structure: offense, defense, rebounds, fieldGoals, freeThrows, etc.
      const stats = seasonStats.stats || {};
      
      res.json({
        player: seasonStats.player || { firstName: player.firstName, lastName: player.lastName },
        team: seasonStats.team || { abbreviation: player.team },
        stats: {
          gamesPlayed: stats.gamesPlayed || 0,
          // Scoring - MySportsFeeds provides per-game averages
          points: stats.offense?.pts || 0,
          pointsPerGame: stats.offense?.ptsPerGame?.toFixed(1) || "0.0",
          fieldGoalPct: stats.fieldGoals?.fgPct?.toFixed(1) || "0.0",
          threePointPct: stats.fieldGoals?.fg3PtPct?.toFixed(1) || "0.0",
          freeThrowPct: stats.freeThrows?.ftPct?.toFixed(1) || "0.0",
          // Rebounding
          rebounds: stats.rebounds?.reb || 0,
          reboundsPerGame: stats.rebounds?.rebPerGame?.toFixed(1) || "0.0",
          offensiveRebounds: stats.rebounds?.offReb || 0,
          defensiveRebounds: stats.rebounds?.defReb || 0,
          // Playmaking
          assists: stats.offense?.ast || 0,
          assistsPerGame: stats.offense?.astPerGame?.toFixed(1) || "0.0",
          turnovers: stats.offense?.tov || 0,
          // Defense
          steals: stats.defense?.stl || 0,
          blocks: stats.defense?.blk || 0,
          // Minutes
          minutes: stats.miscellaneous?.minSeconds ? Math.floor(stats.miscellaneous.minSeconds / 60) : 0,
          minutesPerGame: stats.miscellaneous?.minSecondsPerGame ? (stats.miscellaneous.minSecondsPerGame / 60).toFixed(1) : "0.0",
        },
      });
    } catch (error: any) {
      console.error("[API] Error fetching player stats:", error.message);
      // Return graceful fallback instead of 500 error
      res.json({ 
        stats: null,
        error: "Stats temporarily unavailable"
      });
    }
  });

  // Player recent games (last 5 games)
  app.get("/api/player/:id/recent-games", async (req, res) => {
    try {
      const player = await storage.getPlayer(req.params.id);
      
      if (!player) {
        return res.status(404).json({ error: "Player not found" });
      }

      // Fetch last 5 games from MySportsFeeds
      const gameLogs = await fetchPlayerGameLogs(player.id, 5);
      
      if (!gameLogs || gameLogs.length === 0) {
        return res.json({ recentGames: [] });
      }

      // Format game logs with defensive null checks
      // MySportsFeeds gamelogs structure: stats.{offense, rebounds, fieldGoals, defense, miscellaneous}
      const recentGames = gameLogs
        .filter((log: any) => log && log.game && log.stats) // Filter out invalid entries
        .map((log: any) => {
          const stats = log.stats || {};
          const offense = stats.offense || {};
          const rebounds = stats.rebounds || {};
          const fieldGoals = stats.fieldGoals || {};
          const defense = stats.defense || {};
          return {
            game: {
              id: log.game?.id || 0,
              date: log.game?.startTime || new Date().toISOString(),
              opponent: log.game?.homeTeamAbbreviation === log.team?.abbreviation 
                ? log.game?.awayTeamAbbreviation || "UNK"
                : log.game?.homeTeamAbbreviation || "UNK",
              isHome: log.game?.homeTeamAbbreviation === log.team?.abbreviation,
            },
            stats: {
              points: offense.pts || 0,
              rebounds: rebounds.reb || 0,
              assists: offense.ast || 0,
              steals: defense.stl || 0,
              blocks: defense.blk || 0,
              turnovers: offense.tov || 0,
              fieldGoalsMade: fieldGoals.fgMade || 0,
              fieldGoalsAttempted: fieldGoals.fgAtt || 0,
              threePointersMade: fieldGoals.fg3PtMade || 0,
              minutes: stats.miscellaneous?.minSeconds ? Math.floor(stats.miscellaneous.minSeconds / 60) : 0,
            },
          };
        });

      res.json({ recentGames });
    } catch (error: any) {
      console.error("[API] Error fetching player game logs:", error.message);
      // Return graceful fallback instead of 500 error
      res.json({ 
        recentGames: [],
        error: "Game logs temporarily unavailable"
      });
    }
  });

  // Place order
  app.post("/api/orders/:playerId", async (req, res) => {
    try {
      const userId = "some-user-id";
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      const player = await storage.getPlayer(req.params.playerId);
      
      if (!player) {
        return res.status(404).json({ error: "Player not found" });
      }

      const { orderType, side, quantity, limitPrice } = req.body;

      // Validation
      if (!quantity || quantity <= 0) {
        return res.status(400).json({ error: "Invalid quantity" });
      }

      if (orderType === "limit" && (!limitPrice || parseFloat(limitPrice) <= 0)) {
        return res.status(400).json({ error: "Invalid limit price" });
      }

      // Check balance for buy orders
      if (side === "buy") {
        const price = orderType === "limit" ? parseFloat(limitPrice) : parseFloat(player.currentPrice);
        const cost = quantity * price;
        
        if (parseFloat(user.balance) < cost) {
          return res.status(400).json({ error: "Insufficient balance" });
        }
      }

      // Check holdings for sell orders
      if (side === "sell") {
        const holding = await storage.getHolding(user.id, "player", req.params.playerId);
        if (!holding || holding.quantity < quantity) {
          return res.status(400).json({ error: "Insufficient shares" });
        }
      }

      // For market orders, validate liquidity BEFORE creating the order
      if (orderType === "market") {
        const orderBook = await storage.getOrderBook(req.params.playerId);
        const availableOrders = side === "buy" ? orderBook.asks : orderBook.bids;
        
        // Check if there are any valid counter-side orders with valid prices
        const validOrders = availableOrders.filter(o => 
          o.limitPrice && 
          parseFloat(o.limitPrice) > 0 && 
          (o.quantity - o.filledQuantity) > 0
        );
        
        if (validOrders.length === 0) {
          return res.status(400).json({ error: "No liquidity available for market order at valid prices" });
        }
      }

      // Create order
      const order = await storage.createOrder({
        userId: user.id,
        playerId: req.params.playerId,
        orderType,
        side,
        quantity,
        limitPrice: orderType === "limit" ? limitPrice : null,
      });

      // For market orders, match immediately
      if (orderType === "market") {
        const orderBook = await storage.getOrderBook(req.params.playerId);
        const availableOrders = side === "buy" ? orderBook.asks : orderBook.bids;
        
        let remainingQty = quantity;
        let totalCost = 0;
        let lastFillPrice = 0; // Track last fill price for broadcast

        for (const availableOrder of availableOrders) {
          if (remainingQty <= 0) break;
          
          // Ensure the counterparty order has a valid limit price
          if (!availableOrder.limitPrice || parseFloat(availableOrder.limitPrice) <= 0) {
            continue; // Skip invalid orders
          }
          
          const availableQty = availableOrder.quantity - availableOrder.filledQuantity;
          const fillQty = Math.min(remainingQty, availableQty);
          const fillPrice = parseFloat(availableOrder.limitPrice);
          lastFillPrice = fillPrice; // Track for broadcast

          // Execute trade
          await storage.createTrade({
            playerId: req.params.playerId,
            buyerId: side === "buy" ? user.id : availableOrder.userId,
            sellerId: side === "sell" ? user.id : availableOrder.userId,
            buyOrderId: side === "buy" ? order.id : availableOrder.id,
            sellOrderId: side === "sell" ? order.id : availableOrder.id,
            quantity: fillQty,
            price: fillPrice.toFixed(2),
          });

          remainingQty -= fillQty;
          totalCost += fillQty * fillPrice;

          // Update matched order
          const newFilled = availableOrder.filledQuantity + fillQty;
          await storage.updateOrder(availableOrder.id, {
            filledQuantity: newFilled,
            status: newFilled >= availableOrder.quantity ? "filled" : "partial",
          });

          // Update holdings
          if (side === "buy") {
            const buyerHolding = await storage.getHolding(user.id, "player", req.params.playerId);
            if (buyerHolding) {
              const newQuantity = buyerHolding.quantity + fillQty;
              const newTotalCost = parseFloat(buyerHolding.totalCostBasis) + (fillQty * fillPrice);
              const newAvgCost = newTotalCost / newQuantity;
              await storage.updateHolding(user.id, "player", req.params.playerId, newQuantity, newAvgCost.toFixed(4));
            } else {
              await storage.updateHolding(user.id, "player", req.params.playerId, fillQty, fillPrice.toFixed(4));
            }

            const sellerHolding = await storage.getHolding(availableOrder.userId, "player", req.params.playerId);
            if (sellerHolding) {
              await storage.updateHolding(
                availableOrder.userId,
                "player",
                req.params.playerId,
                sellerHolding.quantity - fillQty,
                sellerHolding.avgCostBasis
              );
            }
          } else {
            // Sell order
            const buyerHolding = await storage.getHolding(availableOrder.userId, "player", req.params.playerId);
            if (buyerHolding) {
              const newQuantity = buyerHolding.quantity + fillQty;
              const newTotalCost = parseFloat(buyerHolding.totalCostBasis) + (fillQty * fillPrice);
              const newAvgCost = newTotalCost / newQuantity;
              await storage.updateHolding(
                availableOrder.userId,
                "player",
                req.params.playerId,
                newQuantity,
                newAvgCost.toFixed(4)
              );
            } else {
              await storage.updateHolding(availableOrder.userId, "player", req.params.playerId, fillQty, fillPrice.toFixed(4));
            }

            const sellerHolding = await storage.getHolding(user.id, "player", req.params.playerId);
            if (sellerHolding) {
              await storage.updateHolding(user.id, "player", req.params.playerId, sellerHolding.quantity - fillQty, sellerHolding.avgCostBasis);
            }
          }

          // Update balances
          const seller = await storage.getUser(side === "sell" ? user.id : availableOrder.userId);
          const buyer = await storage.getUser(side === "buy" ? user.id : availableOrder.userId);
          
          if (buyer && seller) {
            const tradeCost = fillQty * fillPrice;
            await storage.updateUserBalance(buyer.id, (parseFloat(buyer.balance) - tradeCost).toFixed(2));
            await storage.updateUserBalance(seller.id, (parseFloat(seller.balance) + tradeCost).toFixed(2));
            
            // Broadcast portfolio updates for BOTH parties in each fill
            const updatedBuyer = await storage.getUser(buyer.id);
            const updatedSeller = await storage.getUser(seller.id);
            if (updatedBuyer) {
              broadcast({ type: "portfolio", userId: buyer.id, balance: updatedBuyer.balance });
            }
            if (updatedSeller) {
              broadcast({ type: "portfolio", userId: seller.id, balance: updatedSeller.balance });
            }
          }
        }

        // Update market order status
        const filledQty = quantity - remainingQty;
        
        // Safety check: If no fills occurred despite passing pre-check, cancel the order
        if (filledQty === 0) {
          await storage.updateOrder(order.id, { status: "cancelled" });
          broadcast({ type: "orderBook", playerId: req.params.playerId });
          return res.status(400).json({ error: "Market order could not be filled - order cancelled" });
        }
        
        await storage.updateOrder(order.id, {
          filledQuantity: filledQty,
          status: remainingQty === 0 ? "filled" : "partial",
        });

        // Broadcast real-time updates for order book and trades
        // Calculate VWAP (volume-weighted average price) for the market order
        const vwap = filledQty > 0 ? (totalCost / filledQty).toFixed(2) : lastFillPrice.toFixed(2);
        
        broadcast({ type: "orderBook", playerId: req.params.playerId });
        broadcast({ type: "trade", playerId: req.params.playerId, quantity: filledQty, price: vwap });
        // Note: portfolio broadcasts already sent for each party in the fill loop above
      } else {
        // Limit order - try to match
        await matchOrders(req.params.playerId);
        broadcast({ type: "orderBook", playerId: req.params.playerId });
      }

      res.json({ success: true, order });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Cancel order
  app.post("/api/orders/:orderId/cancel", async (req, res) => {
    try {
      await storage.cancelOrder(req.params.orderId);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Portfolio
  app.get("/api/portfolio", async (req, res) => {
    try {
      const userId = "some-user-id";
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      const userHoldings = await storage.getUserHoldings(user.id);
      const openOrders = await storage.getUserOrders(user.id, "open");

      let totalValue = 0;
      let totalPnL = 0;
      let totalCost = 0;

      const enrichedHoldings = await Promise.all(
        userHoldings.map(async (holding) => {
          if (holding.assetType === "player") {
            const player = await storage.getPlayer(holding.assetId);
            if (player) {
              const enrichedPlayer = await enrichPlayerWithMarketValue(player);
              const { currentValue, pnl, pnlPercent } = calculatePnL(
                holding.quantity,
                holding.avgCostBasis,
                enrichedPlayer.lastTradePrice
              );
              // Only add to totals if we have a valid market price
              if (currentValue !== null) {
                totalValue += parseFloat(currentValue);
                totalPnL += parseFloat(pnl!);
                totalCost += parseFloat(holding.totalCostBasis);
              }

              return { ...holding, player: enrichedPlayer, currentValue, pnl, pnlPercent };
            }
          }
          return holding;
        })
      );

      const enrichedOrders = await Promise.all(
        openOrders.map(async (order) => ({
          ...order,
          player: await storage.getPlayer(order.playerId),
        }))
      );

      const premiumShares = userHoldings.find(h => h.assetType === "premium")?.quantity || 0;

      res.json({
        balance: user.balance,
        portfolioValue: totalValue.toFixed(2),
        totalPnL: totalPnL.toFixed(2),
        totalPnLPercent: totalCost > 0 ? ((totalPnL / totalCost) * 100).toFixed(2) : "0.00",
        holdings: enrichedHoldings,
        openOrders: enrichedOrders,
        premiumShares,
        isPremium: user.isPremium,
        premiumExpiresAt: user.premiumExpiresAt,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Start/select mining for player(s)
  app.post("/api/mining/start", async (req, res) => {
    try {
      const userId = "some-user-id";
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      const { playerIds } = req.body; // Array of player IDs (1-10)

      if (!playerIds || !Array.isArray(playerIds) || playerIds.length === 0) {
        return res.status(400).json({ error: "playerIds array required (1-10 players)" });
      }

      if (playerIds.length > 10) {
        return res.status(400).json({ error: "Maximum 10 players allowed" });
      }

      // Validate all players exist and are eligible
      const players = [];
      for (const playerId of playerIds) {
        const player = await storage.getPlayer(playerId);
        if (!player) {
          return res.status(404).json({ error: `Player ${playerId} not found` });
        }
        if (!player.isEligibleForMining) {
          return res.status(400).json({ error: `${player.firstName} ${player.lastName} is not eligible for mining` });
        }
        players.push(player);
      }

      // Check if user has unclaimed shares
      const currentMining = await storage.getMining(user.id);
      if (currentMining && currentMining.sharesAccumulated > 0) {
        return res.status(400).json({ 
          error: "Must claim accumulated shares before changing player selection",
          sharesAccumulated: currentMining.sharesAccumulated,
        });
      }

      // Calculate shares per hour for each player (equal distribution)
      const totalRate = 100;
      const baseSharesPerHour = Math.floor(totalRate / playerIds.length);
      const remainder = totalRate % playerIds.length;

      // Create new splits
      const newSplits = playerIds.map((playerId, index) => ({
        userId: user.id,
        playerId,
        // Distribute remainder to first N players
        sharesPerHour: baseSharesPerHour + (index < remainder ? 1 : 0),
      }));

      // Update mining state: clear playerId (using splits now), reset timestamps
      const now = new Date();
      await storage.setMiningSplits(user.id, newSplits);
      await storage.updateMining(user.id, {
        playerId: null, // Clear single player ID since using splits
        sharesAccumulated: 0,
        residualMs: 0,
        lastAccruedAt: now,
        lastClaimedAt: null,
        capReachedAt: null,
        updatedAt: now,
      });

      broadcast({ type: "mining", userId: user.id, playerIds });

      res.json({ success: true, players, splits: newSplits });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Mining claim
  app.post("/api/mining/claim", async (req, res) => {
    try {
      const userId = "some-user-id";
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
      // Accrue any final shares before claiming
      await accrueMiningShares(user.id);
      
      const miningData = await storage.getMining(user.id);

      if (!miningData || miningData.sharesAccumulated === 0) {
        return res.status(400).json({ error: "No shares to claim" });
      }

      // Check if using multi-player mining (splits)
      const splits = await storage.getMiningSplits(user.id);
      const usingSplits = splits.length > 0;

      if (!usingSplits) {
        // Legacy single-player mining
        if (!miningData.playerId) {
          return res.status(400).json({ error: "No player selected for mining" });
        }

        const player = await storage.getPlayer(miningData.playerId);
        if (!player) {
          return res.status(400).json({ error: "Player not found" });
        }

        // Add shares to holdings (cost basis $0)
        const holding = await storage.getHolding(user.id, "player", miningData.playerId);
        if (holding) {
          const newQuantity = holding.quantity + miningData.sharesAccumulated;
          const newTotalCost = parseFloat(holding.totalCostBasis); // Mined shares have $0 cost
          const newAvgCost = newTotalCost / newQuantity;
          await storage.updateHolding(user.id, "player", miningData.playerId, newQuantity, newAvgCost.toFixed(4));
        } else {
          await storage.updateHolding(user.id, "player", miningData.playerId, miningData.sharesAccumulated, "0.0000");
        }

        // Increment total shares mined counter
        await storage.incrementTotalSharesMined(user.id, miningData.sharesAccumulated);

        // Reset mining
        const now = new Date();
        await storage.updateMining(user.id, {
          sharesAccumulated: 0,
          lastClaimedAt: now,
          lastAccruedAt: now,
          updatedAt: now,
          residualMs: 0,
          capReachedAt: null,
        });

        broadcast({ type: "portfolio", userId: user.id });
        broadcast({ type: "mining", userId: user.id, claimed: miningData.sharesAccumulated });

        return res.json({ 
          success: true, 
          sharesClaimed: miningData.sharesAccumulated,
          player,
        });
      }

      // Multi-player mining: distribute shares proportionally
      const totalAccumulated = miningData.sharesAccumulated;
      const totalRate = 100;
      const claimedPlayers = [];
      let totalDistributed = 0;

      // Calculate shares for each player proportionally
      const distributions = splits.map(split => {
        const proportion = split.sharesPerHour / totalRate;
        const shares = Math.floor(proportion * totalAccumulated);
        return { ...split, shares };
      });

      // Distribute remainder deterministically (to players with highest sharesPerHour)
      const remainder = totalAccumulated - distributions.reduce((sum, d) => sum + d.shares, 0);
      const sortedByRate = [...distributions].sort((a, b) => b.sharesPerHour - a.sharesPerHour);
      for (let i = 0; i < remainder; i++) {
        sortedByRate[i].shares += 1;
      }

      // Add shares to holdings for each player
      for (const dist of distributions) {
        if (dist.shares === 0) continue;

        const player = await storage.getPlayer(dist.playerId);
        if (!player) continue;

        const holding = await storage.getHolding(user.id, "player", dist.playerId);
        if (holding) {
          const newQuantity = holding.quantity + dist.shares;
          const newTotalCost = parseFloat(holding.totalCostBasis); // Mined shares have $0 cost
          const newAvgCost = newTotalCost / newQuantity;
          await storage.updateHolding(user.id, "player", dist.playerId, newQuantity, newAvgCost.toFixed(4));
        } else {
          await storage.updateHolding(user.id, "player", dist.playerId, dist.shares, "0.0000");
        }

        claimedPlayers.push({
          playerId: dist.playerId,
          playerName: `${player.firstName} ${player.lastName}`,
          sharesClaimed: dist.shares,
        });
        totalDistributed += dist.shares;
      }

      // Increment total shares mined counter
      await storage.incrementTotalSharesMined(user.id, totalDistributed);

      // Reset mining (keep splits intact)
      const now = new Date();
      await storage.updateMining(user.id, {
        sharesAccumulated: 0,
        lastClaimedAt: now,
        lastAccruedAt: now,
        updatedAt: now,
        residualMs: 0,
        capReachedAt: null,
      });

      broadcast({ type: "portfolio", userId: user.id });
      broadcast({ type: "mining", userId: user.id, claimed: totalDistributed });

      res.json({ 
        success: true, 
        totalSharesClaimed: totalDistributed,
        players: claimedPlayers,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Contests (public - anyone can view)
  app.get("/api/contests", async (req, res) => {
    try {
      const allOpenContests = await storage.getContests("open");
      
      const { date } = req.query;
      
      // Filter contests based on date
      const now = new Date();
      let openContests = allOpenContests;
      
      if (date && typeof date === 'string') {
        // Filter by gameDate (the actual day of the games, not when contest starts)
        // Parse the selected date: YYYY-MM-DD
        const [year, month, day] = date.split('-').map(Number);
        
        // Filter contests where gameDate matches the selected date
        openContests = allOpenContests.filter(contest => {
          const gameDate = new Date(contest.gameDate);
          const gameDateStr = gameDate.toISOString().split('T')[0];
          return gameDateStr === date;
        });
      } else {
        // Default behavior: show all upcoming contests (haven't started yet)
        openContests = allOpenContests.filter(contest => 
          new Date(contest.startsAt) > now
        );
      }
      
      // If user is authenticated, include their entries
      let enrichedEntries: any[] = [];
      // if (req.user) {
      //   try {
      //     const userId = "some-user-id";
      //     const user = await storage.getUser(userId);
      //     if (user) {
      //       const myEntries = await storage.getUserContestEntries(user.id);
      //       enrichedEntries = await Promise.all(
      //         myEntries.map(async (entry) => ({
      //           ...entry,
      //           contest: await storage.getContest(entry.contestId),
      //         }))
      //       );
      //     }
      //   } catch (error) {
      //     // Ignore auth errors, just don't include entries
      //     console.log("[contests] Could not fetch user entries:", error);
      //   }
      // }

      res.json({
        openContests,
        myEntries: enrichedEntries,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Admin endpoint to manually trigger contest creation (for testing)
  app.post("/api/admin/create-contests", async (req, res) => {
    try {
      console.log("[admin] Manually triggering contest creation...");
      const result = await createContests();
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Contest entry form
  app.get("/api/contest/:id/entry", async (req, res) => {
    try {
      const userId = "some-user-id";
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      const contest = await storage.getContest(req.params.id);

      if (!contest) {
        return res.status(404).json({ error: "Contest not found" });
      }

      const userHoldings = await storage.getUserHoldings(user.id);
      const eligiblePlayers = await Promise.all(
        userHoldings
          .filter(h => h.assetType === "player")
          .map(async (holding) => ({
            ...holding,
            player: await storage.getPlayer(holding.assetId),
            isEligible: true, // Simplified - would check game schedule
          }))
      );

      res.json({
        contest: {
          id: contest.id,
          name: contest.name,
          sport: contest.sport,
          startsAt: contest.startsAt,
        },
        eligiblePlayers,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Submit contest entry
  app.post("/api/contest/:id/enter", async (req, res) => {
    try {
      const userId = "some-user-id";
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      const contest = await storage.getContest(req.params.id);

      if (!contest) {
        return res.status(404).json({ error: "Contest not found" });
      }

      // Check if contest is locked (started)
      if (new Date() >= new Date(contest.startsAt)) {
        return res.status(400).json({ error: "Contest has already started and is locked" });
      }

      const { lineup } = req.body;

      if (!lineup || lineup.length === 0) {
        return res.status(400).json({ error: "Lineup cannot be empty" });
      }

      // VALIDATE: Check user owns enough shares BEFORE creating entry
      for (const item of lineup) {
        const holding = await storage.getHolding(user.id, "player", item.playerId);
        if (!holding || holding.quantity < item.sharesEntered) {
          return res.status(400).json({ 
            error: `Insufficient shares for player ${item.playerId}. Required: ${item.sharesEntered}, Available: ${holding?.quantity || 0}` 
          });
        }
      }

      // Calculate total shares
      const totalShares = lineup.reduce((sum: number, item: any) => sum + item.sharesEntered, 0);

      // Create entry
      const entry = await storage.createContestEntry({
        contestId: req.params.id,
        userId: user.id,
        totalSharesEntered: totalShares,
      });

      // Create lineup items and burn shares from holdings
      for (const item of lineup) {
        await storage.createContestLineup({
          entryId: entry.id,
          playerId: item.playerId,
          sharesEntered: item.sharesEntered,
        });

        const holding = await storage.getHolding(user.id, "player", item.playerId);
        // Safe to burn now - already validated above
        if (holding) {
          await storage.updateHolding(
            user.id,
            "player",
            item.playerId,
            holding.quantity - item.sharesEntered,
            holding.avgCostBasis
          );
        }
      }

      // Update contest metrics atomically
      await storage.updateContestMetrics(req.params.id, totalShares, contest.entryFee);

      // Broadcast contest update
      broadcast({ type: "contestUpdate", contestId: req.params.id });

      res.json({ success: true, entry });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get existing contest entry for editing
  app.get("/api/contest/:contestId/entry/:entryId", async (req, res) => {
    try {
      const userId = "some-user-id";
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      const { contestId, entryId } = req.params;

      const contest = await storage.getContest(contestId);
      if (!contest) {
        return res.status(404).json({ error: "Contest not found" });
      }

      // Check if contest is locked
      if (new Date() >= new Date(contest.startsAt)) {
        return res.status(400).json({ error: "Contest has started and is locked for editing" });
      }

      const result = await storage.getContestEntryWithLineup(entryId, user.id);
      if (!result) {
        return res.status(404).json({ error: "Entry not found or unauthorized" });
      }

      // Get player details for lineup
      const enrichedLineup = await Promise.all(
        result.lineup.map(async (item: any) => ({
          ...item,
          player: await storage.getPlayer(item.playerId),
        }))
      );

      // Get ALL eligible players: current holdings (including new acquisitions) + lineup players
      const userHoldings = await storage.getUserHoldings(user.id);
      const holdingsMap = new Map(
        userHoldings
          .filter(h => h.assetType === "player")
          .map(h => [h.assetId, h])
      );

      // Build eligible players from all holdings and lineup players
      const allPlayerIds = new Set([
        ...userHoldings.filter(h => h.assetType === "player").map(h => h.assetId),
        ...result.lineup.map((l: any) => l.playerId)
      ]);

      const eligiblePlayers = await Promise.all(
        Array.from(allPlayerIds).map(async (playerId) => {
          const holding = holdingsMap.get(playerId);
          const lineupItem = result.lineup.find((l: any) => l.playerId === playerId);
          const player = await storage.getPlayer(playerId);
          
          // Total available = current holding + shares in lineup
          const currentQuantity = holding?.quantity || 0;
          const lineupShares = lineupItem?.sharesEntered || 0;
          const totalAvailable = currentQuantity + lineupShares;

          return {
            assetId: playerId,
            assetType: "player" as const,
            quantity: totalAvailable,
            userId: user.id,
            avgCostBasis: holding?.avgCostBasis || "0.0000",
            player,
            isEligible: true,
          };
        })
      );

      res.json({
        contest: {
          id: contest.id,
          name: contest.name,
          sport: contest.sport,
          startsAt: contest.startsAt,
        },
        entry: result.entry,
        lineup: enrichedLineup,
        eligiblePlayers,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Update contest entry (edit lineup before lock)
  app.put("/api/contest/:contestId/entry/:entryId", async (req, res) => {
    try {
      const userId = "some-user-id";
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      const { contestId, entryId } = req.params;
      const { lineup } = req.body;

      const contest = await storage.getContest(contestId);
      if (!contest) {
        return res.status(404).json({ error: "Contest not found" });
      }

      // Check if contest is locked
      if (new Date() >= new Date(contest.startsAt)) {
        return res.status(400).json({ error: "Contest has started and is locked for editing" });
      }

      if (!lineup || lineup.length === 0) {
        return res.status(400).json({ error: "Lineup cannot be empty" });
      }

      // Get existing entry
      const existing = await storage.getContestEntryWithLineup(entryId, user.id);
      if (!existing) {
        return res.status(404).json({ error: "Entry not found or unauthorized" });
      }

      // Get current user holdings for validation
      const userHoldings = await storage.getUserHoldings(user.id);
      const holdingsMap = new Map(
        userHoldings
          .filter(h => h.assetType === "player")
          .map(h => [h.assetId, h.quantity])
      );

      // Calculate share differences and validate
      const oldLineupMap = new Map<string, number>(existing.lineup.map((item: any) => [item.playerId, item.sharesEntered]));
      const newLineupMap = new Map<string, number>(lineup.map((item: any) => [item.playerId, item.sharesEntered]));

      // Validate that user has sufficient shares for the new lineup
      for (const [playerId, newShares] of Array.from(newLineupMap.entries())) {
        const oldShares = oldLineupMap.get(playerId) || 0;
        const currentHolding = holdingsMap.get(playerId) || 0;
        const availableShares = Number(currentHolding) + Number(oldShares); // Current holdings + shares currently in lineup
        
        if (newShares > availableShares) {
          return res.status(400).json({ 
            error: `Insufficient shares for player ${playerId}. Available: ${availableShares}, Requested: ${newShares}` 
          });
        }
      }

      // Return shares that were removed or reduced
      for (const [playerId, oldShares] of Array.from(oldLineupMap.entries())) {
        const newShares = newLineupMap.get(playerId) || 0;
        if (newShares < oldShares) {
          const sharesToReturn = Number(oldShares) - Number(newShares);
          const holding = await storage.getHolding(user.id, "player", playerId);
          if (holding) {
            await storage.updateHolding(
              user.id,
              "player",
              playerId,
              holding.quantity + sharesToReturn,
              holding.avgCostBasis
            );
          } else {
            // Create new holding if user didn't have any
            await storage.updateHolding(user.id, "player", playerId, sharesToReturn, "0.0000");
          }
        }
      }

      // VALIDATE AND BURN: Check holdings AFTER returns, then burn additional shares
      for (const [playerId, newShares] of Array.from(newLineupMap.entries())) {
        const oldShares = oldLineupMap.get(playerId) || 0;
        if (newShares > oldShares) {
          const sharesToBurn = Number(newShares) - Number(oldShares);
          // Re-fetch holding after share returns to get current state
          const holding = await storage.getHolding(user.id, "player", playerId);
          
          // CRITICAL: Validate user has enough shares AFTER returns
          if (!holding || holding.quantity < sharesToBurn) {
            return res.status(400).json({ 
              error: `Insufficient shares for player ${playerId}. Required: ${sharesToBurn}, Available: ${holding?.quantity || 0}` 
            });
          }
          
          // Safe to burn now - validated above
          await storage.updateHolding(
            user.id,
            "player",
            playerId,
            holding.quantity - sharesToBurn,
            holding.avgCostBasis
          );
        }
      }

      // Calculate new total shares
      const totalShares = lineup.reduce((sum: number, item: any) => sum + item.sharesEntered, 0);
      const oldTotalShares = existing.entry.totalSharesEntered;

      // Delete old lineup and create new one
      await storage.deleteContestLineup(entryId);
      for (const item of lineup) {
        await storage.createContestLineup({
          entryId,
          playerId: item.playerId,
          sharesEntered: item.sharesEntered,
        });
      }

      // Update entry total shares
      await storage.updateContestEntry(entryId, { totalSharesEntered: totalShares });

      // Update contest metrics with the share difference (not entry count)
      const shareDifference = totalShares - oldTotalShares;
      if (shareDifference !== 0) {
        // Fetch current contest to calculate new total shares
        const currentContest = await storage.getContest(contestId);
        if (currentContest) {
          const newTotalShares = currentContest.totalSharesEntered + shareDifference;
          await storage.updateContest(contestId, {
            totalSharesEntered: newTotalShares,
          });
        }
      }

      // Broadcast contest update
      broadcast({ type: "contestUpdate", contestId });

      // Fetch updated entry to return fresh data
      const updatedEntry = await storage.getContestEntryWithLineup(entryId, user.id);
      
      res.json({ 
        success: true,
        entry: updatedEntry?.entry,
        totalShares
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get detailed contest entry information (public - anyone can view)
  app.get("/api/contest/:contestId/entries/:entryId", async (req, res) => {
    try {
      const { contestId, entryId } = req.params;
      const entryDetails = await storage.getContestEntryDetail(contestId, entryId);

      if (!entryDetails) {
        return res.status(404).json({ error: "Entry not found" });
      }

      res.json(entryDetails);
    } catch (error: any) {
      console.error("[entry-detail] Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Contest leaderboard with proportional scoring (public - anyone can view)
  app.get("/api/contest/:id/leaderboard", async (req, res) => {
    try {
      const contest = await storage.getContest(req.params.id);

      if (!contest) {
        return res.status(404).json({ error: "Contest not found" });
      }

      // Calculate real-time leaderboard with proportional scoring
      const { calculateContestLeaderboard } = await import("./contest-scoring");
      const leaderboard = await calculateContestLeaderboard(req.params.id);

      // If user is authenticated, find their entry
      let myEntry = undefined;
      // if (req.user) {
      //   try {
      //     const userId = "some-user-id";
      //     const user = await storage.getUser(userId);
      //     if (user) {
      //       myEntry = leaderboard.find(e => e.userId === user.id);
      //     }
      //   } catch (error) {
      //     // Ignore auth errors
      //     console.log("[leaderboard] Could not fetch user entry:", error);
      //   }
      // }

      res.json({
        contest,
        leaderboard,
        myEntry,
      });
    } catch (error: any) {
      console.error("[leaderboard] Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Global leaderboards (public)
  app.get("/api/leaderboards", async (req, res) => {
    try {
      const category = req.query.category as string || "netWorth";
      const allUsers = await storage.getUsers();

      if (category === "sharesMined") {
        // Sort by total shares mined
        const ranked = allUsers
          .sort((a: User, b: User) => b.totalSharesMined - a.totalSharesMined)
          .map((u: User, index: number) => ({
            rank: index + 1,
            userId: u.id,
            username: u.username,
            firstName: u.firstName,
            lastName: u.lastName,
            profileImageUrl: u.profileImageUrl,
            value: u.totalSharesMined,
          }));
        
        return res.json({ category: "sharesMined", leaderboard: ranked });
      }

      if (category === "marketOrders") {
        // Sort by total market orders
        const ranked = allUsers
          .sort((a: User, b: User) => b.totalMarketOrders - a.totalMarketOrders)
          .map((u: User, index: number) => ({
            rank: index + 1,
            userId: u.id,
            username: u.username,
            firstName: u.firstName,
            lastName: u.lastName,
            profileImageUrl: u.profileImageUrl,
            value: u.totalMarketOrders,
          }));
        
        return res.json({ category: "marketOrders", leaderboard: ranked });
      }

      if (category === "netWorth") {
        // Calculate net worth for all users
        const usersWithNetWorth = await Promise.all(
          allUsers.map(async (u: User) => {
            const holdings = await storage.getUserHoldings(u.id);
            const holdingsVal = await Promise.all(
              holdings.map(async (h: Holding) => {
                if (h.assetType === "player") {
                  const p = await storage.getPlayer(h.assetId);
                  if (p) {
                    const lastTradePrice = p.lastTradePrice || await getLastTradePrice(p.id);
                    if (lastTradePrice) {
                      return parseFloat(lastTradePrice) * h.quantity;
                    }
                  }
                }
                return 0;
              })
            );
            const totalHoldingsVal = holdingsVal.reduce((sum: number, v: number) => sum + v, 0);
            return {
              userId: u.id,
              username: u.username,
              firstName: u.firstName,
              lastName: u.lastName,
              profileImageUrl: u.profileImageUrl,
              netWorth: parseFloat(u.balance) + totalHoldingsVal,
            };
          })
        );

        const ranked = usersWithNetWorth
          .sort((a, b) => b.netWorth - a.netWorth)
          .map((u, index) => ({
            rank: index + 1,
            userId: u.userId,
            username: u.username,
            firstName: u.firstName,
            lastName: u.lastName,
            profileImageUrl: u.profileImageUrl,
            value: u.netWorth.toFixed(2),
          }));

        return res.json({ category: "netWorth", leaderboard: ranked });
      }

      res.status(400).json({ error: "Invalid category" });
    } catch (error: any) {
      console.error("[leaderboards] Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Public user profile (anyone can view)
  app.get("/api/user/:userId/profile", async (req, res) => {
    try {
      const user = await storage.getUser(req.params.userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Get user holdings with market values
      const userHoldings = await storage.getUserHoldings(user.id);
      const enrichedHoldings = await Promise.all(
        userHoldings.map(async (holding) => {
          if (holding.assetType === "player") {
            const player = await storage.getPlayer(holding.assetId);
            if (player) {
              const lastTradePrice = player.lastTradePrice || await getLastTradePrice(player.id);
              const marketValue = lastTradePrice 
                ? (parseFloat(lastTradePrice) * holding.quantity).toFixed(2)
                : null;
              return {
                ...holding,
                player,
                lastTradePrice,
                marketValue,
              };
            }
          }
          return holding;
        })
      );

      // Calculate net worth (balance + total market value of holdings)
      const holdingsValue = enrichedHoldings.reduce((sum: number, h: any) => {
        return sum + (h.marketValue ? parseFloat(h.marketValue as string) : 0);
      }, 0);
      const netWorth = (parseFloat(user.balance) + holdingsValue).toFixed(2);

      // Get leaderboard rankings
      const allUsers = await storage.getUsers();
      
      // Calculate rankings
      const sharesMinedRank = allUsers
        .sort((a: User, b: User) => b.totalSharesMined - a.totalSharesMined)
        .findIndex((u: User) => u.id === user.id) + 1;
      
      const marketOrdersRank = allUsers
        .sort((a: User, b: User) => b.totalMarketOrders - a.totalMarketOrders)
        .findIndex((u: User) => u.id === user.id) + 1;

      // Calculate net worth for all users (with proper price fetching)
      const usersWithNetWorth = await Promise.all(
        allUsers.map(async (u: User) => {
          const holdings = await storage.getUserHoldings(u.id);
          const holdingsVal = await Promise.all(
            holdings.map(async (h: Holding) => {
              if (h.assetType === "player") {
                const p = await storage.getPlayer(h.assetId);
                if (p) {
                  // Use lastTradePrice from player, or fetch from trades if not cached
                  const lastTradePrice = p.lastTradePrice || await getLastTradePrice(p.id);
                  if (lastTradePrice) {
                    return parseFloat(lastTradePrice) * h.quantity;
                  }
                }
              }
              return 0;
            })
          );
          const totalHoldingsVal = holdingsVal.reduce((sum: number, v: number) => sum + v, 0);
          return {
            userId: u.id,
            netWorth: parseFloat(u.balance) + totalHoldingsVal,
          };
        })
      );

      const netWorthRank = usersWithNetWorth
        .sort((a: { userId: string; netWorth: number }, b: { userId: string; netWorth: number }) => b.netWorth - a.netWorth)
        .findIndex((u: { userId: string; netWorth: number }) => u.userId === user.id) + 1;

      res.json({
        user: {
          id: user.id,
          username: user.username,
          firstName: user.firstName,
          lastName: user.lastName,
          profileImageUrl: user.profileImageUrl,
          isPremium: user.isPremium,
          createdAt: user.createdAt,
        },
        stats: {
          netWorth,
          totalSharesMined: user.totalSharesMined,
          totalMarketOrders: user.totalMarketOrders,
          totalTradesExecuted: user.totalTradesExecuted,
          holdingsCount: enrichedHoldings.length,
        },
        rankings: {
          sharesMined: sharesMinedRank,
          marketOrders: marketOrdersRank,
          netWorth: netWorthRank,
        },
        holdings: enrichedHoldings.filter(h => h.assetType === "player" && h.quantity > 0),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Premium redeem
  app.post("/api/premium/redeem", async (req, res) => {
    try {
      const userId = "some-user-id";
      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      const premiumHolding = await storage.getHolding(user.id, "premium", "premium");

      if (!premiumHolding || premiumHolding.quantity < 1) {
        return res.status(400).json({ error: "No premium shares to redeem" });
      }

      // Burn 1 premium share
      await storage.updateHolding(user.id, "premium", "premium", premiumHolding.quantity - 1, "0.0000");

      // Grant premium access for 30 days
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      // Update user premium status (would use storage method, but simplified here)
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Admin middleware - validates ADMIN_API_TOKEN
  function adminAuth(req: any, res: any, next: any) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const expectedToken = process.env.ADMIN_API_TOKEN;
    
    if (!expectedToken) {
      console.warn('[ADMIN] ADMIN_API_TOKEN not configured - admin endpoints disabled');
      return res.status(503).json({ error: 'Admin endpoints not configured' });
    }
    
    if (token !== expectedToken) {
      const clientIp = req.ip || req.connection.remoteAddress;
      console.warn(`[ADMIN] Unauthorized access attempt from ${clientIp} to ${req.path}`);
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    next();
  }

  // Admin endpoint: Manually trigger cron jobs
  app.post("/api/admin/jobs/trigger", adminAuth, async (req, res) => {
    try {
      const { jobName } = req.body;
      const clientIp = req.ip || req.connection.remoteAddress;
      
      if (!jobName) {
        return res.status(400).json({ error: 'jobName required' });
      }
      
      const validJobs = ['roster_sync', 'schedule_sync', 'stats_sync'];
      if (!validJobs.includes(jobName)) {
        return res.status(400).json({ error: `Invalid jobName. Must be one of: ${validJobs.join(', ')}` });
      }
      
      console.log(`[ADMIN] Job trigger requested by ${clientIp}: ${jobName}`);
      
      const result = await jobScheduler.triggerJob(jobName);
      
      console.log(`[ADMIN] Job ${jobName} completed - ${result.recordsProcessed} records, ${result.errorCount} errors, ${result.requestCount} requests`);
      
      res.json({
        success: true,
        jobName,
        result,
      });
    } catch (error: any) {
      console.error('[ADMIN] Job trigger failed:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Initialize players on first run by triggering roster sync
  async function initializePlayers() {
    try {
      const existingPlayers = await storage.getPlayers();
      
      if (existingPlayers.length === 0) {
        console.log("No players found. Triggering roster_sync to fetch real NBA data from MySportsFeeds...");
        const result = await jobScheduler.triggerJob("roster_sync");
        console.log(`Roster sync completed: ${result.recordsProcessed} players loaded, ${result.errorCount} errors`);
      }
    } catch (error: any) {
      console.error("Failed to initialize players:", error.message);
    }
  }

  // Initialize data
  await initializePlayers();

  return httpServer;
}
