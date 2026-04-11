const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const router = express.Router();

const supabaseUrl =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const tournamentAdminKey = process.env.TOURNAMENT_ADMIN_KEY;
const adminEmailSet = new Set(
  (process.env.TOURNAMENT_ADMIN_EMAILS || process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => String(email || "").trim().toLowerCase())
    .filter(Boolean)
);

const TOURNAMENT_FORMATS = new Set([
  "single_elimination",
  "double_elimination",
  "round_robin",
  "swiss",
  "groups_playoff",
  "league_season",
  "ladder",
  "king_of_the_hill",
  "gsl_group",
]);
const PARTICIPANT_MODES = new Set(["1v1", "2v2", "team", "solo_with_subs"]);
const SIGNUP_MODES = new Set([
  "public",
  "approval",
  "invite_only",
  "manual_roster",
  "hybrid",
]);
const VISIBILITY_MODES = new Set(["public", "members_only", "hidden"]);
const SEEDING_MODES = new Set([
  "random",
  "manual",
  "ranking_based",
  "previous_season",
  "protected",
]);
const SCHEDULING_MODES = new Set(["free", "deadline", "fixed_slots"]);
const TIE_BREAKERS = new Set([
  "head_to_head",
  "map_difference",
  "point_difference",
  "buchholz",
  "playoff",
  "initial_seed",
]);
const RESULT_CONFIRMATION_MODES = new Set([
  "dual_confirmation",
  "auto_on_same_report",
  "admin_only",
]);
const TOURNAMENT_STATUSES = new Set([
  "draft",
  "registration_open",
  "check_in",
  "seeding",
  "live",
  "paused",
  "completed",
  "cancelled",
]);
const MATCH_EDITABLE_STATUSES = new Set([
  "ready",
  "awaiting_confirmation",
  "disputed",
  "admin_review",
]);

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

function normalizeEmail(value) {
  const email = String(value || "")
    .trim()
    .toLowerCase();

  return email || null;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function trimText(value, maxLength = 255) {
  return String(value || "").trim().slice(0, maxLength);
}

function optionalText(value, maxLength = 255) {
  const text = trimText(value, maxLength);
  return text || null;
}

function parseBooleanFlag(value) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  return normalized === "true" || normalized === "1" || normalized === "on";
}

function parseInteger(value, { name, min, max, fallback = null }) {
  if (value == null || value === "") {
    if (fallback != null) {
      return fallback;
    }

    throw new Error(`${name} is required`);
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`);
  }

  if (parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }

  return parsed;
}

function parseOddInteger(value, { name, min, max, fallback = null }) {
  const parsed = parseInteger(value, { name, min, max, fallback });

  if (parsed % 2 === 0) {
    throw new Error(`${name} must be an odd number`);
  }

  return parsed;
}

function parseEnum(value, allowedValues, { name, fallback = null }) {
  const normalized = trimText(value, 100);

  if (!normalized) {
    if (fallback != null) {
      return fallback;
    }

    throw new Error(`${name} is required`);
  }

  if (!allowedValues.has(normalized)) {
    throw new Error(`Invalid ${name}`);
  }

  return normalized;
}

function parseIsoDateOrNull(value, name) {
  const normalized = optionalText(value, 100);

  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} must be a valid datetime`);
  }

  return parsed.toISOString();
}

function getAuthUserValidationError(user) {
  const email = normalizeEmail(user?.email);

  if (!email) {
    return "Authenticated user must have a valid email";
  }

  if (!user?.email_confirmed_at) {
    return "Email verification required";
  }

  return null;
}

function isAdminUser(user) {
  const email = normalizeEmail(user?.email);
  return Boolean(email && adminEmailSet.has(email));
}

function getAuthToken(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim();
}

async function getOptionalAuthUser(req) {
  const token = getAuthToken(req);

  if (!token) {
    return null;
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return null;
  }

  req.user = data.user;
  return data.user;
}

async function requireUser(req, res, next) {
  try {
    const user = await getOptionalAuthUser(req);

    if (!user) {
      return res.status(401).json({ error: "Missing or invalid bearer token" });
    }

    const validationError = getAuthUserValidationError(user);

    if (validationError) {
      return res.status(403).json({ error: validationError });
    }

    await ensureProfile(user);
    next();
  } catch (error) {
    console.error("requireUser error:", error);
    return res.status(500).json({ error: "Authentication check failed" });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const adminKey = req.headers["x-admin-key"];

    if (!tournamentAdminKey || adminKey !== tournamentAdminKey) {
      return res.status(403).json({ error: "Unauthorized admin request" });
    }

    if (!adminEmailSet.size) {
      return res.status(500).json({ error: "Admin email list is not configured" });
    }

    const user = await getOptionalAuthUser(req);

    if (!user) {
      return res.status(401).json({ error: "Missing or invalid bearer token" });
    }

    const validationError = getAuthUserValidationError(user);

    if (validationError) {
      return res.status(403).json({ error: validationError });
    }

    if (!isAdminUser(user)) {
      return res.status(403).json({ error: "Authenticated user is not an admin" });
    }

    await ensureProfile(user);

    next();
  } catch (error) {
    console.error("requireAdmin error:", error);
    return res.status(500).json({ error: "Admin authentication failed" });
  }
}

function normalizeTournamentStatus(status) {
  if (status === "open") return "registration_open";
  if (status === "in_progress") return "live";
  return status || "draft";
}

function normalizeMatchStatus(status) {
  if (status === "scheduled") return "ready";
  return status || "pending";
}

function normalizeTournament(tournament) {
  if (!tournament) return null;

  return {
    ...tournament,
    status: normalizeTournamentStatus(tournament.status),
  };
}

function normalizeMatch(match) {
  if (!match) return null;

  return {
    ...match,
    status: normalizeMatchStatus(match.status),
  };
}

function nextPowerOfTwo(n) {
  if (n <= 1) return 1;
  return 2 ** Math.ceil(Math.log2(n));
}

function buildSeedOrder(size) {
  if (size === 1) {
    return [1];
  }

  const previous = buildSeedOrder(size / 2);
  const order = [];

  for (const seed of previous) {
    order.push(seed);
    order.push(size + 1 - seed);
  }

  return order;
}

function shuffle(items) {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }

  return result;
}

function createSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

function parseManualRoster(rawValue) {
  return String(rawValue || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const match = line.match(/^(.*?)\s*<([^>]+)>$/);
      return {
        displayName: match?.[1]?.trim() || line.replace(/<[^>]+>/g, "").trim(),
        email: match?.[2]?.trim().toLowerCase() || null,
        seed: index + 1,
      };
    });
}

function winsNeeded(bestOf) {
  return Math.floor(bestOf / 2) + 1;
}

function validateReportedScore(bestOf, player1Wins, player2Wins) {
  const requiredWins = winsNeeded(bestOf);

  if (player1Wins < 0 || player2Wins < 0) {
    throw new Error("Scores cannot be negative");
  }

  if (player1Wins === player2Wins) {
    throw new Error("A match must have a winner");
  }

  if (player1Wins !== requiredWins && player2Wins !== requiredWins) {
    throw new Error(`For BO${bestOf}, one player must reach ${requiredWins} wins`);
  }
}

async function ensureProfile(user) {
  const email = normalizeEmail(user.email);
  const displayName =
    user.user_metadata?.full_name ||
    user.user_metadata?.name ||
    user.user_metadata?.user_name ||
    (email ? email.split("@")[0] : "Player");

  const payload = {
    id: user.id,
    email,
    display_name: displayName,
    discord_name:
      user.user_metadata?.discord_name ||
      user.user_metadata?.preferred_username ||
      null,
    steam_name: user.user_metadata?.steam_name || null,
    avatar_url: user.user_metadata?.avatar_url || null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("profiles").upsert(payload);

  if (error) throw error;

  return payload;
}

async function getProfileByEmail(email) {
  if (!email) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("email", email.toLowerCase())
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function createManualProfile({ displayName, email }) {
  if (email && !isValidEmail(email)) {
    throw new Error("Manual participant email is not valid");
  }

  const { data, error } = await supabase
    .from("profiles")
    .insert({
      display_name: displayName,
      email: normalizeEmail(email),
      updated_at: new Date().toISOString(),
    })
    .select("*")
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function findOrCreateParticipantProfile({ displayName, email }) {
  const existing = await getProfileByEmail(email);

  if (existing) {
    return existing;
  }

  return createManualProfile({ displayName, email });
}

async function getTournamentById(id) {
  const { data, error } = await supabase
    .from("tournaments")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return normalizeTournament(data || null);
}

async function getTournamentBySlug(slug) {
  const { data, error } = await supabase
    .from("tournaments")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();

  if (error) throw error;
  return normalizeTournament(data || null);
}

async function getLatestTournament() {
  const { data, error } = await supabase
    .from("tournaments")
    .select("*")
    .in("status", ["registration_open", "live", "open", "in_progress"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return normalizeTournament(data || null);
}

async function getRegistration(tournamentId, userId) {
  const { data, error } = await supabase
    .from("tournament_registrations")
    .select(
      `
      *,
      profile:profiles!tournament_registrations_user_id_fkey (
        id, email, display_name, discord_name, steam_name, avatar_url
      )
    `
    )
    .eq("tournament_id", tournamentId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function loadParticipants(tournamentId) {
  const { data, error } = await supabase
    .from("tournament_registrations")
    .select(
      `
      *,
      profile:profiles!tournament_registrations_user_id_fkey (
        id, email, display_name, discord_name, steam_name, avatar_url
      )
    `
    )
    .eq("tournament_id", tournamentId)
    .in("status", ["registered", "pending"])
    .order("seed", { ascending: true, nullsFirst: false })
    .order("requested_at", { ascending: true });

  if (error) throw error;
  return data || [];
}

async function loadMatches(tournamentId) {
  const { data, error } = await supabase
    .from("tournament_matches")
    .select(
      `
      *,
      player1:profiles!tournament_matches_player1_id_fkey (
        id, email, display_name, discord_name, steam_name, avatar_url
      ),
      player2:profiles!tournament_matches_player2_id_fkey (
        id, email, display_name, discord_name, steam_name, avatar_url
      ),
      winner:profiles!tournament_matches_winner_id_fkey (
        id, email, display_name, discord_name, steam_name, avatar_url
      ),
      pending_winner:profiles!tournament_matches_pending_winner_id_fkey (
        id, email, display_name, discord_name, steam_name, avatar_url
      )
    `
    )
    .eq("tournament_id", tournamentId)
    .order("round_number", { ascending: true })
    .order("match_number", { ascending: true });

  if (error) throw error;
  return (data || []).map(normalizeMatch);
}

async function getUserNextMatch(tournamentId, userId) {
  const matches = await loadMatches(tournamentId);

  return (
    matches.find((match) => {
      const isParticipant = match.player1_id === userId || match.player2_id === userId;
      const isOpen = !["completed", "forfeited", "cancelled"].includes(match.status);
      return isParticipant && isOpen;
    }) || null
  );
}

async function getRegistrationCount(tournamentId, statuses) {
  const { count, error } = await supabase
    .from("tournament_registrations")
    .select("*", { head: true, count: "exact" })
    .eq("tournament_id", tournamentId)
    .in("status", statuses);

  if (error) throw error;
  return count || 0;
}

async function getMatchCount(tournamentId) {
  const { count, error } = await supabase
    .from("tournament_matches")
    .select("*", { head: true, count: "exact" })
    .eq("tournament_id", tournamentId);

  if (error) throw error;
  return count || 0;
}

async function enrichTournament(tournament, userId) {
  const [participantCount, pendingRegistrations, matchCount, myRegistration] =
    await Promise.all([
      getRegistrationCount(tournament.id, ["registered"]),
      getRegistrationCount(tournament.id, ["pending"]),
      getMatchCount(tournament.id),
      userId ? getRegistration(tournament.id, userId) : Promise.resolve(null),
    ]);

  return {
    ...tournament,
    participant_count: participantCount,
    pending_registrations: pendingRegistrations,
    match_count: matchCount,
    my_registration_status: myRegistration?.status || null,
    my_registration_source: myRegistration?.source || null,
    my_registration_seed: myRegistration?.seed ?? null,
  };
}

async function getPendingRegistrationEntries(tournamentId) {
  const { data, error } = await supabase
    .from("tournament_registrations")
    .select(
      `
      *,
      profile:profiles!tournament_registrations_user_id_fkey (
        id, email, display_name, discord_name, steam_name, avatar_url
      )
    `
    )
    .eq("tournament_id", tournamentId)
    .eq("status", "pending")
    .order("requested_at", { ascending: true });

  if (error) throw error;
  return data || [];
}

async function fetchTournamentDetailsPayload(tournament, userId) {
  if (!tournament) {
    return {
      tournament: null,
      matches: [],
      participants: [],
      myRegistration: null,
      nextMatch: null,
    };
  }

  const [participants, matches, myRegistration, nextMatch, enrichedTournament] =
    await Promise.all([
      loadParticipants(tournament.id),
      loadMatches(tournament.id),
      userId ? getRegistration(tournament.id, userId) : Promise.resolve(null),
      userId ? getUserNextMatch(tournament.id, userId) : Promise.resolve(null),
      enrichTournament(tournament, userId),
    ]);

  return {
    tournament: enrichedTournament,
    matches,
    participants,
    myRegistration,
    nextMatch,
  };
}

function resolveBracketOrdering(registrations, seedingMode) {
  const registered = registrations
    .filter((entry) => entry.status === "registered")
    .map((entry, index) => ({
      ...entry,
      _orderSeed:
        typeof entry.seed === "number"
          ? entry.seed
          : seedingMode === "random"
            ? index + 1
            : registrations.length + index + 1,
    }));

  const sorted =
    seedingMode === "random"
      ? shuffle(registered)
      : [...registered].sort((left, right) => left._orderSeed - right._orderSeed);

  const bracketSize = nextPowerOfTwo(sorted.length);
  const seedOrder = buildSeedOrder(bracketSize);
  const bySeed = [...sorted];

  return {
    orderedSlots: seedOrder.map((seed) => bySeed[seed - 1] || null),
    sortedParticipants: sorted,
    bracketSize,
  };
}

async function updateTournamentCompletionStatus(tournamentId) {
  const { data, error } = await supabase
    .from("tournament_matches")
    .select("status")
    .eq("tournament_id", tournamentId);

  if (error) throw error;

  const allCompleted = (data || []).every((match) =>
    ["completed", "forfeited", "cancelled"].includes(normalizeMatchStatus(match.status))
  );

  if (!allCompleted) {
    return;
  }

  const { error: updateError } = await supabase
    .from("tournaments")
    .update({
      status: "completed",
      updated_at: new Date().toISOString(),
    })
    .eq("id", tournamentId);

  if (updateError) throw updateError;
}

async function setNextMatchReadyIfNeeded(matchId) {
  const { data: match, error } = await supabase
    .from("tournament_matches")
    .select("*")
    .eq("id", matchId)
    .maybeSingle();

  if (error) throw error;
  if (!match) return;

  const nextStatus = match.player1_id && match.player2_id ? "ready" : "pending";

  const { error: updateError } = await supabase
    .from("tournament_matches")
    .update({
      status: nextStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", matchId);

  if (updateError) throw updateError;
}

async function maybeAdvanceBye(match) {
  const player1Id = match.player1_id;
  const player2Id = match.player2_id;

  if ((player1Id && player2Id) || (!player1Id && !player2Id) || match.winner_id) {
    return;
  }

  const autoWinnerId = player1Id || player2Id;

  const { error } = await supabase
    .from("tournament_matches")
    .update({
      winner_id: autoWinnerId,
      pending_winner_id: null,
      status: "completed",
      resolution_type: "bye",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", match.id);

  if (error) throw error;

  await propagateWinner(match.id);
}

async function propagateWinner(matchId) {
  const { data: match, error: matchError } = await supabase
    .from("tournament_matches")
    .select("*")
    .eq("id", matchId)
    .maybeSingle();

  if (matchError) throw matchError;
  if (!match || !match.winner_id || !match.next_match_id) return;

  const { data: nextMatch, error: nextError } = await supabase
    .from("tournament_matches")
    .select("*")
    .eq("id", match.next_match_id)
    .maybeSingle();

  if (nextError) throw nextError;
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

  if (
    !Object.prototype.hasOwnProperty.call(updatePayload, "player1_id") &&
    !Object.prototype.hasOwnProperty.call(updatePayload, "player2_id")
  ) {
    return;
  }

  const { error: updateError } = await supabase
    .from("tournament_matches")
    .update(updatePayload)
    .eq("id", nextMatch.id);

  if (updateError) throw updateError;

  await setNextMatchReadyIfNeeded(nextMatch.id);

  const { data: refreshed, error: refreshedError } = await supabase
    .from("tournament_matches")
    .select("*")
    .eq("id", nextMatch.id)
    .maybeSingle();

  if (refreshedError) throw refreshedError;
  if (!refreshed) return;

  await maybeAdvanceBye(refreshed);
}

async function finalizeMatch({
  match,
  winnerId,
  player1Wins,
  player2Wins,
  resolutionType,
  adminNotes = null,
}) {
  const status = resolutionType === "forfeit" ? "forfeited" : "completed";

  const { error } = await supabase
    .from("tournament_matches")
    .update({
      winner_id: winnerId,
      pending_winner_id: null,
      status,
      player1_wins: player1Wins,
      player2_wins: player2Wins,
      admin_notes: adminNotes,
      dispute_reason: null,
      resolution_type: resolutionType,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", match.id);

  if (error) throw error;

  await propagateWinner(match.id);
  await updateTournamentCompletionStatus(match.tournament_id);
}

async function generateSingleEliminationBracket(tournament) {
  const { data: existingMatches, error: existingError } = await supabase
    .from("tournament_matches")
    .select("id")
    .eq("tournament_id", tournament.id)
    .limit(1);

  if (existingError) throw existingError;

  if (existingMatches && existingMatches.length > 0) {
    throw new Error("Bracket already generated for this tournament");
  }

  const registrations = await loadParticipants(tournament.id);
  const registered = registrations.filter((entry) => entry.status === "registered");

  if (registered.length < Math.max(2, tournament.min_participants || 2)) {
    throw new Error("At least 2 registered players are required");
  }

  const { orderedSlots, sortedParticipants, bracketSize } = resolveBracketOrdering(
    registrations,
    tournament.seeding_mode
  );

  for (let index = 0; index < sortedParticipants.length; index += 1) {
    const participant = sortedParticipants[index];
    const nextSeed = participant.seed || index + 1;

    const { error: seedError } = await supabase
      .from("tournament_registrations")
      .update({
        seed: nextSeed,
        updated_at: new Date().toISOString(),
      })
      .eq("id", participant.id);

    if (seedError) throw seedError;
  }

  const totalRounds = Math.log2(bracketSize);
  const insertedByRound = {};

  for (let round = 1; round <= totalRounds; round += 1) {
    const matchCount = bracketSize / 2 ** round;
    insertedByRound[round] = [];

    for (let matchNumber = 1; matchNumber <= matchCount; matchNumber += 1) {
      let player1Id = null;
      let player2Id = null;

      if (round === 1) {
        player1Id = orderedSlots[(matchNumber - 1) * 2]?.user_id || null;
        player2Id = orderedSlots[(matchNumber - 1) * 2 + 1]?.user_id || null;
      }

      const status = player1Id && player2Id ? "ready" : "pending";

      const { data: insertedMatch, error: insertError } = await supabase
        .from("tournament_matches")
        .insert({
          tournament_id: tournament.id,
          round_number: round,
          match_number: matchNumber,
          player1_id: player1Id,
          player2_id: player2Id,
          status,
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

    for (let index = 0; index < currentRoundMatches.length; index += 1) {
      const currentMatch = currentRoundMatches[index];
      const nextMatch = nextRoundMatches[Math.floor(index / 2)];
      const nextMatchSlot = index % 2 === 0 ? 1 : 2;

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

  for (const firstRoundMatch of insertedByRound[1] || []) {
    await maybeAdvanceBye(firstRoundMatch);
  }

  const { error: updateTournamentError } = await supabase
    .from("tournaments")
    .update({
      status: "live",
      bracket_generated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", tournament.id);

  if (updateTournamentError) throw updateTournamentError;
}

async function loadAdminTournaments(userId) {
  const { data, error } = await supabase
    .from("tournaments")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw error;

  const tournaments = data || [];

  return Promise.all(
    tournaments.map(async (tournament) => {
      const enriched = await enrichTournament(normalizeTournament(tournament), userId);
      const pendingEntries = await getPendingRegistrationEntries(tournament.id);

      return {
        ...enriched,
        pending_registration_entries: pendingEntries,
      };
    })
  );
}

router.get("/health", (_req, res) => {
  return res.json({
    ok: true,
    scope: "tournament",
  });
});

router.get("/active", async (_req, res) => {
  try {
    const tournament = await getLatestTournament();
    return res.json({ tournament });
  } catch (error) {
    console.error("GET /active error:", error);
    return res.status(500).json({ error: "Failed to load active tournament" });
  }
});

router.get("/list", async (req, res) => {
  try {
    const user = await getOptionalAuthUser(req);

    const { data, error } = await supabase
      .from("tournaments")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    const tournaments = await Promise.all(
      (data || []).map((tournament) =>
        enrichTournament(normalizeTournament(tournament), user?.id || null)
      )
    );

    return res.json({ tournaments });
  } catch (error) {
    console.error("GET /list error:", error);
    return res.status(500).json({ error: "Failed to load tournaments" });
  }
});

router.get("/bracket", async (_req, res) => {
  try {
    const tournament = await getLatestTournament();
    const payload = await fetchTournamentDetailsPayload(tournament, null);
    return res.json(payload);
  } catch (error) {
    console.error("GET /bracket error:", error);
    return res.status(500).json({ error: "Failed to load bracket" });
  }
});

router.get("/bracket/by-slug/:slug", async (req, res) => {
  try {
    const tournament = await getTournamentBySlug(req.params.slug);
    const payload = await fetchTournamentDetailsPayload(tournament, null);
    return res.json(payload);
  } catch (error) {
    console.error("GET /bracket/by-slug/:slug error:", error);
    return res.status(500).json({ error: "Failed to load bracket" });
  }
});

router.get("/details/by-slug/:slug", async (req, res) => {
  try {
    const user = await getOptionalAuthUser(req);
    const tournament = await getTournamentBySlug(req.params.slug);
    const payload = await fetchTournamentDetailsPayload(tournament, user?.id || null);
    return res.json(payload);
  } catch (error) {
    console.error("GET /details/by-slug/:slug error:", error);
    return res.status(500).json({ error: "Failed to load tournament details" });
  }
});

router.get("/me", requireUser, async (req, res) => {
  try {
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
    return res.status(500).json({ error: "Failed to load profile" });
  }
});

router.post("/complete-profile", requireUser, async (req, res) => {
  try {
    const discordName = trimText(req.body.discord_name, 120);
    const steamName = trimText(req.body.steam_name, 120);
    const displayName = trimText(req.body.display_name, 120);
    const updatePayload = {
      updated_at: new Date().toISOString(),
    };

    if (discordName) updatePayload.discord_name = discordName;
    if (steamName) updatePayload.steam_name = steamName;
    if (displayName) updatePayload.display_name = displayName;

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
    return res.status(500).json({ error: "Failed to update profile" });
  }
});

router.post("/register", requireUser, async (req, res) => {
  try {
    const tournamentId = optionalText(req.body.tournament_id, 120);
    const slug = optionalText(req.body.slug, 180);

    if (!tournamentId && !slug) {
      return res.status(400).json({ error: "tournament_id or slug is required" });
    }

    const tournament = tournamentId
      ? await getTournamentById(tournamentId)
      : await getTournamentBySlug(slug);

    if (!tournament) {
      return res.status(404).json({ error: "Tournament not found" });
    }

    if (tournament.status !== "registration_open") {
      return res.status(400).json({ error: "Tournament registration is closed" });
    }

    if (["invite_only", "manual_roster"].includes(tournament.signup_mode)) {
      return res.status(400).json({ error: "This tournament is not open for direct signup" });
    }

    const existing = await getRegistration(tournament.id, req.user.id);

    if (existing) {
      return res.json({
        ok: true,
        alreadyRegistered: true,
        registration: existing,
      });
    }

    const { count, error: countError } = await supabase
      .from("tournament_registrations")
      .select("*", { head: true, count: "exact" })
      .eq("tournament_id", tournament.id)
      .in("status", ["registered", "pending"]);

    if (countError) throw countError;

    if ((count || 0) >= tournament.max_participants) {
      return res.status(400).json({ error: "Tournament is full" });
    }

    const status = tournament.signup_mode === "approval" ? "pending" : "registered";

    const { data, error } = await supabase
      .from("tournament_registrations")
      .insert({
        tournament_id: tournament.id,
        user_id: req.user.id,
        seed: null,
        status,
        source: "signup",
        requested_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select(
        `
        *,
        profile:profiles!tournament_registrations_user_id_fkey (
          id, email, display_name, discord_name, steam_name, avatar_url
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
    return res.status(500).json({ error: "Failed to register to tournament" });
  }
});

router.get("/my-registration", requireUser, async (req, res) => {
  try {
    const tournament = await getLatestTournament();

    if (!tournament) {
      return res.json({
        tournament: null,
        registration: null,
        nextMatch: null,
      });
    }

    const registration = await getRegistration(tournament.id, req.user.id);
    const nextMatch = await getUserNextMatch(tournament.id, req.user.id);

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

router.get("/my-tournaments", requireUser, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("tournament_registrations")
      .select(
        `
        *,
        tournament:tournaments (*),
        profile:profiles!tournament_registrations_user_id_fkey (
          id, email, display_name, discord_name, steam_name, avatar_url
        )
      `
      )
      .eq("user_id", req.user.id)
      .in("status", ["registered", "pending"])
      .order("requested_at", { ascending: false });

    if (error) throw error;

    const tournaments = await Promise.all(
      (data || []).map(async (entry) => {
        const tournament = await enrichTournament(
          normalizeTournament(entry.tournament),
          req.user.id
        );
        const nextMatch = await getUserNextMatch(tournament.id, req.user.id);

        return {
          tournament,
          registration: {
            ...entry,
            tournament: undefined,
          },
          nextMatch,
        };
      })
    );

    return res.json({ tournaments });
  } catch (error) {
    console.error("GET /my-tournaments error:", error);
    return res.status(500).json({ error: "Failed to load user tournaments" });
  }
});

router.post("/submit-result", requireUser, async (req, res) => {
  try {
    const matchId = optionalText(req.body.match_id, 120);
    const player1Wins = parseInteger(req.body.player1_wins, {
      name: "player1_wins",
      min: 0,
      max: 20,
    });
    const player2Wins = parseInteger(req.body.player2_wins, {
      name: "player2_wins",
      min: 0,
      max: 20,
    });
    const evidenceNote = optionalText(req.body.evidence_note, 500);

    if (!matchId) {
      return res.status(400).json({ error: "match_id is required" });
    }

    const { data: match, error: matchError } = await supabase
      .from("tournament_matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();

    if (matchError) throw matchError;
    if (!match) return res.status(404).json({ error: "Match not found" });
    if (![match.player1_id, match.player2_id].includes(req.user.id)) {
      return res.status(403).json({ error: "You are not part of this match" });
    }
    if (!MATCH_EDITABLE_STATUSES.has(normalizeMatchStatus(match.status))) {
      return res.status(400).json({ error: "Match result can no longer be edited" });
    }

    const tournament = await getTournamentById(match.tournament_id);

    if (!tournament) {
      return res.status(404).json({ error: "Tournament not found" });
    }

    validateReportedScore(tournament.best_of || 3, player1Wins, player2Wins);

    const winnerId = player1Wins > player2Wins ? match.player1_id : match.player2_id;
    const nextStatus =
      tournament.result_confirmation_mode === "admin_only"
        ? "admin_review"
        : "awaiting_confirmation";

    const { error: updateError } = await supabase
      .from("tournament_matches")
      .update({
        player1_wins: player1Wins,
        player2_wins: player2Wins,
        pending_winner_id: winnerId,
        reported_by_id: req.user.id,
        confirmed_by_id: null,
        report_evidence: evidenceNote,
        dispute_reason: null,
        status: nextStatus,
        reported_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", match.id);

    if (updateError) throw updateError;

    return res.json({ ok: true });
  } catch (error) {
    console.error("POST /submit-result error:", error);
    return res.status(500).json({ error: error.message || "Failed to submit result" });
  }
});

router.post("/confirm-result", requireUser, async (req, res) => {
  try {
    const matchId = optionalText(req.body.match_id, 120);

    if (!matchId) {
      return res.status(400).json({ error: "match_id is required" });
    }

    const { data: match, error: matchError } = await supabase
      .from("tournament_matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();

    if (matchError) throw matchError;
    if (!match) return res.status(404).json({ error: "Match not found" });
    if (![match.player1_id, match.player2_id].includes(req.user.id)) {
      return res.status(403).json({ error: "You are not part of this match" });
    }
    if (match.reported_by_id === req.user.id) {
      return res.status(400).json({ error: "Reporter cannot confirm their own result" });
    }
    if (normalizeMatchStatus(match.status) !== "awaiting_confirmation") {
      return res.status(400).json({ error: "Match is not awaiting confirmation" });
    }
    if (!match.pending_winner_id) {
      return res.status(400).json({ error: "No pending result to confirm" });
    }

    const { error: updateError } = await supabase
      .from("tournament_matches")
      .update({
        confirmed_by_id: req.user.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", match.id);

    if (updateError) throw updateError;

    await finalizeMatch({
      match,
      winnerId: match.pending_winner_id,
      player1Wins: match.player1_wins,
      player2Wins: match.player2_wins,
      resolutionType: "played",
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error("POST /confirm-result error:", error);
    return res.status(500).json({ error: error.message || "Failed to confirm result" });
  }
});

router.post("/dispute-result", requireUser, async (req, res) => {
  try {
    const matchId = optionalText(req.body.match_id, 120);
    const disputeReason = req.body.dispute_reason
      ? trimText(req.body.dispute_reason, 500)
      : "Contestazione aperta dal giocatore.";

    if (!matchId) {
      return res.status(400).json({ error: "match_id is required" });
    }

    const { data: match, error: matchError } = await supabase
      .from("tournament_matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();

    if (matchError) throw matchError;
    if (!match) return res.status(404).json({ error: "Match not found" });
    if (![match.player1_id, match.player2_id].includes(req.user.id)) {
      return res.status(403).json({ error: "You are not part of this match" });
    }
    if (!["awaiting_confirmation", "admin_review", "disputed"].includes(normalizeMatchStatus(match.status))) {
      return res.status(400).json({ error: "This match cannot be disputed right now" });
    }

    const { error: updateError } = await supabase
      .from("tournament_matches")
      .update({
        status: "disputed",
        dispute_reason: disputeReason,
        updated_at: new Date().toISOString(),
      })
      .eq("id", match.id);

    if (updateError) throw updateError;

    return res.json({ ok: true });
  } catch (error) {
    console.error("POST /dispute-result error:", error);
    return res.status(500).json({ error: error.message || "Failed to open dispute" });
  }
});

router.get("/admin/tournaments", requireAdmin, async (req, res) => {
  try {
    const tournaments = await loadAdminTournaments(req.user?.id || null);
    return res.json({ tournaments });
  } catch (error) {
    console.error("GET /admin/tournaments error:", error);
    return res.status(500).json({ error: "Failed to load admin tournaments" });
  }
});

router.post("/admin/create-tournament", requireAdmin, async (req, res) => {
  try {
    const title = trimText(req.body.title, 120);

    if (!title) {
      return res.status(400).json({ error: "title is required" });
    }

    const format = parseEnum(req.body.format, TOURNAMENT_FORMATS, {
      name: "format",
      fallback: "single_elimination",
    });
    const participantMode = parseEnum(req.body.participant_mode, PARTICIPANT_MODES, {
      name: "participant_mode",
      fallback: "1v1",
    });
    const signupMode = parseEnum(req.body.signup_mode, SIGNUP_MODES, {
      name: "signup_mode",
      fallback: "public",
    });
    const visibility = parseEnum(req.body.visibility, VISIBILITY_MODES, {
      name: "visibility",
      fallback: "public",
    });
    const seedingMode = parseEnum(req.body.seeding_mode, SEEDING_MODES, {
      name: "seeding_mode",
      fallback: "manual",
    });
    const schedulingMode = parseEnum(req.body.scheduling_mode, SCHEDULING_MODES, {
      name: "scheduling_mode",
      fallback: "deadline",
    });
    const tieBreaker = parseEnum(req.body.tie_breaker, TIE_BREAKERS, {
      name: "tie_breaker",
      fallback: "head_to_head",
    });
    const resultConfirmationMode = parseEnum(
      req.body.result_confirmation_mode,
      RESULT_CONFIRMATION_MODES,
      {
        name: "result_confirmation_mode",
        fallback: "dual_confirmation",
      }
    );
    const bestOf = parseOddInteger(req.body.best_of, {
      name: "best_of",
      min: 1,
      max: 15,
      fallback: 3,
    });
    const minParticipants = parseInteger(req.body.min_participants, {
      name: "min_participants",
      min: 2,
      max: 512,
      fallback: 2,
    });
    const maxParticipants = parseInteger(req.body.max_participants, {
      name: "max_participants",
      min: 2,
      max: 512,
      fallback: 8,
    });
    const description = trimText(req.body.description, 2000);
    const mapRules = trimText(req.body.map_rules, 2000);
    const prizeSummary = trimText(req.body.prize_summary, 300);
    const notes = trimText(req.body.notes, 3000);
    const registrationOpensAt = parseIsoDateOrNull(
      req.body.registration_opens_at,
      "registration_opens_at"
    );
    const registrationClosesAt = parseIsoDateOrNull(
      req.body.registration_closes_at,
      "registration_closes_at"
    );
    const startsAt = parseIsoDateOrNull(req.body.starts_at, "starts_at");
    const requiresCheckIn = parseBooleanFlag(req.body.requires_check_in);
    const requiresEvidence = parseBooleanFlag(req.body.requires_evidence);
    const autoGenerateBracket = parseBooleanFlag(req.body.auto_generate_bracket);
    const manualRoster = trimText(req.body.manual_roster, 12000);

    if (maxParticipants < minParticipants) {
      return res.status(400).json({
        error: "max_participants must be greater than or equal to min_participants",
      });
    }

    const slugBase = createSlug(req.body.slug || title);
    const slug = slugBase || `tournament-${Date.now()}`;
    const { data: existingTournament, error: existingError } = await supabase
      .from("tournaments")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();

    if (existingError) throw existingError;

    const finalSlug = existingTournament ? `${slug}-${Date.now()}` : slug;
    const status = signupMode === "manual_roster" ? "draft" : "registration_open";

    const { data: insertedTournament, error: insertError } = await supabase
      .from("tournaments")
      .insert({
        title,
        slug: finalSlug,
        description,
        status,
        format,
        participant_mode: participantMode,
        signup_mode: signupMode,
        visibility,
        seeding_mode: seedingMode,
        best_of: bestOf,
        requires_check_in: requiresCheckIn,
        scheduling_mode: schedulingMode,
        tie_breaker: tieBreaker,
        map_rules: mapRules,
        prize_summary: prizeSummary,
        notes,
        result_confirmation_mode: resultConfirmationMode,
        evidence_mode: requiresEvidence ? "required" : "optional",
        max_participants: maxParticipants,
        min_participants: minParticipants,
        starts_at: startsAt,
        registration_opens_at: registrationOpensAt,
        registration_closes_at: registrationClosesAt,
        created_by_profile_id: req.user?.id || null,
        updated_at: new Date().toISOString(),
      })
      .select("*")
      .maybeSingle();

    if (insertError) throw insertError;

    for (const participant of parseManualRoster(manualRoster)) {
      const profile = await findOrCreateParticipantProfile(participant);
      const { error: registrationError } = await supabase
        .from("tournament_registrations")
        .upsert({
          tournament_id: insertedTournament.id,
          user_id: profile.id,
          seed: seedingMode === "random" ? null : participant.seed,
          status: "registered",
          source: "manual",
          requested_at: new Date().toISOString(),
          approved_at: new Date().toISOString(),
          approved_by_profile_id: req.user?.id || null,
          updated_at: new Date().toISOString(),
        });

      if (registrationError) throw registrationError;
    }

    const normalizedTournament = normalizeTournament(insertedTournament);

    if (
      autoGenerateBracket &&
      normalizedTournament.format === "single_elimination" &&
      normalizedTournament.participant_mode === "1v1"
    ) {
      await generateSingleEliminationBracket(normalizedTournament);
    }

    return res.json({
      ok: true,
      tournament: normalizeTournament(insertedTournament),
    });
  } catch (error) {
    console.error("POST /admin/create-tournament error:", error);
    return res.status(500).json({ error: error.message || "Failed to create tournament" });
  }
});

router.post("/admin/add-participant", requireAdmin, async (req, res) => {
  try {
    const tournamentId = optionalText(req.body.tournament_id, 120);
    const displayName = trimText(req.body.display_name, 120);
    const email = normalizeEmail(req.body.email);

    if (!tournamentId || !displayName) {
      return res.status(400).json({ error: "tournament_id and display_name are required" });
    }

    if (email && !isValidEmail(email)) {
      return res.status(400).json({ error: "Participant email is not valid" });
    }

    const tournament = await getTournamentById(tournamentId);
    if (!tournament) return res.status(404).json({ error: "Tournament not found" });

    const participantCount = await getRegistrationCount(tournament.id, ["registered", "pending"]);

    if (participantCount >= tournament.max_participants) {
      return res.status(400).json({ error: "Tournament is full" });
    }

    const profile = await findOrCreateParticipantProfile({ displayName, email });
    const existing = await getRegistration(tournament.id, profile.id);
    if (existing) return res.json({ ok: true, registration: existing });

    const { data, error } = await supabase
      .from("tournament_registrations")
      .insert({
        tournament_id: tournament.id,
        user_id: profile.id,
        seed: tournament.seeding_mode === "random" ? null : participantCount + 1,
        status: "registered",
        source: "manual",
        requested_at: new Date().toISOString(),
        approved_at: new Date().toISOString(),
        approved_by_profile_id: req.user?.id || null,
        updated_at: new Date().toISOString(),
      })
      .select(
        `
        *,
        profile:profiles!tournament_registrations_user_id_fkey (
          id, email, display_name, discord_name, steam_name, avatar_url
        )
      `
      )
      .maybeSingle();

    if (error) throw error;
    return res.json({ ok: true, registration: data });
  } catch (error) {
    console.error("POST /admin/add-participant error:", error);
    return res.status(500).json({ error: error.message || "Failed to add participant" });
  }
});

router.post("/admin/approve-registration", requireAdmin, async (req, res) => {
  try {
    const registrationId = optionalText(req.body.registration_id, 120);
    if (!registrationId) {
      return res.status(400).json({ error: "registration_id is required" });
    }

    const { data: existingRegistration, error: existingRegistrationError } = await supabase
      .from("tournament_registrations")
      .select("*")
      .eq("id", registrationId)
      .maybeSingle();

    if (existingRegistrationError) throw existingRegistrationError;
    if (!existingRegistration) {
      return res.status(404).json({ error: "Registration not found" });
    }

    const tournament = await getTournamentById(existingRegistration.tournament_id);

    if (!tournament) {
      return res.status(404).json({ error: "Tournament not found" });
    }

    const participantCount = await getRegistrationCount(tournament.id, ["registered"]);

    if (
      existingRegistration.status !== "registered" &&
      participantCount >= tournament.max_participants
    ) {
      return res.status(400).json({ error: "Tournament is full" });
    }

    const nextSeed =
      tournament.seeding_mode === "random" ? null : participantCount + 1;

    const { data, error } = await supabase
      .from("tournament_registrations")
      .update({
        status: "registered",
        seed: existingRegistration.seed ?? nextSeed,
        approved_at: new Date().toISOString(),
        approved_by_profile_id: req.user?.id || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", registrationId)
      .select(
        `
        *,
        profile:profiles!tournament_registrations_user_id_fkey (
          id, email, display_name, discord_name, steam_name, avatar_url
        )
      `
      )
      .maybeSingle();

    if (error) throw error;
    return res.json({ ok: true, registration: data });
  } catch (error) {
    console.error("POST /admin/approve-registration error:", error);
    return res.status(500).json({ error: error.message || "Failed to approve registration" });
  }
});

router.post("/admin/update-status", requireAdmin, async (req, res) => {
  try {
    const tournamentId = optionalText(req.body.tournament_id, 120);
    const status = parseEnum(req.body.status, TOURNAMENT_STATUSES, {
      name: "status",
    });

    if (!tournamentId || !status) {
      return res.status(400).json({ error: "tournament_id and status are required" });
    }

    const { data, error } = await supabase
      .from("tournaments")
      .update({
        status,
        updated_at: new Date().toISOString(),
      })
      .eq("id", tournamentId)
      .select("*")
      .maybeSingle();

    if (error) throw error;
    return res.json({ ok: true, tournament: normalizeTournament(data) });
  } catch (error) {
    console.error("POST /admin/update-status error:", error);
    return res.status(500).json({ error: error.message || "Failed to update tournament status" });
  }
});

router.post("/admin/generate-bracket", requireAdmin, async (req, res) => {
  try {
    const tournamentId = optionalText(req.body.tournament_id, 120);
    if (!tournamentId) return res.status(400).json({ error: "tournament_id is required" });
    const tournament = await getTournamentById(tournamentId);
    if (!tournament) return res.status(404).json({ error: "Tournament not found" });
    if (tournament.format !== "single_elimination" || tournament.participant_mode !== "1v1") {
      return res.status(400).json({
        error: "The current automatic bracket generator supports only 1v1 single elimination",
      });
    }

    await generateSingleEliminationBracket(tournament);
    return res.json({ ok: true, message: "Bracket generated successfully" });
  } catch (error) {
    console.error("POST /admin/generate-bracket error:", error);
    return res.status(500).json({ error: error.message || "Failed to generate bracket" });
  }
});

router.post("/admin/resolve-match", requireAdmin, async (req, res) => {
  try {
    const matchId = optionalText(req.body.match_id, 120);
    const winnerSide = trimText(req.body.winner_side || "1", 2);
    const resolution = trimText(req.body.resolution || "admin", 20);
    const player1Wins = parseInteger(req.body.player1_wins, {
      name: "player1_wins",
      min: 0,
      max: 20,
      fallback: 0,
    });
    const player2Wins = parseInteger(req.body.player2_wins, {
      name: "player2_wins",
      min: 0,
      max: 20,
      fallback: 0,
    });
    const adminNotes = optionalText(req.body.admin_notes, 500);

    if (!matchId) {
      return res.status(400).json({ error: "match_id is required" });
    }
    if (!["1", "2"].includes(winnerSide)) {
      return res.status(400).json({ error: "winner_side must be 1 or 2" });
    }
    if (!["admin", "forfeit"].includes(resolution)) {
      return res.status(400).json({ error: "resolution must be admin or forfeit" });
    }

    const { data: match, error: matchError } = await supabase
      .from("tournament_matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();

    if (matchError) throw matchError;
    if (!match) return res.status(404).json({ error: "Match not found" });

    const winnerId = winnerSide === "2" ? match.player2_id : match.player1_id;
    if (!winnerId) return res.status(400).json({ error: "Winner side has no player assigned" });

    await finalizeMatch({
      match,
      winnerId,
      player1Wins,
      player2Wins,
      resolutionType: resolution === "forfeit" ? "forfeit" : "admin",
      adminNotes,
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error("POST /admin/resolve-match error:", error);
    return res.status(500).json({ error: error.message || "Failed to resolve match" });
  }
});

router.post("/admin/report-result", requireAdmin, async (req, res) => {
  try {
    const matchId = optionalText(req.body.match_id, 120);
    const winnerId = optionalText(req.body.winner_id, 120);

    if (!matchId || !winnerId) {
      return res.status(400).json({ error: "match_id and winner_id are required" });
    }

    const { data: match, error: matchError } = await supabase
      .from("tournament_matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();

    if (matchError) throw matchError;
    if (!match) return res.status(404).json({ error: "Match not found" });
    if (![match.player1_id, match.player2_id].includes(winnerId)) {
      return res.status(400).json({
        error: "winner_id must be player1_id or player2_id of the match",
      });
    }

    await finalizeMatch({
      match,
      winnerId,
      player1Wins: match.player1_wins,
      player2Wins: match.player2_wins,
      resolutionType: "admin",
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error("POST /admin/report-result error:", error);
    return res.status(500).json({ error: error.message || "Failed to report result" });
  }
});

module.exports = router;
