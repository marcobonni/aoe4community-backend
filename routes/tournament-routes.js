const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const router = express.Router();

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const tournamentAdminKey = process.env.TOURNAMENT_ADMIN_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    "Missing Supabase env vars. Required: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY"
  );
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

function getAuthToken(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length).trim();
}

async function requireUser(req, res, next) {
  try {
    const token = getAuthToken(req);

    if (!token) {
      return res.status(401).json({
        error: "Missing bearer token",
      });
    }

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({
        error: "Invalid or expired token",
      });
    }

    req.user = data.user;
    next();
  } catch (error) {
    console.error("requireUser error:", error);
    return res.status(500).json({
      error: "Authentication check failed",
    });
  }
}

function requireAdmin(req, res, next) {
  const adminKey = req.headers["x-admin-key"];

  if (!tournamentAdminKey || adminKey !== tournamentAdminKey) {
    return res.status(403).json({
      error: "Unauthorized admin request",
    });
  }

  next();
}

function nextPowerOfTwo(n) {
  if (n <= 1) return 1;
  return 2 ** Math.ceil(Math.log2(n));
}

function createSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

async function ensureProfile(user) {
  const email = user.email || null;
  const displayName =
    user.user_metadata?.full_name ||
    user.user_metadata?.name ||
    user.user_metadata?.user_name ||
    (email ? email.split("@")[0] : "Player");

  const discordName =
    user.user_metadata?.discord_name ||
    user.user_metadata?.preferred_username ||
    null;

  const steamName = user.user_metadata?.steam_name || null;
  const avatarUrl = user.user_metadata?.avatar_url || null;

  const upsertPayload = {
    id: user.id,
    email,
    display_name: displayName,
    discord_name: discordName,
    steam_name: steamName,
    avatar_url: avatarUrl,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("profiles").upsert(upsertPayload);

  if (error) {
    throw error;
  }
}

async function getActiveTournament() {
  const { data, error } = await supabase
    .from("tournaments")
    .select("*")
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getTournamentById(tournamentId) {
  const { data, error } = await supabase
    .from("tournaments")
    .select("*")
    .eq("id", tournamentId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getRegistration(tournamentId, userId) {
  const { data, error } = await supabase
    .from("tournament_registrations")
    .select(
      `
      *,
      profile:profiles!tournament_registrations_user_id_fkey (
        id,
        email,
        display_name,
        discord_name,
        steam_name,
        avatar_url
      )
    `
    )
    .eq("tournament_id", tournamentId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getUserMatch(tournamentId, userId) {
  const { data, error } = await supabase
    .from("tournament_matches")
    .select(
      `
      *,
      player1:profiles!tournament_matches_player1_id_fkey (
        id,
        display_name,
        discord_name,
        steam_name,
        avatar_url
      ),
      player2:profiles!tournament_matches_player2_id_fkey (
        id,
        display_name,
        discord_name,
        steam_name,
        avatar_url
      ),
      winner:profiles!tournament_matches_winner_id_fkey (
        id,
        display_name,
        discord_name,
        steam_name,
        avatar_url
      )
    `
    )
    .eq("tournament_id", tournamentId)
    .or(`player1_id.eq.${userId},player2_id.eq.${userId}`)
    .order("round_number", { ascending: true })
    .order("match_number", { ascending: true });

  if (error) throw error;

  return (data || []).find((match) => !match.winner_id) || data?.[0] || null;
}

async function maybeAdvanceBye(match) {
  const p1 = match.player1_id;
  const p2 = match.player2_id;

  if ((p1 && p2) || (!p1 && !p2)) return;

  const autoWinnerId = p1 || p2;
  if (!autoWinnerId) return;

  const { error } = await supabase
    .from("tournament_matches")
    .update({
      winner_id: autoWinnerId,
      status: "completed",
      updated_at: new Date().toISOString(),
    })
    .eq("id", match.id);

  if (error) throw error;
}

async function propagateWinner(matchId) {
  const { data: match, error: matchError } = await supabase
    .from("tournament_matches")
    .select("*")
    .eq("id", matchId)
    .maybeSingle();

  if (matchError) throw matchError;
  if (!match || !match.winner_id || !match.next_match_id) return;

  const { data: nextMatch, error: nextMatchError } = await supabase
    .from("tournament_matches")
    .select("*")
    .eq("id", match.next_match_id)
    .maybeSingle();

  if (nextMatchError) throw nextMatchError;
  if (!nextMatch) return;

  const updatePayload = {
    updated_at: new Date().toISOString(),
  };

  if (match.next_match_slot === 1 && !nextMatch.player1_id) {
    updatePayload.player1_id = match.winner_id;
  }

  if (match.next_match_slot === 2 && !nextMatch.player2_id) {
    updatePayload.player2_id = match.winner_id;
  }

  const hasSomethingToUpdate =
    Object.prototype.hasOwnProperty.call(updatePayload, "player1_id") ||
    Object.prototype.hasOwnProperty.call(updatePayload, "player2_id");

  if (!hasSomethingToUpdate) return;

  const { error: updateError } = await supabase
    .from("tournament_matches")
    .update(updatePayload)
    .eq("id", nextMatch.id);

  if (updateError) throw updateError;

  const { data: refreshedNext, error: refreshedError } = await supabase
    .from("tournament_matches")
    .select("*")
    .eq("id", nextMatch.id)
    .maybeSingle();

  if (refreshedError) throw refreshedError;
  if (!refreshedNext) return;

  await maybeAdvanceBye(refreshedNext);

  if (
    (refreshedNext.player1_id && !refreshedNext.player2_id) ||
    (!refreshedNext.player1_id && refreshedNext.player2_id)
  ) {
    await propagateWinner(refreshedNext.id);
  }
}

router.get("/health", async (req, res) => {
  return res.json({
    ok: true,
    scope: "tournament",
  });
});

router.get("/me", requireUser, async (req, res) => {
  try {
    await ensureProfile(req.user);

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", req.user.id)
      .maybeSingle();

    if (error) throw error;

    return res.json({
      user: req.user,
      profile,
    });
  } catch (error) {
    console.error("GET /me error:", error);
    return res.status(500).json({
      error: "Failed to load profile",
    });
  }
});

router.post("/complete-profile", requireUser, async (req, res) => {
  try {
    const discordName = String(req.body.discord_name || "").trim();
    const steamName = String(req.body.steam_name || "").trim();
    const displayName = String(req.body.display_name || "").trim();

    if (!discordName || !steamName) {
      return res.status(400).json({
        error: "discord_name and steam_name are required",
      });
    }

    await ensureProfile(req.user);

    const updatePayload = {
      discord_name: discordName,
      steam_name: steamName,
      updated_at: new Date().toISOString(),
    };

    if (displayName) {
      updatePayload.display_name = displayName;
    }

    const { data, error } = await supabase
      .from("profiles")
      .update(updatePayload)
      .eq("id", req.user.id)
      .select("*")
      .maybeSingle();

    if (error) throw error;

    return res.json({
      ok: true,
      profile: data,
    });
  } catch (error) {
    console.error("POST /complete-profile error:", error);
    return res.status(500).json({
      error: "Failed to update profile",
    });
  }
});

router.get("/active", async (req, res) => {
  try {
    const tournament = await getActiveTournament();

    return res.json({
      tournament,
    });
  } catch (error) {
    console.error("GET /active error:", error);
    return res.status(500).json({
      error: "Failed to load active tournament",
    });
  }
});

router.post("/register", requireUser, async (req, res) => {
  try {
    await ensureProfile(req.user);

    const tournament = await getActiveTournament();

    if (!tournament) {
      return res.status(404).json({
        error: "No active tournament found",
      });
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", req.user.id)
      .maybeSingle();

    if (profileError) throw profileError;

    if (!profile?.discord_name || !profile?.steam_name) {
      return res.status(400).json({
        error: "Complete your profile with Discord name and Steam name before registering",
      });
    }

    const existing = await getRegistration(tournament.id, req.user.id);

    if (existing) {
      return res.json({
        ok: true,
        alreadyRegistered: true,
        registration: existing,
      });
    }

    const { data, error } = await supabase
      .from("tournament_registrations")
      .insert({
        tournament_id: tournament.id,
        user_id: req.user.id,
        seed: null,
        status: "registered",
      })
      .select(
        `
        *,
        profile:profiles!tournament_registrations_user_id_fkey (
          id,
          email,
          display_name,
          discord_name,
          steam_name,
          avatar_url
        )
      `
      )
      .maybeSingle();

    if (error) throw error;

    return res.json({
      ok: true,
      registration: data,
    });
  } catch (error) {
    console.error("POST /register error:", error);
    return res.status(500).json({
      error: "Failed to register to tournament",
    });
  }
});

router.get("/my-registration", requireUser, async (req, res) => {
  try {
    const tournament = await getActiveTournament();

    if (!tournament) {
      return res.json({
        tournament: null,
        registration: null,
        nextMatch: null,
      });
    }

    const registration = await getRegistration(tournament.id, req.user.id);
    const nextMatch = await getUserMatch(tournament.id, req.user.id);

    return res.json({
      tournament,
      registration,
      nextMatch,
    });
  } catch (error) {
    console.error("GET /my-registration error:", error);
    return res.status(500).json({
      error: "Failed to load registration status",
    });
  }
});

router.get("/bracket/:slug?", async (req, res) => {
  try {
    const slug = req.params.slug;

    let tournament = null;

    if (slug) {
      const { data, error } = await supabase
        .from("tournaments")
        .select("*")
        .eq("slug", slug)
        .maybeSingle();

      if (error) throw error;
      tournament = data || null;
    } else {
      tournament = await getActiveTournament();
    }

    if (!tournament) {
      return res.json({
        tournament: null,
        matches: [],
      });
    }

    const { data: matches, error } = await supabase
      .from("tournament_matches")
      .select(
        `
        *,
        player1:profiles!tournament_matches_player1_id_fkey (
          id,
          display_name,
          discord_name,
          steam_name,
          avatar_url
        ),
        player2:profiles!tournament_matches_player2_id_fkey (
          id,
          display_name,
          discord_name,
          steam_name,
          avatar_url
        ),
        winner:profiles!tournament_matches_winner_id_fkey (
          id,
          display_name,
          discord_name,
          steam_name,
          avatar_url
        )
      `
      )
      .eq("tournament_id", tournament.id)
      .order("round_number", { ascending: true })
      .order("match_number", { ascending: true });

    if (error) throw error;

    return res.json({
      tournament,
      matches: matches || [],
    });
  } catch (error) {
    console.error("GET /bracket error:", error);
    return res.status(500).json({
      error: "Failed to load bracket",
    });
  }
});

router.post("/admin/create-tournament", requireAdmin, async (req, res) => {
  try {
    const title = String(req.body.title || "").trim();
    const description = String(req.body.description || "").trim();
    const startsAt = req.body.starts_at || null;

    if (!title) {
      return res.status(400).json({
        error: "title is required",
      });
    }

    const slugBase = createSlug(title);
    const slug = `${slugBase}-${Date.now()}`;

    const { data, error } = await supabase
      .from("tournaments")
      .insert({
        title,
        slug,
        description,
        starts_at: startsAt,
        status: "open",
      })
      .select("*")
      .maybeSingle();

    if (error) throw error;

    return res.json({
      ok: true,
      tournament: data,
    });
  } catch (error) {
    console.error("POST /admin/create-tournament error:", error);
    return res.status(500).json({
      error: "Failed to create tournament",
    });
  }
});

router.post("/admin/generate-bracket", requireAdmin, async (req, res) => {
  try {
    const tournamentId = req.body.tournament_id;

    if (!tournamentId) {
      return res.status(400).json({
        error: "tournament_id is required",
      });
    }

    const tournament = await getTournamentById(tournamentId);

    if (!tournament) {
      return res.status(404).json({
        error: "Tournament not found",
      });
    }

    const { data: existingMatches, error: existingMatchesError } = await supabase
      .from("tournament_matches")
      .select("id")
      .eq("tournament_id", tournamentId)
      .limit(1);

    if (existingMatchesError) throw existingMatchesError;

    if (existingMatches && existingMatches.length > 0) {
      return res.status(400).json({
        error: "Bracket already generated for this tournament",
      });
    }

    const { data: registrations, error: registrationsError } = await supabase
      .from("tournament_registrations")
      .select(
        `
        *,
        profile:profiles!tournament_registrations_user_id_fkey (
          id,
          display_name,
          discord_name,
          steam_name,
          avatar_url
        )
      `
      )
      .eq("tournament_id", tournamentId)
      .eq("status", "registered")
      .order("created_at", { ascending: true });

    if (registrationsError) throw registrationsError;

    if (!registrations || registrations.length < 2) {
      return res.status(400).json({
        error: "At least 2 registered players are required",
      });
    }

    const players = registrations.map((entry, index) => ({
      user_id: entry.user_id,
      seed: index + 1,
    }));

    for (const player of players) {
      const { error: seedError } = await supabase
        .from("tournament_registrations")
        .update({
          seed: player.seed,
          updated_at: new Date().toISOString(),
        })
        .eq("tournament_id", tournamentId)
        .eq("user_id", player.user_id);

      if (seedError) throw seedError;
    }

    const size = nextPowerOfTwo(players.length);
    const paddedPlayers = [...players];

    while (paddedPlayers.length < size) {
      paddedPlayers.push(null);
    }

    const totalRounds = Math.log2(size);
    const insertedByRound = {};

    for (let round = 1; round <= totalRounds; round += 1) {
      const matchCount = size / 2 ** round;
      insertedByRound[round] = [];

      for (let matchNumber = 1; matchNumber <= matchCount; matchNumber += 1) {
        let player1Id = null;
        let player2Id = null;

        if (round === 1) {
          player1Id = paddedPlayers[(matchNumber - 1) * 2]?.user_id || null;
          player2Id = paddedPlayers[(matchNumber - 1) * 2 + 1]?.user_id || null;
        }

        const { data: insertedMatch, error: insertError } = await supabase
          .from("tournament_matches")
          .insert({
            tournament_id: tournamentId,
            round_number: round,
            match_number: matchNumber,
            player1_id: player1Id,
            player2_id: player2Id,
            winner_id: null,
            status:
              round === 1 && player1Id && player2Id
                ? "scheduled"
                : round === 1 && (player1Id || player2Id)
                ? "scheduled"
                : "pending",
          })
          .select("*")
          .maybeSingle();

        if (insertError) throw insertError;

        insertedByRound[round].push(insertedMatch);
      }
    }

    for (let round = 1; round < totalRounds; round += 1) {
      const currentRoundMatches = insertedByRound[round];
      const nextRoundMatches = insertedByRound[round + 1];

      for (let i = 0; i < currentRoundMatches.length; i += 1) {
        const currentMatch = currentRoundMatches[i];
        const nextMatch = nextRoundMatches[Math.floor(i / 2)];
        const nextMatchSlot = i % 2 === 0 ? 1 : 2;

        const { error: linkError } = await supabase
          .from("tournament_matches")
          .update({
            next_match_id: nextMatch.id,
            next_match_slot: nextMatchSlot,
            updated_at: new Date().toISOString(),
          })
          .eq("id", currentMatch.id);

        if (linkError) throw linkError;
      }
    }

    const firstRoundMatches = insertedByRound[1] || [];

    for (const match of firstRoundMatches) {
      await maybeAdvanceBye(match);
      await propagateWinner(match.id);
    }

    const { error: tournamentUpdateError } = await supabase
      .from("tournaments")
      .update({
        status: "in_progress",
        updated_at: new Date().toISOString(),
      })
      .eq("id", tournamentId);

    if (tournamentUpdateError) throw tournamentUpdateError;

    return res.json({
      ok: true,
      message: "Bracket generated successfully",
    });
  } catch (error) {
    console.error("POST /admin/generate-bracket error:", error);
    return res.status(500).json({
      error: "Failed to generate bracket",
    });
  }
});

router.post("/admin/report-result", requireAdmin, async (req, res) => {
  try {
    const { match_id: matchId, winner_id: winnerId } = req.body;

    if (!matchId || !winnerId) {
      return res.status(400).json({
        error: "match_id and winner_id are required",
      });
    }

    const { data: match, error: matchError } = await supabase
      .from("tournament_matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();

    if (matchError) throw matchError;

    if (!match) {
      return res.status(404).json({
        error: "Match not found",
      });
    }

    if (![match.player1_id, match.player2_id].includes(winnerId)) {
      return res.status(400).json({
        error: "winner_id must be player1_id or player2_id of the match",
      });
    }

    const { error: updateError } = await supabase
      .from("tournament_matches")
      .update({
        winner_id: winnerId,
        status: "completed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", matchId);

    if (updateError) throw updateError;

    await propagateWinner(matchId);

    const { data: finalMatch, error: finalMatchError } = await supabase
      .from("tournament_matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();

    if (finalMatchError) throw finalMatchError;

    const { data: tournamentMatches, error: tournamentMatchesError } = await supabase
      .from("tournament_matches")
      .select("*")
      .eq("tournament_id", match.tournament_id);

    if (tournamentMatchesError) throw tournamentMatchesError;

    const allCompleted = (tournamentMatches || []).every(
      (item) => item.status === "completed"
    );

    if (allCompleted) {
      const { error: tournamentEndError } = await supabase
        .from("tournaments")
        .update({
          status: "completed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", match.tournament_id);

      if (tournamentEndError) throw tournamentEndError;
    }

    return res.json({
      ok: true,
      match: finalMatch,
    });
  } catch (error) {
    console.error("POST /admin/report-result error:", error);
    return res.status(500).json({
      error: "Failed to report result",
    });
  }
});

module.exports = router;