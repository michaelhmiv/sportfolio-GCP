import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, Plus, Minus, Trophy } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { invalidatePortfolioQueries, invalidateContestQueries } from "@/lib/cache-invalidation";
import type { Player, Holding } from "@shared/schema";

interface ContestEntryData {
  contest: {
    id: string;
    name: string;
    sport: string;
    startsAt: string;
  };
  eligiblePlayers: (Holding & { player: Player; isEligible: boolean })[];
}

interface LineupEntry {
  playerId: string;
  playerName: string;
  team: string;
  position: string;
  sharesEntered: number;
  maxShares: number;
}

export default function ContestEntry() {
  const { id, entryId } = useParams<{ id: string; entryId?: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [lineup, setLineup] = useState<Map<string, LineupEntry>>(new Map());
  const isEditMode = !!entryId;

  const { data, isLoading } = useQuery<ContestEntryData>({
    queryKey: ["/api/contest", id, "entry"],
    enabled: !isEditMode,
  });

  // Fetch existing entry for edit mode
  const { data: existingEntry, isLoading: isLoadingEntry } = useQuery<any>({
    queryKey: ["/api/contest", id, "entry", entryId],
    enabled: isEditMode,
  });

  // Pre-populate lineup in edit mode using API-provided eligiblePlayers
  useEffect(() => {
    if (isEditMode && existingEntry?.lineup && existingEntry?.eligiblePlayers) {
      const newLineup = new Map<string, LineupEntry>();
      for (const lineupItem of existingEntry.lineup) {
        const player = lineupItem.player;
        if (player) {
          // Find the eligible player entry with correct maxShares already calculated by API
          const eligiblePlayer = existingEntry.eligiblePlayers.find((ep: any) => ep.assetId === player.id);
          newLineup.set(player.id, {
            playerId: player.id,
            playerName: `${player.firstName} ${player.lastName}`,
            team: player.team,
            position: player.position,
            sharesEntered: lineupItem.sharesEntered,
            maxShares: eligiblePlayer?.quantity || lineupItem.sharesEntered, // Use API-provided quantity
          });
        }
      }
      setLineup(newLineup);
    }
  }, [isEditMode, existingEntry]);

  const submitEntryMutation = useMutation({
    mutationFn: async (lineupData: { playerId: string; sharesEntered: number }[]) => {
      if (isEditMode) {
        return await apiRequest("PUT", `/api/contest/${id}/entry/${entryId}`, { lineup: lineupData });
      }
      return await apiRequest("POST", `/api/contest/${id}/enter`, { lineup: lineupData });
    },
    onSuccess: () => {
      toast({ title: isEditMode ? "Contest entry updated!" : "Contest entry submitted!" });
      // Invalidate all portfolio and contest queries to ensure synchronization across all pages
      invalidatePortfolioQueries();
      invalidateContestQueries();
      navigate("/contests");
    },
    onError: (error: Error) => {
      toast({ title: isEditMode ? "Update failed" : "Entry failed", description: error.message, variant: "destructive" });
    },
  });

  const addToLineup = (holding: Holding & { player: Player }) => {
    const entry: LineupEntry = {
      playerId: holding.player.id,
      playerName: `${holding.player.firstName} ${holding.player.lastName}`,
      team: holding.player.team,
      position: holding.player.position,
      sharesEntered: 1,
      maxShares: holding.quantity,
    };
    setLineup(new Map(lineup.set(holding.player.id, entry)));
  };

  const removeFromLineup = (playerId: string) => {
    const newLineup = new Map(lineup);
    newLineup.delete(playerId);
    setLineup(newLineup);
  };

  const updateShares = (playerId: string, shares: number) => {
    const entry = lineup.get(playerId);
    if (entry && shares >= 1 && shares <= entry.maxShares) {
      setLineup(new Map(lineup.set(playerId, { ...entry, sharesEntered: shares })));
    }
  };

  const getTotalShares = () => {
    return Array.from(lineup.values()).reduce((sum, entry) => sum + entry.sharesEntered, 0);
  };

  const handleSubmit = () => {
    if (lineup.size === 0) {
      toast({ title: "Add at least one player", variant: "destructive" });
      return;
    }

    const lineupData = Array.from(lineup.values()).map(entry => ({
      playerId: entry.playerId,
      sharesEntered: entry.sharesEntered,
    }));

    submitEntryMutation.mutate(lineupData);
  };

  if ((isEditMode && (isLoadingEntry || !existingEntry)) || (!isEditMode && (isLoading || !data))) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-muted-foreground">Loading contest...</div>
      </div>
    );
  }

  const contestData = isEditMode ? existingEntry?.contest : data?.contest;
  const eligiblePlayers = isEditMode ? (existingEntry?.eligiblePlayers || []) : (data?.eligiblePlayers || []);
  const filteredPlayers = eligiblePlayers.filter((holding: any) =>
    holding.player.firstName.toLowerCase().includes(search.toLowerCase()) ||
    holding.player.lastName.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-background p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-2">
            <Trophy className="w-6 h-6 text-primary" />
            <h1 className="text-3xl font-bold">{contestData?.name}</h1>
            {isEditMode && <Badge>Editing Entry</Badge>}
          </div>
          <p className="text-muted-foreground">
            {isEditMode ? "Edit your lineup before the contest locks" : "Select players from your portfolio to enter this contest"}
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Available Players */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium uppercase tracking-wide">Your Eligible Players</CardTitle>
              <div className="relative mt-4">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search players..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                  data-testid="input-search-eligible"
                />
              </div>
            </CardHeader>
            <CardContent className="space-y-2 max-h-[600px] overflow-y-auto">
              {filteredPlayers.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">
                  No eligible players found
                </div>
              ) : (
                filteredPlayers.map((holding: Holding & { player: Player; isEligible: boolean }) => (
                  <div
                    key={holding.player.id}
                    className="flex items-center justify-between p-3 border rounded-md hover-elevate"
                    data-testid={`player-available-${holding.player.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                        <span className="font-bold text-sm">
                          {holding.player.firstName[0]}{holding.player.lastName[0]}
                        </span>
                      </div>
                      <div>
                        <div className="font-medium">{holding.player.firstName} {holding.player.lastName}</div>
                        <div className="text-xs text-muted-foreground">
                          {holding.player.team} · {holding.player.position} · {holding.quantity} shares
                        </div>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => addToLineup(holding)}
                      disabled={lineup.has(holding.player.id) || !holding.isEligible}
                      data-testid={`button-add-${holding.player.id}`}
                    >
                      <Plus className="w-4 h-4" />
                    </Button>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* Lineup */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium uppercase tracking-wide">Your Lineup</CardTitle>
                <Badge variant="outline" data-testid="badge-total-shares">
                  {getTotalShares()} Total Shares
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {lineup.size === 0 ? (
                <div className="py-12 text-center text-muted-foreground">
                  Add players to your lineup
                </div>
              ) : (
                <div className="space-y-3">
                  {Array.from(lineup.values()).map((entry) => (
                    <div
                      key={entry.playerId}
                      className="p-3 border rounded-md"
                      data-testid={`lineup-entry-${entry.playerId}`}
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <div className="font-medium">{entry.playerName}</div>
                          <div className="text-xs text-muted-foreground">
                            {entry.team} · {entry.position}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => removeFromLineup(entry.playerId)}
                          data-testid={`button-remove-${entry.playerId}`}
                        >
                          <Minus className="w-4 h-4" />
                        </Button>
                      </div>
                      
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => updateShares(entry.playerId, entry.sharesEntered - 1)}
                          disabled={entry.sharesEntered <= 1}
                          data-testid={`button-decrease-${entry.playerId}`}
                        >
                          -
                        </Button>
                        <Input
                          type="number"
                          value={entry.sharesEntered}
                          onChange={(e) => updateShares(entry.playerId, parseInt(e.target.value) || 1)}
                          className="text-center font-mono"
                          min={1}
                          max={entry.maxShares}
                          data-testid={`input-shares-${entry.playerId}`}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => updateShares(entry.playerId, entry.sharesEntered + 1)}
                          disabled={entry.sharesEntered >= entry.maxShares}
                          data-testid={`button-increase-${entry.playerId}`}
                        >
                          +
                        </Button>
                        <span className="text-sm text-muted-foreground">/ {entry.maxShares}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="pt-4 border-t space-y-4">
                <div className="p-4 bg-muted rounded-md">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm text-muted-foreground">Prize Pool</span>
                    <span className="text-xl font-mono font-bold text-positive">
                      ${getTotalShares() * 1} {/* $1 per share */}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Potential Payout (Top 50%)</span>
                    <span className="text-xl font-mono font-bold text-positive">
                      ${getTotalShares() * 2} {/* $2 per share */}
                    </span>
                  </div>
                </div>

                <Button
                  className="w-full"
                  size="lg"
                  onClick={handleSubmit}
                  disabled={lineup.size === 0 || submitEntryMutation.isPending}
                  data-testid="button-submit-entry"
                >
                  {submitEntryMutation.isPending ? "Submitting..." : "Submit Entry"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
