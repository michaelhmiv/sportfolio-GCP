import {
  users,
  players,
  holdings,
  orders,
  trades,
  mining,
  miningSplits,
  contests,
  contestEntries,
  contestLineups,
  playerGameStats,
  priceHistory,
  dailyGames,
  jobExecutionLogs,
  type User,
  type InsertUser,
  type UpsertUser,
  type Player,
  type InsertPlayer,
  type Holding,
  type Order,
  type Trade,
  type Mining,
  type MiningSplit,
  type InsertMiningSplit,
  type Contest,
  type InsertContest,
  type ContestEntry,
  type InsertContestEntry,
  type InsertContestLineup,
  type DailyGame,
  type InsertDailyGame,
  type JobExecutionLog,
  type InsertJobExecutionLog,
  type PlayerGameStats,
  type InsertPlayerGameStats,
} from "@shared/schema";
import { db } from "./db";
import { eq, and, desc, asc, sql } from "drizzle-orm";
import { randomUUID } from "crypto";

export interface IStorage {
  // User methods
  getUser(id: string): Promise<User | undefined>;
  getUsers(): Promise<User[]>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  upsertUser(user: UpsertUser): Promise<User>;
  updateUserBalance(userId: string, amount: string): Promise<void>;
  updateUsername(userId: string, username: string): Promise<User | undefined>;
  incrementTotalSharesMined(userId: string, amount: number): Promise<void>;
  
  // Player methods
  getPlayers(filters?: { search?: string; team?: string; position?: string }): Promise<Player[]>;
  getPlayer(id: string): Promise<Player | undefined>;
  upsertPlayer(player: InsertPlayer): Promise<Player>;
  getDistinctTeams(): Promise<string[]>;
  
  // Holdings methods
  getHolding(userId: string, assetType: string, assetId: string): Promise<Holding | undefined>;
  getUserHoldings(userId: string): Promise<Holding[]>;
  updateHolding(userId: string, assetType: string, assetId: string, quantity: number, avgCost: string): Promise<void>;
  
  // Order methods
  createOrder(order: any): Promise<Order>;
  getOrder(id: string): Promise<Order | undefined>;
  getUserOrders(userId: string, status?: string): Promise<Order[]>;
  getOrderBook(playerId: string): Promise<{ bids: Order[]; asks: Order[] }>;
  updateOrder(orderId: string, updates: Partial<Order>): Promise<void>;
  cancelOrder(orderId: string): Promise<void>;
  
  // Trade methods
  createTrade(trade: any): Promise<Trade>;
  getRecentTrades(playerId?: string, limit?: number): Promise<Trade[]>;
  
  // Mining methods
  getMining(userId: string): Promise<Mining | undefined>;
  updateMining(userId: string, updates: Partial<Mining>): Promise<void>;
  getMiningSplits(userId: string): Promise<MiningSplit[]>;
  setMiningSplits(userId: string, splits: InsertMiningSplit[]): Promise<void>;
  
  // Contest methods
  getContests(status?: string): Promise<Contest[]>;
  getContest(id: string): Promise<Contest | undefined>;
  createContest(contest: InsertContest): Promise<Contest>;
  updateContest(contestId: string, updates: Partial<Contest>): Promise<void>;
  createContestEntry(entry: InsertContestEntry): Promise<ContestEntry>;
  getContestEntries(contestId: string): Promise<ContestEntry[]>;
  getUserContestEntries(userId: string): Promise<ContestEntry[]>;
  createContestLineup(lineup: InsertContestLineup): Promise<void>;
  getContestLineups(entryId: string): Promise<any[]>;
  updateContestLineup(lineupId: string, updates: any): Promise<void>;
  updateContestEntry(entryId: string, updates: Partial<ContestEntry>): Promise<void>;
  getContestEntryDetail(contestId: string, entryId: string): Promise<any>;
  
  // Daily games methods
  upsertDailyGame(game: InsertDailyGame): Promise<DailyGame>;
  getDailyGames(startDate: Date, endDate: Date): Promise<DailyGame[]>;
  updateDailyGameStatus(gameId: string, status: string): Promise<void>;
  getGamesByTeam(teamAbbreviation: string, startDate: Date, endDate: Date): Promise<DailyGame[]>;
  
  // Job execution log methods
  createJobLog(log: InsertJobExecutionLog): Promise<JobExecutionLog>;
  updateJobLog(id: string, updates: Partial<JobExecutionLog>): Promise<void>;
  getRecentJobLogs(jobName?: string, limit?: number): Promise<JobExecutionLog[]>;
  
  // Player game stats methods
  upsertPlayerGameStats(stats: InsertPlayerGameStats): Promise<PlayerGameStats>;
  getPlayerGameStats(playerId: string, gameId: string): Promise<PlayerGameStats | undefined>;
  getGameStatsByGameId(gameId: number): Promise<PlayerGameStats[]>;
}

export class DatabaseStorage implements IStorage {
  // User methods
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUsers(): Promise<User[]> {
    return await db.select().from(users);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values({
        ...insertUser,
        balance: "10000.00", // Starting balance
      })
      .returning();
    
    // Initialize mining for new user
    await db.insert(mining).values({
      userId: user.id,
      sharesAccumulated: 0,
    });
    
    return user;
  }

  async upsertUser(userData: UpsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values({
        ...userData,
        balance: userData.balance || "10000.00", // Starting balance if new user
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          email: userData.email,
          firstName: userData.firstName,
          lastName: userData.lastName,
          profileImageUrl: userData.profileImageUrl,
          username: userData.username,
          updatedAt: new Date(),
        },
      })
      .returning();
    
    // Initialize mining for new user if it doesn't exist
    const existingMining = await db.select().from(mining).where(eq(mining.userId, user.id));
    if (existingMining.length === 0) {
      await db.insert(mining).values({
        userId: user.id,
        sharesAccumulated: 0,
      });
    }
    
    return user;
  }

  async updateUserBalance(userId: string, amount: string): Promise<void> {
    await db
      .update(users)
      .set({ balance: amount })
      .where(eq(users.id, userId));
  }

  async incrementTotalSharesMined(userId: string, amount: number): Promise<void> {
    await db
      .update(users)
      .set({ 
        totalSharesMined: sql`${users.totalSharesMined} + ${amount}`
      })
      .where(eq(users.id, userId));
  }

  async addUserBalance(userId: string, delta: number): Promise<User | undefined> {
    // Atomically increment the balance in the database
    // Drizzle handles numeric values correctly when passed directly
    await db
      .update(users)
      .set({ 
        // PostgreSQL handles the arithmetic atomically with proper precision
        balance: sql`${users.balance} + ${delta}`
      })
      .where(eq(users.id, userId));
    
    return await this.getUser(userId);
  }

  async updateUsername(userId: string, username: string): Promise<User | undefined> {
    await db
      .update(users)
      .set({ username, updatedAt: new Date() })
      .where(eq(users.id, userId));
    
    return await this.getUser(userId);
  }

  // Player methods
  async getPlayers(filters?: { search?: string; team?: string; position?: string }): Promise<Player[]> {
    // Build array of conditions to combine with AND
    const conditions = [];
    
    if (filters?.team && filters.team !== "all") {
      conditions.push(eq(players.team, filters.team));
    }
    if (filters?.position && filters.position !== "all") {
      conditions.push(eq(players.position, filters.position));
    }
    
    // Apply combined conditions
    let query: any = db.select().from(players);
    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }
    
    const results = await query;
    
    // Apply search filter in memory (simpler for now)
    if (filters?.search) {
      const searchLower = filters.search.toLowerCase();
      return results.filter((p: Player) =>
        p.firstName.toLowerCase().includes(searchLower) ||
        p.lastName.toLowerCase().includes(searchLower)
      );
    }
    
    return results;
  }

  async getPlayer(id: string): Promise<Player | undefined> {
    const [player] = await db.select().from(players).where(eq(players.id, id));
    return player || undefined;
  }

  async upsertPlayer(player: InsertPlayer): Promise<Player> {
    const existing = await this.getPlayer(player.id);
    
    if (existing) {
      const [updated] = await db
        .update(players)
        .set({ ...player, lastUpdated: new Date() })
        .where(eq(players.id, player.id))
        .returning();
      return updated;
    } else {
      const [created] = await db
        .insert(players)
        .values(player)
        .returning();
      return created;
    }
  }

  async getDistinctTeams(): Promise<string[]> {
    const result = await db
      .selectDistinct({ team: players.team })
      .from(players)
      .where(eq(players.isActive, true))
      .orderBy(asc(players.team));
    
    return result.map(r => r.team);
  }

  // Holdings methods
  async getHolding(userId: string, assetType: string, assetId: string): Promise<Holding | undefined> {
    const [holding] = await db
      .select()
      .from(holdings)
      .where(
        and(
          eq(holdings.userId, userId),
          eq(holdings.assetType, assetType),
          eq(holdings.assetId, assetId)
        )
      );
    return holding || undefined;
  }

  async getUserHoldings(userId: string): Promise<Holding[]> {
    return await db
      .select()
      .from(holdings)
      .where(eq(holdings.userId, userId));
  }

  async updateHolding(userId: string, assetType: string, assetId: string, quantity: number, avgCost: string): Promise<void> {
    const existing = await this.getHolding(userId, assetType, assetId);
    
    if (existing) {
      if (quantity <= 0) {
        // Remove holding - normalize to zero to avoid NaN
        await db
          .delete(holdings)
          .where(
            and(
              eq(holdings.userId, userId),
              eq(holdings.assetType, assetType),
              eq(holdings.assetId, assetId)
            )
          );
      } else {
        // Update holding - ensure proper rounding and cost basis persistence
        const avgCostParsed = parseFloat(avgCost);
        const avgCostNormalized = isNaN(avgCostParsed) ? "0.0000" : avgCostParsed.toFixed(4);
        const totalCost = (parseFloat(avgCostNormalized) * quantity).toFixed(2);
        
        await db
          .update(holdings)
          .set({
            quantity,
            avgCostBasis: avgCostNormalized,
            totalCostBasis: totalCost,
            lastUpdated: new Date(),
          })
          .where(
            and(
              eq(holdings.userId, userId),
              eq(holdings.assetType, assetType),
              eq(holdings.assetId, assetId)
            )
          );
      }
    } else if (quantity > 0) {
      // Create new holding - ensure proper rounding
      const avgCostParsed = parseFloat(avgCost);
      const avgCostNormalized = isNaN(avgCostParsed) ? "0.0000" : avgCostParsed.toFixed(4);
      const totalCost = (parseFloat(avgCostNormalized) * quantity).toFixed(2);
      
      await db.insert(holdings).values({
        userId,
        assetType,
        assetId,
        quantity,
        avgCostBasis: avgCostNormalized,
        totalCostBasis: totalCost,
      });
    }
  }

  // Order methods
  async createOrder(order: any): Promise<Order> {
    const [created] = await db
      .insert(orders)
      .values(order)
      .returning();
    return created;
  }

  async getOrder(id: string): Promise<Order | undefined> {
    const [order] = await db.select().from(orders).where(eq(orders.id, id));
    return order || undefined;
  }

  async getUserOrders(userId: string, status?: string): Promise<Order[]> {
    if (status) {
      return await db
        .select()
        .from(orders)
        .where(and(eq(orders.userId, userId), eq(orders.status, status)))
        .orderBy(desc(orders.createdAt));
    }
    return await db
      .select()
      .from(orders)
      .where(eq(orders.userId, userId))
      .orderBy(desc(orders.createdAt));
  }

  async getOrderBook(playerId: string): Promise<{ bids: Order[]; asks: Order[] }> {
    const allOrders = await db
      .select()
      .from(orders)
      .where(and(eq(orders.playerId, playerId), eq(orders.status, "open")));
    
    const bids = allOrders
      .filter(o => o.side === "buy" && o.orderType === "limit")
      .sort((a, b) => parseFloat(b.limitPrice || "0") - parseFloat(a.limitPrice || "0"));
    
    const asks = allOrders
      .filter(o => o.side === "sell" && o.orderType === "limit")
      .sort((a, b) => parseFloat(a.limitPrice || "0") - parseFloat(b.limitPrice || "0"));
    
    return { bids, asks };
  }

  async updateOrder(orderId: string, updates: Partial<Order>): Promise<void> {
    await db
      .update(orders)
      .set(updates)
      .where(eq(orders.id, orderId));
  }

  async cancelOrder(orderId: string): Promise<void> {
    await db
      .update(orders)
      .set({ status: "cancelled" })
      .where(eq(orders.id, orderId));
  }

  // Trade methods
  async createTrade(trade: any): Promise<Trade> {
    const [created] = await db
      .insert(trades)
      .values(trade)
      .returning();
    return created;
  }

  async getRecentTrades(playerId?: string, limit: number = 10): Promise<Trade[]> {
    if (playerId) {
      return await db
        .select()
        .from(trades)
        .where(eq(trades.playerId, playerId))
        .orderBy(desc(trades.executedAt))
        .limit(limit);
    }
    return await db
      .select()
      .from(trades)
      .orderBy(desc(trades.executedAt))
      .limit(limit);
  }

  // Mining methods
  async getMining(userId: string): Promise<Mining | undefined> {
    const [miningData] = await db
      .select()
      .from(mining)
      .where(eq(mining.userId, userId));
    return miningData || undefined;
  }

  async updateMining(userId: string, updates: Partial<Mining>): Promise<void> {
    await db
      .update(mining)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(mining.userId, userId));
  }

  async getMiningSplits(userId: string): Promise<MiningSplit[]> {
    return await db
      .select()
      .from(miningSplits)
      .where(eq(miningSplits.userId, userId));
  }

  async setMiningSplits(userId: string, splits: InsertMiningSplit[]): Promise<void> {
    // Delete existing splits
    await db.delete(miningSplits).where(eq(miningSplits.userId, userId));
    
    // Insert new splits
    if (splits.length > 0) {
      await db.insert(miningSplits).values(splits);
    }
  }

  // Contest methods
  async getContests(status?: string): Promise<Contest[]> {
    if (status) {
      return await db
        .select()
        .from(contests)
        .where(eq(contests.status, status))
        .orderBy(desc(contests.startsAt));
    }
    return await db
      .select()
      .from(contests)
      .orderBy(desc(contests.startsAt));
  }

  async getContest(id: string): Promise<Contest | undefined> {
    const [contest] = await db.select().from(contests).where(eq(contests.id, id));
    return contest || undefined;
  }

  async createContest(contest: InsertContest): Promise<Contest> {
    const [created] = await db
      .insert(contests)
      .values(contest)
      .returning();
    return created;
  }

  async createContestEntry(entry: InsertContestEntry): Promise<ContestEntry> {
    const [created] = await db
      .insert(contestEntries)
      .values(entry)
      .returning();
    return created;
  }

  async getContestEntries(contestId: string): Promise<ContestEntry[]> {
    return await db
      .select()
      .from(contestEntries)
      .where(eq(contestEntries.contestId, contestId))
      .orderBy(asc(contestEntries.rank));
  }

  async getUserContestEntries(userId: string): Promise<ContestEntry[]> {
    return await db
      .select()
      .from(contestEntries)
      .where(eq(contestEntries.userId, userId))
      .orderBy(desc(contestEntries.createdAt));
  }

  async createContestLineup(lineup: InsertContestLineup): Promise<void> {
    await db.insert(contestLineups).values(lineup);
  }

  async updateContestEntry(entryId: string, updates: Partial<ContestEntry>): Promise<void> {
    await db
      .update(contestEntries)
      .set(updates)
      .where(eq(contestEntries.id, entryId));
  }

  async updateContest(contestId: string, updates: Partial<Contest>): Promise<void> {
    await db
      .update(contests)
      .set(updates)
      .where(eq(contests.id, contestId));
  }

  async getContestLineups(entryId: string): Promise<any[]> {
    return await db
      .select()
      .from(contestLineups)
      .where(eq(contestLineups.entryId, entryId));
  }

  async updateContestLineup(lineupId: string, updates: any): Promise<void> {
    await db
      .update(contestLineups)
      .set(updates)
      .where(eq(contestLineups.id, lineupId));
  }

  async updateContestMetrics(contestId: string, totalShares: number, entryFee: string): Promise<void> {
    // Fetch current contest to calculate new values
    const [current] = await db
      .select()
      .from(contests)
      .where(eq(contests.id, contestId));
    
    if (!current) return;

    // Calculate new values
    const newEntryCount = current.entryCount + 1;
    const newTotalShares = current.totalSharesEntered + totalShares;
    // Prize pool equals total shares (1 share = $1)
    const newPrizePool = newTotalShares;

    // Update with calculated values
    await db
      .update(contests)
      .set({
        entryCount: newEntryCount,
        totalSharesEntered: newTotalShares,
        totalPrizePool: newPrizePool.toFixed(2),
      })
      .where(eq(contests.id, contestId));
  }

  async getContestEntryWithLineup(entryId: string, userId: string): Promise<{ entry: ContestEntry; lineup: any[] } | null> {
    const [entry] = await db
      .select()
      .from(contestEntries)
      .where(and(eq(contestEntries.id, entryId), eq(contestEntries.userId, userId)));
    
    if (!entry) return null;

    const lineup = await this.getContestLineups(entryId);
    return { entry, lineup };
  }

  async deleteContestLineup(entryId: string): Promise<void> {
    await db
      .delete(contestLineups)
      .where(eq(contestLineups.entryId, entryId));
  }

  async getContestEntryDetail(contestId: string, entryId: string): Promise<any> {
    // Get the entry with user information
    const [entry] = await db
      .select({
        id: contestEntries.id,
        contestId: contestEntries.contestId,
        userId: contestEntries.userId,
        username: users.username,
        totalSharesEntered: contestEntries.totalSharesEntered,
        totalScore: contestEntries.totalScore,
        rank: contestEntries.rank,
        payout: contestEntries.payout,
        createdAt: contestEntries.createdAt,
      })
      .from(contestEntries)
      .innerJoin(users, eq(contestEntries.userId, users.id))
      .where(and(
        eq(contestEntries.id, entryId),
        eq(contestEntries.contestId, contestId)
      ));

    if (!entry) {
      return null;
    }

    // Get contest details for entry fee
    const contest = await this.getContest(contestId);
    if (!contest) {
      return null;
    }

    // Get the lineup with player details
    const lineup = await db
      .select({
        id: contestLineups.id,
        playerId: contestLineups.playerId,
        playerFirstName: players.firstName,
        playerLastName: players.lastName,
        playerTeam: players.team,
        playerPosition: players.position,
        sharesEntered: contestLineups.sharesEntered,
        fantasyPoints: contestLineups.fantasyPoints,
        earnedScore: contestLineups.earnedScore,
      })
      .from(contestLineups)
      .innerJoin(players, eq(contestLineups.playerId, players.id))
      .where(eq(contestLineups.entryId, entryId));

    // For each player, calculate percentage of total shares entered for that player in this contest
    const lineupWithPercentages = await Promise.all(
      lineup.map(async (lineupItem) => {
        // Sum all shares entered for this player across all entries in the contest
        const [totalSharesResult] = await db
          .select({
            totalShares: sql<number>`CAST(COALESCE(SUM(${contestLineups.sharesEntered}), 0) AS INTEGER)`,
          })
          .from(contestLineups)
          .leftJoin(contestEntries, eq(contestLineups.entryId, contestEntries.id))
          .where(and(
            eq(contestEntries.contestId, contestId),
            eq(contestLineups.playerId, lineupItem.playerId)
          ));

        const totalPlayerShares = totalSharesResult?.totalShares || 0;
        const percentage = totalPlayerShares > 0 
          ? ((lineupItem.sharesEntered / totalPlayerShares) * 100).toFixed(2)
          : "0.00";

        return {
          ...lineupItem,
          totalPlayerSharesInContest: totalPlayerShares,
          ownershipPercentage: percentage,
        };
      })
    );

    // Net winnings equals payout (no entry fees in this system)
    const payout = parseFloat(entry.payout);

    return {
      entry: {
        ...entry,
        netWinnings: payout.toFixed(2),
      },
      lineup: lineupWithPercentages,
      contest: {
        id: contest.id,
        name: contest.name,
        status: contest.status,
        totalPrizePool: contest.totalPrizePool,
      },
    };
  }

  // Daily games methods
  async upsertDailyGame(game: InsertDailyGame): Promise<DailyGame> {
    const [existing] = await db
      .select()
      .from(dailyGames)
      .where(eq(dailyGames.gameId, game.gameId));

    if (existing) {
      const [updated] = await db
        .update(dailyGames)
        .set({ ...game, lastFetchedAt: new Date() })
        .where(eq(dailyGames.gameId, game.gameId))
        .returning();
      return updated;
    } else {
      const [created] = await db
        .insert(dailyGames)
        .values(game)
        .returning();
      return created;
    }
  }

  async getDailyGames(startDate: Date, endDate: Date): Promise<DailyGame[]> {
    return await db
      .select()
      .from(dailyGames)
      .where(
        and(
          sql`${dailyGames.date} >= ${startDate}`,
          sql`${dailyGames.date} <= ${endDate}`
        )
      )
      .orderBy(asc(dailyGames.startTime));
  }

  async updateDailyGameStatus(gameId: string, status: string): Promise<void> {
    await db
      .update(dailyGames)
      .set({ status, lastFetchedAt: new Date() })
      .where(eq(dailyGames.gameId, gameId));
  }

  async getGamesByTeam(teamAbbreviation: string, startDate: Date, endDate: Date): Promise<DailyGame[]> {
    return await db
      .select()
      .from(dailyGames)
      .where(
        and(
          sql`${dailyGames.date} >= ${startDate}`,
          sql`${dailyGames.date} <= ${endDate}`,
          sql`(${dailyGames.homeTeam} = ${teamAbbreviation} OR ${dailyGames.awayTeam} = ${teamAbbreviation})`
        )
      )
      .orderBy(asc(dailyGames.startTime));
  }

  // Job execution log methods
  async createJobLog(log: InsertJobExecutionLog): Promise<JobExecutionLog> {
    const [created] = await db
      .insert(jobExecutionLogs)
      .values(log)
      .returning();
    return created;
  }

  async updateJobLog(id: string, updates: Partial<JobExecutionLog>): Promise<void> {
    await db
      .update(jobExecutionLogs)
      .set(updates)
      .where(eq(jobExecutionLogs.id, id));
  }

  async getRecentJobLogs(jobName?: string, limit: number = 50): Promise<JobExecutionLog[]> {
    let query: any = db.select().from(jobExecutionLogs);
    
    if (jobName) {
      query = query.where(eq(jobExecutionLogs.jobName, jobName));
    }
    
    return await query
      .orderBy(desc(jobExecutionLogs.scheduledFor))
      .limit(limit);
  }

  // Player game stats methods
  async upsertPlayerGameStats(stats: InsertPlayerGameStats): Promise<PlayerGameStats> {
    const [existing] = await db
      .select()
      .from(playerGameStats)
      .where(
        and(
          eq(playerGameStats.playerId, stats.playerId),
          eq(playerGameStats.gameId, stats.gameId)
        )
      );

    if (existing) {
      const [updated] = await db
        .update(playerGameStats)
        .set({ ...stats, lastFetchedAt: new Date() })
        .where(eq(playerGameStats.id, existing.id))
        .returning();
      return updated;
    } else {
      const [created] = await db
        .insert(playerGameStats)
        .values(stats)
        .returning();
      return created;
    }
  }

  async getPlayerGameStats(playerId: string, gameId: string): Promise<PlayerGameStats | undefined> {
    const [stats] = await db
      .select()
      .from(playerGameStats)
      .where(
        and(
          eq(playerGameStats.playerId, playerId),
          eq(playerGameStats.gameId, gameId)
        )
      );
    return stats || undefined;
  }

  async getGameStatsByGameId(gameId: number): Promise<PlayerGameStats[]> {
    return await db
      .select()
      .from(playerGameStats)
      .where(eq(playerGameStats.gameId, String(gameId)));
  }
}

export const storage = new DatabaseStorage();
