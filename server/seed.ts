import { db } from "./db";
import { users, players, mining, contests, holdings, dailyGames } from "@shared/schema";
import { sql, and, gte, lte, asc } from "drizzle-orm";

async function seed() {
  console.log("Seeding database...");

  // Create demo user
  const [user] = await db
    .insert(users)
    .values({
      username: "demo",
      balance: "10000.00",
    })
    .onConflictDoUpdate({
      target: users.username,
      set: { balance: "10000.00" },
    })
    .returning();

  console.log("Created user:", user.username);

  // Seed players first (before mining references them)
  const mockPlayers = [
    { id: "lebron-james", firstName: "LeBron", lastName: "James", currentTeam: { abbreviation: "LAL" }, primaryPosition: "F", jerseyNumber: "23" },
    { id: "stephen-curry", firstName: "Stephen", lastName: "Curry", currentTeam: { abbreviation: "GSW" }, primaryPosition: "G", jerseyNumber: "30" },
    { id: "kevin-durant", firstName: "Kevin", lastName: "Durant", currentTeam: { abbreviation: "PHX" }, primaryPosition: "F", jerseyNumber: "35" },
    { id: "giannis-antetokounmpo", firstName: "Giannis", lastName: "Antetokounmpo", currentTeam: { abbreviation: "MIL" }, primaryPosition: "F", jerseyNumber: "34" }
  ];
  for (const player of mockPlayers) {
    await db
      .insert(players)
      .values({
        id: player.id,
        firstName: player.firstName,
        lastName: player.lastName,
        team: player.currentTeam?.abbreviation || "UNK",
        position: player.primaryPosition || "G",
        jerseyNumber: player.jerseyNumber || "",
        isActive: true,
        isEligibleForMining: true,
        currentPrice: (10 + Math.random() * 20).toFixed(2),
        volume24h: Math.floor(Math.random() * 10000),
        priceChange24h: ((Math.random() - 0.5) * 10).toFixed(2),
      })
      .onConflictDoUpdate({
        target: players.id,
        set: {
          currentPrice: (10 + Math.random() * 20).toFixed(2),
          volume24h: Math.floor(Math.random() * 10000),
          priceChange24h: ((Math.random() - 0.5) * 10).toFixed(2),
        },
      });
  }

  console.log(`Seeded ${mockPlayers.length} players`);

  // Create mining record (after players exist)
  await db
    .insert(mining)
    .values({
      userId: user.id,
      sharesAccumulated: 1200,
      playerId: "lebron-james",
    })
    .onConflictDoUpdate({
      target: mining.userId,
      set: { sharesAccumulated: 1200, playerId: "lebron-james" },
    });

  console.log("Created mining record");

  // Give user some shares
  const someShares = [
    { playerId: "lebron-james", quantity: 50, avgCost: "12.50" },
    { playerId: "stephen-curry", quantity: 30, avgCost: "15.00" },
    { playerId: "kevin-durant", quantity: 20, avgCost: "18.00" },
  ];

  for (const share of someShares) {
    await db
      .insert(holdings)
      .values({
        userId: user.id,
        assetType: "player",
        assetId: share.playerId,
        quantity: share.quantity,
        avgCostBasis: share.avgCost,
        totalCostBasis: (share.quantity * parseFloat(share.avgCost)).toFixed(2),
      })
      .onConflictDoNothing();
  }

  console.log("Created holdings");

  // Seed mock games for today (before creating contest)
  // Use ET timezone logic (same as /api/games/today endpoint)
  const now = new Date();
  const etOffset = -5; // ET is UTC-5 (EST) or UTC-4 (EDT), using -5 for simplicity
  const nowET = new Date(now.getTime() + (etOffset * 60 * 60 * 1000));
  
  // Get start and end of day in ET, then convert back to UTC for database
  const startOfDayET = new Date(nowET.getFullYear(), nowET.getMonth(), nowET.getDate(), 0, 0, 0);
  const endOfDayET = new Date(nowET.getFullYear(), nowET.getMonth(), nowET.getDate(), 23, 59, 59);
  
  // Convert ET boundaries to UTC for database query
  const startOfDayUTC = new Date(startOfDayET.getTime() - (etOffset * 60 * 60 * 1000));
  const endOfDayUTC = new Date(endOfDayET.getTime() - (etOffset * 60 * 60 * 1000));
  
  // Create a pure date for gameDate field (midnight ET in local timezone representation)
  const todayDate = new Date(nowET.getFullYear(), nowET.getMonth(), nowET.getDate(), 0, 0, 0);

  // Create some mock games at different times today (in ET timezone)
  const game1StartET = new Date(nowET.getFullYear(), nowET.getMonth(), nowET.getDate(), 17, 0, 0); // 5:00 PM ET
  const game2StartET = new Date(nowET.getFullYear(), nowET.getMonth(), nowET.getDate(), 18, 30, 0); // 6:30 PM ET
  
  const mockGames = [
    {
      gameId: "game-1-today",
      homeTeam: "LAL",
      awayTeam: "GSW",
      startTime: new Date(game1StartET.getTime() - (etOffset * 60 * 60 * 1000)), // Convert to UTC
      status: "scheduled" as const,
      date: todayDate,
    },
    {
      gameId: "game-2-today",
      homeTeam: "MIL",
      awayTeam: "PHX",
      startTime: new Date(game2StartET.getTime() - (etOffset * 60 * 60 * 1000)), // Convert to UTC
      status: "scheduled" as const,
      date: todayDate,
    },
  ];

  for (const game of mockGames) {
    await db
      .insert(dailyGames)
      .values(game)
      .onConflictDoUpdate({
        target: dailyGames.gameId,
        set: game,
      });
  }

  console.log("Created mock games for today (ET timezone)");
  
  // Fetch games for today (using ET boundaries) to find the earliest start time
  const todayGames = await db
    .select()
    .from(dailyGames)
    .where(and(
      gte(dailyGames.startTime, startOfDayUTC),
      lte(dailyGames.startTime, endOfDayUTC)
    ))
    .orderBy(asc(dailyGames.startTime));
  
  // Set contest start time to earliest game time, or default to 7pm ET if no games
  const defaultStartET = new Date(nowET.getFullYear(), nowET.getMonth(), nowET.getDate(), 19, 0, 0);
  const defaultStartTime = new Date(defaultStartET.getTime() - (etOffset * 60 * 60 * 1000));
  
  const contestStartTime = todayGames.length > 0 
    ? todayGames[0].startTime 
    : defaultStartTime;

  await db
    .insert(contests)
    .values({
      name: "NBA 50/50 - Today's Games",
      sport: "NBA",
      contestType: "50/50",
      gameDate: todayDate,
      status: "open",
      totalSharesEntered: 0,
      totalPrizePool: "0.00",
      entryCount: 0,
      startsAt: contestStartTime,
    })
    .onConflictDoNothing();

  console.log("Created contest");

  console.log("✓ Seeding complete!");
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed error:", err);
    process.exit(1);
  });
