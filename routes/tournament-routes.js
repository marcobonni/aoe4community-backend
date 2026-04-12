const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const router = express.Router();

const supabaseUrl =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const tournamentAdminKey = process.env.TOURNAMENT_ADMIN_KEY;

const TOURNAMENT_FORMATS = new Set([
  "single_elimination",
  "double_elimination",
  "round_robin",
  "championship",
  "swiss",
  "groups_playoff",
  "international_style",
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
const REGISTRATION_STATUSES = new Set([
  "pending",
  "registered",
  "rejected",
  "withdrawn",
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

function optionalHttpUrl(value, name) {
  const text = optionalText(value, 2048);

  if (!text) {
    return null;
  }

  try {
    const parsed = new URL(text);

    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Invalid protocol");
    }

    return parsed.toString();
  } catch {
    throw new Error(`${name} must be a valid http or https URL`);
  }
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
  return user?.profile_role === "admin";
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

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();

  if (profile?.role) {
    data.user.profile_role = profile.role;
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
    role: user.profile_role || "user",
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

  user.profile_role = payload.role;

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

async function getRegistrationById(registrationId) {
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
    .eq("id", registrationId)
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

async function loadAllRegistrationEntries(tournamentId) {
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
    .order("requested_at", { ascending: true });

  if (error) throw error;

  const statusOrder = {
    registered: 0,
    pending: 1,
    rejected: 2,
    withdrawn: 3,
  };

  return (data || []).sort((left, right) => {
    const statusDiff =
      (statusOrder[left.status] ?? Number.MAX_SAFE_INTEGER) -
      (statusOrder[right.status] ?? Number.MAX_SAFE_INTEGER);

    if (statusDiff !== 0) {
      return statusDiff;
    }

    const leftSeed = Number.isInteger(left.seed) ? left.seed : Number.MAX_SAFE_INTEGER;
    const rightSeed = Number.isInteger(right.seed) ? right.seed : Number.MAX_SAFE_INTEGER;

    if (leftSeed !== rightSeed) {
      return leftSeed - rightSeed;
    }

    return String(left.profile?.display_name || "").localeCompare(
      String(right.profile?.display_name || "")
    );
  });
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

function parseOptionalSeed(value) {
  if (value == null || value === "") {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 4096) {
    throw new Error("seed must be a positive integer");
  }

  return parsed;
}

async function tournamentHasGeneratedBracket(tournamentId, tournament = null) {
  if (tournament?.bracket_generated_at) {
    return true;
  }

  const matchCount = await getMatchCount(tournamentId);
  return matchCount > 0;
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

function isCompletedMatchStatus(status) {
  return ["completed", "forfeited", "cancelled"].includes(normalizeMatchStatus(status));
}

function getPairKey(playerOneId, playerTwoId) {
  return [playerOneId, playerTwoId].filter(Boolean).sort().join("::");
}

function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""));
}

function compareNullableNumber(left, right, fallback = Number.MAX_SAFE_INTEGER) {
  const normalizedLeft = Number.isFinite(left) ? left : fallback;
  const normalizedRight = Number.isFinite(right) ? right : fallback;
  return normalizedLeft - normalizedRight;
}

function sortParticipantsByIdentity(left, right) {
  return compareText(
    left.profile?.display_name || left.display_name || left.user_id,
    right.profile?.display_name || right.display_name || right.user_id
  );
}

async function loadHistoricalSeedingStats(participantIds, currentTournamentId) {
  if (!participantIds.length) {
    return new Map();
  }

  const [playerOneMatchesResponse, playerTwoMatchesResponse] = await Promise.all([
    supabase
      .from("tournament_matches")
      .select(
        "id, tournament_id, status, player1_id, player2_id, winner_id, player1_wins, player2_wins, completed_at"
      )
      .in("player1_id", participantIds),
    supabase
      .from("tournament_matches")
      .select(
        "id, tournament_id, status, player1_id, player2_id, winner_id, player1_wins, player2_wins, completed_at"
      )
      .in("player2_id", participantIds),
  ]);

  if (playerOneMatchesResponse.error) throw playerOneMatchesResponse.error;
  if (playerTwoMatchesResponse.error) throw playerTwoMatchesResponse.error;

  const matchesById = new Map();

  for (const match of [
    ...(playerOneMatchesResponse.data || []),
    ...(playerTwoMatchesResponse.data || []),
  ]) {
    if (match.tournament_id === currentTournamentId) {
      continue;
    }

    if (!isCompletedMatchStatus(match.status)) {
      continue;
    }

    matchesById.set(match.id, match);
  }

  const statsByParticipant = new Map(
    participantIds.map((participantId) => [
      participantId,
      {
        historicalWins: 0,
        historicalLosses: 0,
        historicalMapWins: 0,
        historicalMapLosses: 0,
        latestTournamentId: null,
        latestCompletedAt: null,
        latestTournamentWins: 0,
        latestTournamentLosses: 0,
        latestTournamentMapWins: 0,
        latestTournamentMapLosses: 0,
      },
    ])
  );

  for (const match of matchesById.values()) {
    const sides = [
      {
        participantId: match.player1_id,
        opponentId: match.player2_id,
        mapWins: match.player1_wins || 0,
        mapLosses: match.player2_wins || 0,
      },
      {
        participantId: match.player2_id,
        opponentId: match.player1_id,
        mapWins: match.player2_wins || 0,
        mapLosses: match.player1_wins || 0,
      },
    ];

    for (const side of sides) {
      if (!statsByParticipant.has(side.participantId)) {
        continue;
      }

      const participantStats = statsByParticipant.get(side.participantId);
      const wonMatch = match.winner_id === side.participantId;
      const completedAt =
        match.completed_at || match.reported_at || new Date(0).toISOString();

      participantStats.historicalWins += wonMatch ? 1 : 0;
      participantStats.historicalLosses += wonMatch ? 0 : 1;
      participantStats.historicalMapWins += side.mapWins;
      participantStats.historicalMapLosses += side.mapLosses;

      if (
        !participantStats.latestCompletedAt ||
        new Date(completedAt).getTime() > new Date(participantStats.latestCompletedAt).getTime()
      ) {
        participantStats.latestTournamentId = match.tournament_id;
        participantStats.latestCompletedAt = completedAt;
        participantStats.latestTournamentWins = wonMatch ? 1 : 0;
        participantStats.latestTournamentLosses = wonMatch ? 0 : 1;
        participantStats.latestTournamentMapWins = side.mapWins;
        participantStats.latestTournamentMapLosses = side.mapLosses;
        continue;
      }

      if (participantStats.latestTournamentId === match.tournament_id) {
        participantStats.latestTournamentWins += wonMatch ? 1 : 0;
        participantStats.latestTournamentLosses += wonMatch ? 0 : 1;
        participantStats.latestTournamentMapWins += side.mapWins;
        participantStats.latestTournamentMapLosses += side.mapLosses;
      }
    }
  }

  return statsByParticipant;
}

function getHistoricalRankingValue(stats) {
  if (!stats) {
    return 0;
  }

  return (
    stats.historicalWins * 100 +
    (stats.historicalMapWins - stats.historicalMapLosses) * 10 -
    stats.historicalLosses
  );
}

function getLatestSeasonRankingValue(stats) {
  if (!stats || !stats.latestTournamentId) {
    return 0;
  }

  return (
    stats.latestTournamentWins * 100 +
    (stats.latestTournamentMapWins - stats.latestTournamentMapLosses) * 10 -
    stats.latestTournamentLosses
  );
}

async function resolveBracketOrdering(registrations, seedingMode, currentTournamentId = null) {
  const registered = registrations
    .filter((entry) => entry.status === "registered")
    .map((entry, index) => ({
      ...entry,
      _fallbackSeed:
        typeof entry.seed === "number"
          ? entry.seed
          : registrations.length + index + 1,
      _fallbackIndex: index,
    }));

  if (registered.length === 0) {
    return {
      orderedSlots: [],
      sortedParticipants: [],
      bracketSize: 1,
    };
  }

  if (seedingMode === "random") {
    const shuffled = shuffle(registered);
    const bracketSize = nextPowerOfTwo(shuffled.length);
    const seedOrder = buildSeedOrder(bracketSize);

    return {
      orderedSlots: seedOrder.map((seed) => shuffled[seed - 1] || null),
      sortedParticipants: shuffled,
      bracketSize,
    };
  }

  const historyStats = ["ranking_based", "previous_season", "protected"].includes(
    seedingMode
  )
    ? await loadHistoricalSeedingStats(
        registered.map((entry) => entry.user_id),
        currentTournamentId
      )
    : new Map();

  const sorted = [...registered].sort((left, right) => {
    const leftStats = historyStats.get(left.user_id);
    const rightStats = historyStats.get(right.user_id);

    if (seedingMode === "ranking_based" || seedingMode === "protected") {
      const rankingDelta =
        getHistoricalRankingValue(rightStats) - getHistoricalRankingValue(leftStats);

      if (rankingDelta !== 0) {
        return rankingDelta;
      }
    }

    if (seedingMode === "previous_season") {
      const latestSeasonDelta =
        getLatestSeasonRankingValue(rightStats) - getLatestSeasonRankingValue(leftStats);

      if (latestSeasonDelta !== 0) {
        return latestSeasonDelta;
      }

      const rankingDelta =
        getHistoricalRankingValue(rightStats) - getHistoricalRankingValue(leftStats);

      if (rankingDelta !== 0) {
        return rankingDelta;
      }
    }

    const seedDelta = compareNullableNumber(left.seed, right.seed);

    if (seedDelta !== 0) {
      return seedDelta;
    }

    const requestedAtDelta =
      new Date(left.requested_at || 0).getTime() - new Date(right.requested_at || 0).getTime();

    if (requestedAtDelta !== 0) {
      return requestedAtDelta;
    }

    const identityDelta = sortParticipantsByIdentity(left, right);

    if (identityDelta !== 0) {
      return identityDelta;
    }

    return left._fallbackIndex - right._fallbackIndex;
  });

  const bracketSize = nextPowerOfTwo(sorted.length);
  const seedOrder = buildSeedOrder(bracketSize);
  const bySeed = [...sorted];

  return {
    orderedSlots: seedOrder.map((seed) => bySeed[seed - 1] || null),
    sortedParticipants: sorted,
    bracketSize,
  };
}

function buildPairHistory(matches) {
  const pairHistory = new Map();

  for (const match of matches || []) {
    if (!match.player1_id || !match.player2_id) {
      continue;
    }

    const pairKey = getPairKey(match.player1_id, match.player2_id);
    pairHistory.set(pairKey, (pairHistory.get(pairKey) || 0) + 1);
  }

  return pairHistory;
}

function getRoundRobinRounds(participants, legCount = 1) {
  if (participants.length < 2) {
    return [];
  }

  const baseEntries = [...participants];
  const useBye = baseEntries.length % 2 !== 0;

  if (useBye) {
    baseEntries.push(null);
  }

  const rotation = [...baseEntries];
  const rounds = [];
  const roundsPerLeg = rotation.length - 1;

  for (let leg = 0; leg < legCount; leg += 1) {
    for (let roundIndex = 0; roundIndex < roundsPerLeg; roundIndex += 1) {
      const pairings = [];

      for (let index = 0; index < rotation.length / 2; index += 1) {
        const leftParticipant = rotation[index];
        const rightParticipant = rotation[rotation.length - 1 - index];

        if (!leftParticipant || !rightParticipant) {
          continue;
        }

        pairings.push(
          leg % 2 === 0
            ? { player1: leftParticipant, player2: rightParticipant }
            : { player1: rightParticipant, player2: leftParticipant }
        );
      }

      rounds.push(pairings);

      const fixedParticipant = rotation[0];
      const rotatingBlock = rotation.slice(1);
      rotatingBlock.unshift(rotatingBlock.pop());
      rotation.splice(0, rotation.length, fixedParticipant, ...rotatingBlock);
    }
  }

  return rounds;
}

function getStandingsComparator(tieBreaker) {
  return (left, right) => {
    const primaryDelta = right.matchWins - left.matchWins;

    if (primaryDelta !== 0) {
      return primaryDelta;
    }

    if (tieBreaker === "map_difference") {
      const mapDiffDelta =
        right.mapWins - right.mapLosses - (left.mapWins - left.mapLosses);

      if (mapDiffDelta !== 0) {
        return mapDiffDelta;
      }
    }

    if (tieBreaker === "point_difference") {
      const pointDiffDelta =
        right.pointsFor - right.pointsAgainst - (left.pointsFor - left.pointsAgainst);

      if (pointDiffDelta !== 0) {
        return pointDiffDelta;
      }
    }

    if (tieBreaker === "buchholz") {
      const buchholzDelta = (right.buchholz || 0) - (left.buchholz || 0);

      if (buchholzDelta !== 0) {
        return buchholzDelta;
      }
    }

    if (tieBreaker === "head_to_head" && left.headToHeadWins !== right.headToHeadWins) {
      return right.headToHeadWins - left.headToHeadWins;
    }

    if (tieBreaker === "initial_seed") {
      const seedDelta = compareNullableNumber(left.seed, right.seed);

      if (seedDelta !== 0) {
        return seedDelta;
      }
    }

    const fallbackMapDiffDelta =
      right.mapWins - right.mapLosses - (left.mapWins - left.mapLosses);

    if (fallbackMapDiffDelta !== 0) {
      return fallbackMapDiffDelta;
    }

    const fallbackSeedDelta = compareNullableNumber(left.seed, right.seed);

    if (fallbackSeedDelta !== 0) {
      return fallbackSeedDelta;
    }

    return compareText(left.displayName, right.displayName);
  };
}

function buildStandings(participants, matches, tieBreaker) {
  const participantIds = new Set(participants.map((participant) => participant.user_id));
  const standings = new Map(
    participants.map((participant) => [
      participant.user_id,
      {
        participantId: participant.user_id,
        displayName:
          participant.profile?.display_name || participant.display_name || participant.user_id,
        seed: participant.seed,
        matchWins: 0,
        matchLosses: 0,
        mapWins: 0,
        mapLosses: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        opponents: [],
        headToHeadWins: 0,
      },
    ])
  );

  const completedMatches = (matches || []).filter(
    (match) =>
      isCompletedMatchStatus(match.status) &&
      participantIds.has(match.player1_id) &&
      participantIds.has(match.player2_id)
  );

  for (const match of completedMatches) {
    const playerOneStats = standings.get(match.player1_id);
    const playerTwoStats = standings.get(match.player2_id);

    if (!playerOneStats || !playerTwoStats) {
      continue;
    }

    const playerOneWins = match.player1_wins || 0;
    const playerTwoWins = match.player2_wins || 0;
    const playerOneWon = match.winner_id === match.player1_id;
    const playerTwoWon = match.winner_id === match.player2_id;

    playerOneStats.matchWins += playerOneWon ? 1 : 0;
    playerOneStats.matchLosses += playerOneWon ? 0 : 1;
    playerOneStats.mapWins += playerOneWins;
    playerOneStats.mapLosses += playerTwoWins;
    playerOneStats.pointsFor += playerOneWins;
    playerOneStats.pointsAgainst += playerTwoWins;
    playerOneStats.opponents.push(match.player2_id);
    playerOneStats.headToHeadWins += playerOneWon ? 1 : 0;

    playerTwoStats.matchWins += playerTwoWon ? 1 : 0;
    playerTwoStats.matchLosses += playerTwoWon ? 0 : 1;
    playerTwoStats.mapWins += playerTwoWins;
    playerTwoStats.mapLosses += playerOneWins;
    playerTwoStats.pointsFor += playerTwoWins;
    playerTwoStats.pointsAgainst += playerOneWins;
    playerTwoStats.opponents.push(match.player1_id);
    playerTwoStats.headToHeadWins += playerTwoWon ? 1 : 0;
  }

  const standingsList = [...standings.values()];

  for (const standing of standingsList) {
    standing.buchholz = standing.opponents.reduce((total, opponentId) => {
      const opponentStanding = standings.get(opponentId);
      return total + (opponentStanding?.matchWins || 0);
    }, 0);
  }

  return standingsList.sort(getStandingsComparator(tieBreaker));
}

async function updateTournamentCompletionStatus(tournamentId) {
  const tournament = await getTournamentById(tournamentId);

  if (!tournament) {
    return;
  }

  const matches = await loadMatches(tournamentId);

  if (!matches.length) {
    return;
  }

  const allCompleted = matches.every((match) => isCompletedMatchStatus(match.status));

  if (!allCompleted) {
    return;
  }

  const roundCount = new Set(matches.map((match) => match.round_number)).size;
  const registrations = await loadParticipants(tournamentId);
  const registeredParticipants = registrations.filter(
    (participant) => participant.status === "registered"
  );

  let shouldCompleteTournament = true;

  if (tournament.format === "swiss") {
    shouldCompleteTournament =
      roundCount >= Math.max(2, Math.ceil(Math.log2(Math.max(registeredParticipants.length, 2))));
  }

  if (tournament.format === "king_of_the_hill") {
    shouldCompleteTournament = matches.length >= Math.max(registeredParticipants.length - 1, 1);
  }

  if (tournament.format === "ladder") {
    shouldCompleteTournament = roundCount >= Math.max(registeredParticipants.length - 1, 1);
  }

  if (tournament.format === "double_elimination") {
    const lossCounts = new Map(
      registeredParticipants.map((participant) => [participant.user_id, 0])
    );

    for (const match of matches) {
      if (!match.player1_id || !match.player2_id || !match.winner_id) {
        continue;
      }

      const loserId = match.winner_id === match.player1_id ? match.player2_id : match.player1_id;

      if (lossCounts.has(loserId)) {
        lossCounts.set(loserId, (lossCounts.get(loserId) || 0) + 1);
      }
    }

    shouldCompleteTournament =
      [...lossCounts.values()].filter((losses) => losses < 2).length <= 1;
  }

  if (tournament.format === "international_style") {
    const { sortedParticipants } = await resolveBracketOrdering(
      registrations,
      tournament.seeding_mode,
      tournament.id
    );
    const groups = buildSeededGroups(
      sortedParticipants,
      getInternationalStyleGroupCount(sortedParticipants.length)
    );
    const groupStageRoundCount = getGroupStageRoundCount(groups);
    const playoffMatches = matches.filter((match) => match.round_number > groupStageRoundCount);

    if (!playoffMatches.length) {
      shouldCompleteTournament = false;
    } else {
      const stageState = getInternationalStyleStageState(
        groups,
        matches,
        tournament.tie_breaker,
        groupStageRoundCount
      );
      const effectiveLossCounts = buildEffectiveLossCountMap(
        stageState.qualifiedParticipants,
        playoffMatches,
        stageState.baseLossCounts
      );

      shouldCompleteTournament =
        [...effectiveLossCounts.values()].filter((losses) => losses < 2).length <= 1;
    }
  }

  if (!shouldCompleteTournament) {
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
  await progressTournamentAfterMatch(match.tournament_id);
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

  const { orderedSlots, sortedParticipants, bracketSize } = await resolveBracketOrdering(
    registrations,
    tournament.seeding_mode,
    tournament.id
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
      const participantEntries = await loadAllRegistrationEntries(tournament.id);

      return {
        ...enriched,
        pending_registration_entries: pendingEntries,
        participant_entries: participantEntries,
      };
    })
  );
}

function getMaxRoundNumber(matches) {
  return (matches || []).reduce(
    (highestRound, match) => Math.max(highestRound, match.round_number || 0),
    0
  );
}

function getOpenMatches(matches) {
  return (matches || []).filter((match) => !isCompletedMatchStatus(match.status));
}

async function markTournamentLive(tournamentId) {
  const { error } = await supabase
    .from("tournaments")
    .update({
      status: "live",
      bracket_generated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", tournamentId);

  if (error) throw error;
}

async function syncParticipantSeeds(participants) {
  for (let index = 0; index < participants.length; index += 1) {
    const participant = participants[index];
    const nextSeed = index + 1;

    const { error } = await supabase
      .from("tournament_registrations")
      .update({
        seed: nextSeed,
        updated_at: new Date().toISOString(),
      })
      .eq("id", participant.id);

    if (error) throw error;
  }
}

function shouldRoundStartReady(tournament, roundNumber) {
  return tournament.scheduling_mode === "free" || roundNumber === 1;
}

async function insertMatchRecord({
  tournamentId,
  roundNumber,
  matchNumber,
  player1Id,
  player2Id,
  status,
}) {
  const finalStatus =
    player1Id && player2Id ? status : player1Id || player2Id ? "pending" : "cancelled";
  const { data, error } = await supabase
    .from("tournament_matches")
    .insert({
      tournament_id: tournamentId,
      round_number: roundNumber,
      match_number: matchNumber,
      player1_id: player1Id,
      player2_id: player2Id,
      status: finalStatus,
    })
    .select("*")
    .maybeSingle();

  if (error) throw error;

  if (data && (player1Id || player2Id) && !player1Id !== !player2Id) {
    await maybeAdvanceBye(data);
  }

  return data;
}

async function activateRoundMatches(roundMatches) {
  for (const match of roundMatches) {
    const nextStatus =
      match.player1_id && match.player2_id ? "ready" : match.player1_id || match.player2_id ? "pending" : "cancelled";

    const { error } = await supabase
      .from("tournament_matches")
      .update({
        status: nextStatus,
        updated_at: new Date().toISOString(),
      })
      .eq("id", match.id);

    if (error) throw error;

    if ((match.player1_id || match.player2_id) && !(match.player1_id && match.player2_id)) {
      await maybeAdvanceBye(match);
    }
  }
}

async function activateNextPendingRoundIfPossible(tournamentId) {
  const matches = await loadMatches(tournamentId);
  const rounds = Array.from(new Set(matches.map((match) => match.round_number))).sort(
    (left, right) => left - right
  );

  for (const roundNumber of rounds) {
    const roundMatches = matches.filter((match) => match.round_number === roundNumber);
    const roundHasActiveMatches = roundMatches.some(
      (match) =>
        !isCompletedMatchStatus(match.status) && normalizeMatchStatus(match.status) !== "pending"
    );

    if (roundHasActiveMatches) {
      return false;
    }

    const roundHasPendingMatches = roundMatches.some(
      (match) => normalizeMatchStatus(match.status) === "pending"
    );

    if (roundHasPendingMatches) {
      await activateRoundMatches(roundMatches);
      return true;
    }
  }

  return false;
}

function buildPairingsFromOrderedParticipants(participants, matches) {
  const queue = [...participants];
  const pairHistory = buildPairHistory(matches);
  const pairings = [];

  while (queue.length > 0) {
    const participant = queue.shift();

    if (!queue.length) {
      pairings.push([participant, null]);
      continue;
    }

    let partnerIndex = queue.findIndex(
      (candidate) => !pairHistory.has(getPairKey(participant.user_id, candidate.user_id))
    );

    if (partnerIndex < 0) {
      partnerIndex = 0;
    }

    const [partner] = queue.splice(partnerIndex, 1);
    pairings.push([participant, partner]);
  }

  return pairings;
}

function buildSeededGroups(sortedParticipants, groupCount) {
  const groups = Array.from({ length: groupCount }, () => []);
  let currentIndex = 0;
  let direction = 1;

  for (const participant of sortedParticipants) {
    groups[currentIndex].push(participant);

    if (direction === 1 && currentIndex === groupCount - 1) {
      direction = -1;
    } else if (direction === -1 && currentIndex === 0) {
      direction = 1;
    } else {
      currentIndex += direction;
    }
  }

  return groups.filter((group) => group.length > 0);
}

function getGroupsPlayoffGroupCount(participantCount) {
  if (participantCount <= 4) return 1;
  if (participantCount <= 8) return 2;
  return Math.max(2, Math.ceil(participantCount / 4));
}

function getInternationalStyleGroupCount(participantCount) {
  if (participantCount <= 6) {
    return 1;
  }

  return 2;
}

function getSwissRoundLimit(participantCount) {
  return Math.max(2, Math.ceil(Math.log2(Math.max(participantCount, 2))));
}

function getLossCountMap(matches, participants) {
  const trackedIds = new Set(participants.map((participant) => participant.user_id));
  const lossCounts = new Map(participants.map((participant) => [participant.user_id, 0]));

  for (const match of matches) {
    if (!isCompletedMatchStatus(match.status) || !match.player1_id || !match.player2_id) {
      continue;
    }

    const loserId = match.winner_id === match.player1_id ? match.player2_id : match.player1_id;

    if (trackedIds.has(loserId)) {
      lossCounts.set(loserId, (lossCounts.get(loserId) || 0) + 1);
    }
  }

  return lossCounts;
}

function buildEffectiveLossCountMap(participants, matches, baseLossCounts = new Map()) {
  const effectiveLossCounts = new Map(
    participants.map((participant) => [
      participant.user_id,
      baseLossCounts.get(participant.user_id) || 0,
    ])
  );

  for (const match of matches) {
    if (!isCompletedMatchStatus(match.status) || !match.player1_id || !match.player2_id) {
      continue;
    }

    const loserId = match.winner_id === match.player1_id ? match.player2_id : match.player1_id;

    if (effectiveLossCounts.has(loserId)) {
      effectiveLossCounts.set(loserId, (effectiveLossCounts.get(loserId) || 0) + 1);
    }
  }

  return effectiveLossCounts;
}

function getCrossGroupPairings(groupedParticipants) {
  if (!groupedParticipants.length) {
    return [];
  }

  if (groupedParticipants.length === 1) {
    return buildPairingsFromOrderedParticipants(groupedParticipants[0], []);
  }

  if (groupedParticipants.length === 2) {
    const [groupOne, groupTwo] = groupedParticipants;
    const reversedGroupTwo = [...groupTwo].reverse();
    const maxLength = Math.max(groupOne.length, reversedGroupTwo.length);
    const pairings = [];

    for (let index = 0; index < maxLength; index += 1) {
      const playerOne = groupOne[index] || null;
      const playerTwo = reversedGroupTwo[index] || null;

      if (playerOne || playerTwo) {
        pairings.push([playerOne, playerTwo]);
      }
    }

    return pairings;
  }

  return buildPairingsFromOrderedParticipants(groupedParticipants.flat(), []);
}

function getLadderOrder(sortedParticipants, matches) {
  const order = sortedParticipants.map((participant) => participant.user_id);

  for (const match of [...matches].sort((left, right) => {
    if (left.round_number !== right.round_number) {
      return left.round_number - right.round_number;
    }

    return left.match_number - right.match_number;
  })) {
    if (!isCompletedMatchStatus(match.status) || !match.winner_id || !match.player1_id || !match.player2_id) {
      continue;
    }

    const winnerIndex = order.indexOf(match.winner_id);
    const loserId = match.winner_id === match.player1_id ? match.player2_id : match.player1_id;
    const loserIndex = order.indexOf(loserId);

    if (winnerIndex > loserIndex && loserIndex >= 0) {
      order.splice(winnerIndex, 1);
      order.splice(loserIndex, 0, match.winner_id);
    }
  }

  return order;
}

async function insertSingleEliminationStage({
  tournament,
  participants,
  seedingMode,
  roundOffset = 0,
}) {
  const { orderedSlots, sortedParticipants, bracketSize } = await resolveBracketOrdering(
    participants,
    seedingMode || tournament.seeding_mode,
    tournament.id
  );

  await syncParticipantSeeds(sortedParticipants);

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

      const insertedMatch = await insertMatchRecord({
        tournamentId: tournament.id,
        roundNumber: roundOffset + round,
        matchNumber,
        player1Id,
        player2Id,
        status: shouldRoundStartReady(tournament, roundOffset + round) ? "ready" : "pending",
      });

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

      const { error } = await supabase
        .from("tournament_matches")
        .update({
          next_match_id: nextMatch.id,
          next_match_slot: nextMatchSlot,
          updated_at: new Date().toISOString(),
        })
        .eq("id", currentMatch.id);

      if (error) throw error;
    }
  }

  return insertedByRound;
}

async function generateRoundRobinBracket(tournament, legCount = 1) {
  const existingMatches = await loadMatches(tournament.id);

  if (existingMatches.length > 0) {
    throw new Error("Schedule already generated for this tournament");
  }

  const registrations = await loadParticipants(tournament.id);
  const registered = registrations.filter((entry) => entry.status === "registered");

  if (registered.length < Math.max(2, tournament.min_participants || 2)) {
    throw new Error("At least 2 registered participants are required");
  }

  const { sortedParticipants } = await resolveBracketOrdering(
    registrations,
    tournament.seeding_mode,
    tournament.id
  );

  await syncParticipantSeeds(sortedParticipants);

  const rounds = getRoundRobinRounds(sortedParticipants, legCount);

  for (let roundIndex = 0; roundIndex < rounds.length; roundIndex += 1) {
    const roundNumber = roundIndex + 1;

    for (let matchIndex = 0; matchIndex < rounds[roundIndex].length; matchIndex += 1) {
      const pairing = rounds[roundIndex][matchIndex];

      await insertMatchRecord({
        tournamentId: tournament.id,
        roundNumber,
        matchNumber: matchIndex + 1,
        player1Id: pairing.player1.user_id,
        player2Id: pairing.player2.user_id,
        status: shouldRoundStartReady(tournament, roundNumber) ? "ready" : "pending",
      });
    }
  }

  await markTournamentLive(tournament.id);
}

async function generateSwissRound(tournament) {
  const registrations = await loadParticipants(tournament.id);
  const registered = registrations.filter((entry) => entry.status === "registered");
  const matches = await loadMatches(tournament.id);

  if (registered.length < Math.max(2, tournament.min_participants || 2)) {
    throw new Error("At least 2 registered participants are required");
  }

  if (getOpenMatches(matches).length > 0) {
    throw new Error("Complete the current Swiss round before generating the next one");
  }

  const roundLimit = getSwissRoundLimit(registered.length);
  const generatedRoundCount = getMaxRoundNumber(matches);

  if (generatedRoundCount >= roundLimit) {
    return false;
  }

  const { sortedParticipants } = await resolveBracketOrdering(
    registrations,
    tournament.seeding_mode,
    tournament.id
  );
  const participantById = new Map(
    sortedParticipants.map((participant) => [participant.user_id, participant])
  );
  const standings = buildStandings(registered, matches, tournament.tie_breaker);
  const orderedParticipants =
    matches.length === 0
      ? sortedParticipants
      : standings
          .map((standing) => participantById.get(standing.participantId))
          .filter(Boolean);

  const pairings = buildPairingsFromOrderedParticipants(orderedParticipants, matches);
  const roundNumber = generatedRoundCount + 1;

  for (let index = 0; index < pairings.length; index += 1) {
    const [playerOne, playerTwo] = pairings[index];

    await insertMatchRecord({
      tournamentId: tournament.id,
      roundNumber,
      matchNumber: index + 1,
      player1Id: playerOne?.user_id || null,
      player2Id: playerTwo?.user_id || null,
      status: "ready",
    });
  }

  await markTournamentLive(tournament.id);
  return true;
}

async function generateDoubleEliminationRound(tournament) {
  const registrations = await loadParticipants(tournament.id);
  const registered = registrations.filter((entry) => entry.status === "registered");
  const matches = await loadMatches(tournament.id);

  if (registered.length < Math.max(2, tournament.min_participants || 2)) {
    throw new Error("At least 2 registered participants are required");
  }

  if (getOpenMatches(matches).length > 0) {
    throw new Error("Complete the active double elimination round first");
  }

  const { sortedParticipants } = await resolveBracketOrdering(
    registrations,
    tournament.seeding_mode,
    tournament.id
  );
  const lossCounts = getLossCountMap(matches, sortedParticipants);
  const activeParticipants = sortedParticipants.filter(
    (participant) => (lossCounts.get(participant.user_id) || 0) < 2
  );

  if (activeParticipants.length <= 1) {
    return false;
  }

  const orderedParticipants = [...activeParticipants].sort((left, right) => {
    const lossDelta =
      (lossCounts.get(left.user_id) || 0) - (lossCounts.get(right.user_id) || 0);

    if (lossDelta !== 0) {
      return lossDelta;
    }

    return compareNullableNumber(left.seed, right.seed);
  });

  const pairings = buildPairingsFromOrderedParticipants(orderedParticipants, matches);
  const roundNumber = getMaxRoundNumber(matches) + 1;

  for (let index = 0; index < pairings.length; index += 1) {
    const [playerOne, playerTwo] = pairings[index];

    await insertMatchRecord({
      tournamentId: tournament.id,
      roundNumber,
      matchNumber: index + 1,
      player1Id: playerOne?.user_id || null,
      player2Id: playerTwo?.user_id || null,
      status: "ready",
    });
  }

  await markTournamentLive(tournament.id);
  return true;
}

async function generateKingOfTheHillRound(tournament) {
  const registrations = await loadParticipants(tournament.id);
  const registered = registrations.filter((entry) => entry.status === "registered");
  const matches = await loadMatches(tournament.id);

  if (registered.length < Math.max(2, tournament.min_participants || 2)) {
    throw new Error("At least 2 registered participants are required");
  }

  if (getOpenMatches(matches).length > 0) {
    throw new Error("Resolve the current king of the hill match first");
  }

  const { sortedParticipants } = await resolveBracketOrdering(
    registrations,
    tournament.seeding_mode,
    tournament.id
  );
  const matchIndex = matches.length;

  if (matchIndex >= sortedParticipants.length - 1) {
    return false;
  }

  const currentChampionId =
    matchIndex === 0
      ? sortedParticipants[0].user_id
      : [...matches]
          .sort((left, right) => {
            if (left.round_number !== right.round_number) {
              return left.round_number - right.round_number;
            }

            return left.match_number - right.match_number;
          })
          .at(-1)?.winner_id;
  const nextChallenger = sortedParticipants[matchIndex + 1];

  if (!currentChampionId || !nextChallenger) {
    return false;
  }

  await insertMatchRecord({
    tournamentId: tournament.id,
    roundNumber: matchIndex + 1,
    matchNumber: 1,
    player1Id: currentChampionId,
    player2Id: nextChallenger.user_id,
    status: "ready",
  });

  await markTournamentLive(tournament.id);
  return true;
}

async function generateLadderRound(tournament) {
  const registrations = await loadParticipants(tournament.id);
  const registered = registrations.filter((entry) => entry.status === "registered");
  const matches = await loadMatches(tournament.id);

  if (registered.length < Math.max(2, tournament.min_participants || 2)) {
    throw new Error("At least 2 registered participants are required");
  }

  if (getOpenMatches(matches).length > 0) {
    throw new Error("Resolve the current ladder challenge round first");
  }

  const { sortedParticipants } = await resolveBracketOrdering(
    registrations,
    tournament.seeding_mode,
    tournament.id
  );
  const currentOrderIds = getLadderOrder(sortedParticipants, matches);
  const participantById = new Map(
    sortedParticipants.map((participant) => [participant.user_id, participant])
  );
  const orderedParticipants = currentOrderIds
    .map((participantId) => participantById.get(participantId))
    .filter(Boolean);
  const roundNumber = getMaxRoundNumber(matches) + 1;

  if (roundNumber > Math.max(sortedParticipants.length - 1, 1)) {
    return false;
  }

  await syncParticipantSeeds(orderedParticipants);

  const pairings = [];

  for (let index = 0; index < orderedParticipants.length; index += 2) {
    pairings.push([orderedParticipants[index], orderedParticipants[index + 1] || null]);
  }

  for (let index = 0; index < pairings.length; index += 1) {
    const [playerOne, playerTwo] = pairings[index];

    await insertMatchRecord({
      tournamentId: tournament.id,
      roundNumber,
      matchNumber: index + 1,
      player1Id: playerOne?.user_id || null,
      player2Id: playerTwo?.user_id || null,
      status: "ready",
    });
  }

  await markTournamentLive(tournament.id);
  return true;
}

function getGroupStageRoundCount(groups) {
  return groups.reduce(
    (highestRoundCount, group) =>
      Math.max(highestRoundCount, getRoundRobinRounds(group).length),
    0
  );
}

function getInternationalStyleStageState(groups, matches, tieBreaker, groupStageRoundCount) {
  const upperGroups = [];
  const lowerGroups = [];
  const baseLossCounts = new Map();
  const standingsByGroup = [];

  for (const group of groups) {
    const groupParticipantIds = new Set(group.map((participant) => participant.user_id));
    const groupMatches = matches.filter(
      (match) =>
        match.round_number <= groupStageRoundCount &&
        groupParticipantIds.has(match.player1_id) &&
        groupParticipantIds.has(match.player2_id)
    );
    const standings = buildStandings(group, groupMatches, tieBreaker);
    const orderedParticipants = standings
      .map((standing) => group.find((entry) => entry.user_id === standing.participantId))
      .filter(Boolean);
    const upperCount = Math.max(1, Math.floor(orderedParticipants.length / 2));
    const upperQualifiers = orderedParticipants.slice(0, upperCount);
    const lowerQualifiers = orderedParticipants.slice(upperCount);

    upperGroups.push(upperQualifiers);
    lowerGroups.push(lowerQualifiers);
    standingsByGroup.push({
      groupParticipantIds,
      standings,
      upperQualifiers,
      lowerQualifiers,
    });

    for (const participant of upperQualifiers) {
      baseLossCounts.set(participant.user_id, 0);
    }

    for (const participant of lowerQualifiers) {
      baseLossCounts.set(participant.user_id, 1);
    }

    for (const participant of group) {
      if (!baseLossCounts.has(participant.user_id)) {
        baseLossCounts.set(participant.user_id, 2);
      }
    }
  }

  const upperQualifiers = upperGroups.flat();
  const lowerQualifiers = lowerGroups.flat();

  return {
    standingsByGroup,
    upperGroups,
    lowerGroups,
    upperQualifiers,
    lowerQualifiers,
    qualifiedParticipants: upperQualifiers.concat(lowerQualifiers),
    baseLossCounts,
  };
}

async function generateInternationalStyleBracket(tournament) {
  const registrations = await loadParticipants(tournament.id);
  const registered = registrations.filter((entry) => entry.status === "registered");
  const matches = await loadMatches(tournament.id);

  if (registered.length < Math.max(8, tournament.min_participants || 2)) {
    throw new Error(
      "At least 8 registered participants are required for the International style format"
    );
  }

  const { sortedParticipants } = await resolveBracketOrdering(
    registrations,
    tournament.seeding_mode,
    tournament.id
  );
  const groups = buildSeededGroups(
    sortedParticipants,
    getInternationalStyleGroupCount(sortedParticipants.length)
  );
  const groupStageRoundCount = getGroupStageRoundCount(groups);

  if (!matches.length) {
    const matchesByRound = new Map();

    for (const group of groups) {
      const groupRounds = getRoundRobinRounds(group);

      for (let roundIndex = 0; roundIndex < groupRounds.length; roundIndex += 1) {
        const roundNumber = roundIndex + 1;
        const existingRound = matchesByRound.get(roundNumber) || [];
        matchesByRound.set(roundNumber, existingRound.concat(groupRounds[roundIndex]));
      }
    }

    for (const [roundNumber, pairings] of [...matchesByRound.entries()].sort(
      (left, right) => left[0] - right[0]
    )) {
      for (let matchIndex = 0; matchIndex < pairings.length; matchIndex += 1) {
        const pairing = pairings[matchIndex];

        await insertMatchRecord({
          tournamentId: tournament.id,
          roundNumber,
          matchNumber: matchIndex + 1,
          player1Id: pairing.player1.user_id,
          player2Id: pairing.player2.user_id,
          status: shouldRoundStartReady(tournament, roundNumber) ? "ready" : "pending",
        });
      }
    }

    await markTournamentLive(tournament.id);
    return true;
  }

  if (getOpenMatches(matches).length > 0) {
    throw new Error("Complete the active group or playoff matches first");
  }

  const playoffMatches = matches.filter((match) => match.round_number > groupStageRoundCount);

  if (!playoffMatches.length) {
    const stageState = getInternationalStyleStageState(
      groups,
      matches,
      tournament.tie_breaker,
      groupStageRoundCount
    );

    if (stageState.qualifiedParticipants.length < 2) {
      throw new Error("Not enough qualified participants to generate the playoff stage");
    }

    const upperPairings = getCrossGroupPairings(stageState.upperGroups);
    const lowerPairings = getCrossGroupPairings(stageState.lowerGroups);
    const playoffRoundNumber = groupStageRoundCount + 1;
    let matchNumber = 1;

    for (const [playerOne, playerTwo] of upperPairings.concat(lowerPairings)) {
      await insertMatchRecord({
        tournamentId: tournament.id,
        roundNumber: playoffRoundNumber,
        matchNumber,
        player1Id: playerOne?.user_id || null,
        player2Id: playerTwo?.user_id || null,
        status: shouldRoundStartReady(tournament, playoffRoundNumber) ? "ready" : "pending",
      });
      matchNumber += 1;
    }

    await markTournamentLive(tournament.id);
    return true;
  }

  const stageState = getInternationalStyleStageState(
    groups,
    matches,
    tournament.tie_breaker,
    groupStageRoundCount
  );
  const effectiveLossCounts = buildEffectiveLossCountMap(
    stageState.qualifiedParticipants,
    playoffMatches,
    stageState.baseLossCounts
  );
  const activeParticipants = stageState.qualifiedParticipants.filter(
    (participant) => (effectiveLossCounts.get(participant.user_id) || 0) < 2
  );

  if (activeParticipants.length <= 1) {
    return false;
  }

  const orderedParticipants = [...activeParticipants].sort((left, right) => {
    const lossDelta =
      (effectiveLossCounts.get(left.user_id) || 0) -
      (effectiveLossCounts.get(right.user_id) || 0);

    if (lossDelta !== 0) {
      return lossDelta;
    }

    return compareNullableNumber(left.seed, right.seed);
  });

  const pairings = buildPairingsFromOrderedParticipants(orderedParticipants, playoffMatches);
  const roundNumber = getMaxRoundNumber(matches) + 1;

  for (let index = 0; index < pairings.length; index += 1) {
    const [playerOne, playerTwo] = pairings[index];

    await insertMatchRecord({
      tournamentId: tournament.id,
      roundNumber,
      matchNumber: index + 1,
      player1Id: playerOne?.user_id || null,
      player2Id: playerTwo?.user_id || null,
      status: "ready",
    });
  }

  await markTournamentLive(tournament.id);
  return true;
}

async function generateGroupsPlayoffBracket(tournament) {
  const registrations = await loadParticipants(tournament.id);
  const registered = registrations.filter((entry) => entry.status === "registered");
  const matches = await loadMatches(tournament.id);

  if (registered.length < Math.max(4, tournament.min_participants || 2)) {
    throw new Error("At least 4 registered participants are required for groups + playoff");
  }

  const { sortedParticipants } = await resolveBracketOrdering(
    registrations,
    tournament.seeding_mode,
    tournament.id
  );
  const groups = buildSeededGroups(
    sortedParticipants,
    getGroupsPlayoffGroupCount(sortedParticipants.length)
  );
  const groupStageRoundCount = getGroupStageRoundCount(groups);

  if (!matches.length) {
    const matchesByRound = new Map();

    for (const group of groups) {
      const groupRounds = getRoundRobinRounds(group);

      for (let roundIndex = 0; roundIndex < groupRounds.length; roundIndex += 1) {
        const roundNumber = roundIndex + 1;
        const existingRound = matchesByRound.get(roundNumber) || [];
        matchesByRound.set(roundNumber, existingRound.concat(groupRounds[roundIndex]));
      }
    }

    for (const [roundNumber, pairings] of [...matchesByRound.entries()].sort(
      (left, right) => left[0] - right[0]
    )) {
      for (let matchIndex = 0; matchIndex < pairings.length; matchIndex += 1) {
        const pairing = pairings[matchIndex];

        await insertMatchRecord({
          tournamentId: tournament.id,
          roundNumber,
          matchNumber: matchIndex + 1,
          player1Id: pairing.player1.user_id,
          player2Id: pairing.player2.user_id,
          status: shouldRoundStartReady(tournament, roundNumber) ? "ready" : "pending",
        });
      }
    }

    await markTournamentLive(tournament.id);
    return true;
  }

  if (getOpenMatches(matches).length > 0) {
    throw new Error("Complete the active group or playoff matches first");
  }

  if (matches.some((match) => match.round_number > groupStageRoundCount)) {
    return false;
  }

  const qualifiers = [];

  for (const group of groups) {
    const groupParticipantIds = new Set(group.map((participant) => participant.user_id));
    const groupMatches = matches.filter(
      (match) =>
        match.round_number <= groupStageRoundCount &&
        groupParticipantIds.has(match.player1_id) &&
        groupParticipantIds.has(match.player2_id)
    );
    const standings = buildStandings(group, groupMatches, tournament.tie_breaker);
    const qualifiedCount = groups.length === 1 ? 2 : Math.min(2, standings.length);

    for (let index = 0; index < qualifiedCount; index += 1) {
      const participant = group.find(
        (entry) => entry.user_id === standings[index]?.participantId
      );

      if (participant) {
        qualifiers.push({
          ...participant,
          seed: qualifiers.length + 1,
        });
      }
    }
  }

  if (qualifiers.length < 2) {
    throw new Error("Not enough qualified participants to generate the playoff stage");
  }

  await insertSingleEliminationStage({
    tournament,
    participants: qualifiers,
    seedingMode: "protected",
    roundOffset: groupStageRoundCount,
  });

  await markTournamentLive(tournament.id);
  return true;
}

async function generateGslGroupBracket(tournament) {
  const registrations = await loadParticipants(tournament.id);
  const registered = registrations.filter((entry) => entry.status === "registered");
  const matches = await loadMatches(tournament.id);

  if (registered.length < Math.max(4, tournament.min_participants || 2)) {
    throw new Error("At least 4 registered participants are required for GSL groups");
  }

  const { sortedParticipants } = await resolveBracketOrdering(
    registrations,
    tournament.seeding_mode,
    tournament.id
  );
  const groups = buildSeededGroups(sortedParticipants, Math.max(1, Math.ceil(sortedParticipants.length / 4)));

  if (!matches.length) {
    const groupFallbackRounds = [];
    const gslOpeners = [];

    for (const group of groups) {
      if (group.length !== 4) {
        groupFallbackRounds.push(...getRoundRobinRounds(group));
        continue;
      }

      gslOpeners.push([
        { player1: group[0], player2: group[3] },
        { player1: group[1], player2: group[2] },
      ]);
    }

    if (gslOpeners.length > 0) {
      const flattenedOpeners = gslOpeners.flat();

      for (let matchIndex = 0; matchIndex < flattenedOpeners.length; matchIndex += 1) {
        const pairing = flattenedOpeners[matchIndex];

        await insertMatchRecord({
          tournamentId: tournament.id,
          roundNumber: 1,
          matchNumber: matchIndex + 1,
          player1Id: pairing.player1.user_id,
          player2Id: pairing.player2.user_id,
          status: "ready",
        });
      }
    }

    for (let roundIndex = 0; roundIndex < groupFallbackRounds.length; roundIndex += 1) {
      const roundNumber = roundIndex + 1;
      const pairings = groupFallbackRounds[roundIndex];

      for (let matchIndex = 0; matchIndex < pairings.length; matchIndex += 1) {
        const pairing = pairings[matchIndex];

        await insertMatchRecord({
          tournamentId: tournament.id,
          roundNumber,
          matchNumber: gslOpeners.flat().length + matchIndex + 1,
          player1Id: pairing.player1.user_id,
          player2Id: pairing.player2.user_id,
          status: shouldRoundStartReady(tournament, roundNumber) ? "ready" : "pending",
        });
      }
    }

    await markTournamentLive(tournament.id);
    return true;
  }

  if (getOpenMatches(matches).length > 0) {
    throw new Error("Complete the active GSL matches first");
  }

  const existingRoundTwo = matches.some((match) => match.round_number === 2);
  const existingRoundThree = matches.some((match) => match.round_number === 3);

  if (!existingRoundTwo) {
    const roundOneMatches = matches.filter((match) => match.round_number === 1);
    const roundTwoPairings = [];

    for (const group of groups.filter((entry) => entry.length === 4)) {
      const groupIds = new Set(group.map((participant) => participant.user_id));
      const groupRoundOneMatches = roundOneMatches.filter(
        (match) => groupIds.has(match.player1_id) && groupIds.has(match.player2_id)
      );

      if (groupRoundOneMatches.length < 2 || groupRoundOneMatches.some((match) => !match.winner_id)) {
        continue;
      }

      const winnersMatch = {
        player1: group.find((participant) => participant.user_id === groupRoundOneMatches[0].winner_id),
        player2: group.find((participant) => participant.user_id === groupRoundOneMatches[1].winner_id),
      };
      const eliminationMatch = {
        player1: group.find(
          (participant) =>
            participant.user_id !== groupRoundOneMatches[0].winner_id &&
            [groupRoundOneMatches[0].player1_id, groupRoundOneMatches[0].player2_id].includes(
              participant.user_id
            )
        ),
        player2: group.find(
          (participant) =>
            participant.user_id !== groupRoundOneMatches[1].winner_id &&
            [groupRoundOneMatches[1].player1_id, groupRoundOneMatches[1].player2_id].includes(
              participant.user_id
            )
        ),
      };

      roundTwoPairings.push(winnersMatch, eliminationMatch);
    }

    for (let matchIndex = 0; matchIndex < roundTwoPairings.length; matchIndex += 1) {
      const pairing = roundTwoPairings[matchIndex];

      await insertMatchRecord({
        tournamentId: tournament.id,
        roundNumber: 2,
        matchNumber: matchIndex + 1,
        player1Id: pairing.player1?.user_id || null,
        player2Id: pairing.player2?.user_id || null,
        status: "ready",
      });
    }

    if (roundTwoPairings.length > 0) {
      await markTournamentLive(tournament.id);
      return true;
    }
  }

  if (!existingRoundThree) {
    const roundTwoMatches = matches.filter((match) => match.round_number === 2);
    const roundThreePairings = [];

    for (const group of groups.filter((entry) => entry.length === 4)) {
      const groupIds = new Set(group.map((participant) => participant.user_id));
      const groupRoundTwoMatches = roundTwoMatches.filter(
        (match) => groupIds.has(match.player1_id) && groupIds.has(match.player2_id)
      );

      if (groupRoundTwoMatches.length < 2 || groupRoundTwoMatches.some((match) => !match.winner_id)) {
        continue;
      }

      const winnersMatch = groupRoundTwoMatches[0];
      const eliminationMatch = groupRoundTwoMatches[1];
      const deciderPlayers = [
        winnersMatch.player1_id === winnersMatch.winner_id
          ? winnersMatch.player2_id
          : winnersMatch.player1_id,
        eliminationMatch.winner_id,
      ]
        .map((participantId) => group.find((participant) => participant.user_id === participantId))
        .filter(Boolean);

      if (deciderPlayers.length === 2) {
        roundThreePairings.push({
          player1: deciderPlayers[0],
          player2: deciderPlayers[1],
        });
      }
    }

    for (let matchIndex = 0; matchIndex < roundThreePairings.length; matchIndex += 1) {
      const pairing = roundThreePairings[matchIndex];

      await insertMatchRecord({
        tournamentId: tournament.id,
        roundNumber: 3,
        matchNumber: matchIndex + 1,
        player1Id: pairing.player1?.user_id || null,
        player2Id: pairing.player2?.user_id || null,
        status: "ready",
      });
    }

    if (roundThreePairings.length > 0) {
      await markTournamentLive(tournament.id);
      return true;
    }
  }

  return false;
}

async function generateTournamentStructure(tournament) {
  switch (tournament.format) {
    case "single_elimination":
      await generateSingleEliminationBracket(tournament);
      return true;
    case "double_elimination":
      return generateDoubleEliminationRound(tournament);
    case "round_robin":
      await generateRoundRobinBracket(tournament, 1);
      return true;
    case "championship":
      await generateRoundRobinBracket(tournament, 2);
      return true;
    case "league_season":
      await generateRoundRobinBracket(tournament, 2);
      return true;
    case "swiss":
      return generateSwissRound(tournament);
    case "groups_playoff":
      return generateGroupsPlayoffBracket(tournament);
    case "international_style":
      return generateInternationalStyleBracket(tournament);
    case "ladder":
      return generateLadderRound(tournament);
    case "king_of_the_hill":
      return generateKingOfTheHillRound(tournament);
    case "gsl_group":
      return generateGslGroupBracket(tournament);
    default:
      throw new Error("Unsupported tournament format");
  }
}

function isRegistrationWindowOpen(tournament, now = new Date()) {
  const openedAt = tournament.registration_opens_at
    ? new Date(tournament.registration_opens_at)
    : null;
  const closesAt = tournament.registration_closes_at
    ? new Date(tournament.registration_closes_at)
    : null;

  if (openedAt && now.getTime() < openedAt.getTime()) {
    return false;
  }

  if (closesAt && now.getTime() > closesAt.getTime()) {
    return false;
  }

  return true;
}

function canUserSeeTournament(tournament, user) {
  if (!tournament) {
    return false;
  }

  if (tournament.visibility === "public") {
    return true;
  }

  if (tournament.visibility === "members_only") {
    return Boolean(user);
  }

  return Boolean(user && isAdminUser(user));
}

function assertTournamentCanGenerateBracket(tournament) {
  if (!tournament) {
    throw new Error("Tournament not found");
  }

  if (["cancelled", "completed"].includes(tournament.status)) {
    throw new Error("This tournament can no longer generate new rounds");
  }

  if (
    tournament.requires_check_in &&
    !["check_in", "seeding", "live"].includes(tournament.status)
  ) {
    throw new Error(
      "This tournament requires a check-in phase before bracket generation"
    );
  }
}

async function progressTournamentAfterMatch(tournamentId) {
  const tournament = await getTournamentById(tournamentId);

  if (!tournament) {
    return;
  }

  if (tournament.format === "single_elimination") {
    return;
  }

    if (
      [
        "round_robin",
        "championship",
        "league_season",
        "groups_playoff",
        "gsl_group",
      "international_style",
    ].includes(tournament.format)
  ) {
    const activatedNextRound = await activateNextPendingRoundIfPossible(tournamentId);

    if (activatedNextRound) {
      return;
    }
  }

  const refreshedMatches = await loadMatches(tournamentId);

  if (getOpenMatches(refreshedMatches).length > 0) {
    return;
  }

  if (tournament.format === "swiss") {
    await generateSwissRound(tournament);
    return;
  }

  if (tournament.format === "double_elimination") {
    await generateDoubleEliminationRound(tournament);
    return;
  }

  if (tournament.format === "king_of_the_hill") {
    await generateKingOfTheHillRound(tournament);
    return;
  }

  if (tournament.format === "ladder") {
    await generateLadderRound(tournament);
    return;
  }

  if (tournament.format === "groups_playoff") {
    await generateGroupsPlayoffBracket(tournament);
    return;
  }

  if (tournament.format === "international_style") {
    await generateInternationalStyleBracket(tournament);
    return;
  }

  if (tournament.format === "gsl_group") {
    await generateGslGroupBracket(tournament);
  }
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
      (data || [])
        .map((tournament) => normalizeTournament(tournament))
        .filter((tournament) => canUserSeeTournament(tournament, user))
        .map((tournament) => enrichTournament(tournament, user?.id || null))
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
    const user = await getOptionalAuthUser(req);
    const tournament = await getTournamentBySlug(req.params.slug);

    if (tournament && !canUserSeeTournament(tournament, user)) {
      return res.status(404).json({ error: "Tournament not found" });
    }

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

    if (tournament && !canUserSeeTournament(tournament, user)) {
      return res.status(404).json({ error: "Tournament not found" });
    }

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

    if (!isRegistrationWindowOpen(tournament)) {
      return res.status(400).json({ error: "Registration window is not open" });
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

    const status =
      tournament.signup_mode === "approval" ? "pending" : "registered";

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

    if (tournament.evidence_mode === "required" && !evidenceNote) {
      return res.status(400).json({ error: "Evidence is required for this tournament" });
    }

    validateReportedScore(tournament.best_of || 3, player1Wins, player2Wins);

    const winnerId = player1Wins > player2Wins ? match.player1_id : match.player2_id;

    if (
      tournament.result_confirmation_mode === "auto_on_same_report" &&
      normalizeMatchStatus(match.status) === "awaiting_confirmation" &&
      match.reported_by_id &&
      match.reported_by_id !== req.user.id
    ) {
      const sameScore =
        match.player1_wins === player1Wins &&
        match.player2_wins === player2Wins &&
        match.pending_winner_id === winnerId;

      if (sameScore) {
        await supabase
          .from("tournament_matches")
          .update({
            confirmed_by_id: req.user.id,
            updated_at: new Date().toISOString(),
          })
          .eq("id", match.id);

        await finalizeMatch({
          match,
          winnerId,
          player1Wins,
          player2Wins,
          resolutionType: "played",
        });

        return res.json({ ok: true, autoConfirmed: true });
      }

      const { error: disputedUpdateError } = await supabase
        .from("tournament_matches")
        .update({
          status: "disputed",
          dispute_reason: "The two player reports do not match.",
          updated_at: new Date().toISOString(),
        })
        .eq("id", match.id);

      if (disputedUpdateError) throw disputedUpdateError;

      return res.json({ ok: true, disputed: true });
    }

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
    const bannerUrl = optionalHttpUrl(req.body.banner_url, "banner_url");
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
        banner_url: bannerUrl,
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

    if (autoGenerateBracket && !normalizedTournament.requires_check_in) {
      await generateTournamentStructure(normalizedTournament);
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

router.post("/admin/update-participant", requireAdmin, async (req, res) => {
  try {
    const registrationId = optionalText(req.body.registration_id, 120);

    if (!registrationId) {
      return res.status(400).json({ error: "registration_id is required" });
    }

    const existingRegistration = await getRegistrationById(registrationId);

    if (!existingRegistration) {
      return res.status(404).json({ error: "Registration not found" });
    }

    const tournament = await getTournamentById(existingRegistration.tournament_id);

    if (!tournament) {
      return res.status(404).json({ error: "Tournament not found" });
    }

    const nextStatus = parseEnum(req.body.status, REGISTRATION_STATUSES, {
      name: "status",
      fallback: existingRegistration.status,
    });
    const nextSeed = parseOptionalSeed(req.body.seed);
    const hasBracket = await tournamentHasGeneratedBracket(tournament.id, tournament);
    const rosterChanged =
      nextStatus !== existingRegistration.status || nextSeed !== existingRegistration.seed;

    if (hasBracket && rosterChanged) {
      return res.status(409).json({
        error:
          "Roster and seeding changes are blocked after bracket generation. Pause or rebuild the bracket first.",
      });
    }

    if (nextStatus === "registered" && existingRegistration.status !== "registered") {
      const participantCount = await getRegistrationCount(tournament.id, ["registered"]);

      if (participantCount >= tournament.max_participants) {
        return res.status(400).json({ error: "Tournament is full" });
      }
    }

    const approvedAt =
      nextStatus === "registered"
        ? existingRegistration.approved_at || new Date().toISOString()
        : null;
    const approvedByProfileId =
      nextStatus === "registered" ? existingRegistration.approved_by_profile_id || req.user?.id || null : null;

    const { data, error } = await supabase
      .from("tournament_registrations")
      .update({
        status: nextStatus,
        seed: nextSeed,
        approved_at: approvedAt,
        approved_by_profile_id: approvedByProfileId,
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

    return res.json({
      ok: true,
      registration: data,
    });
  } catch (error) {
    console.error("POST /admin/update-participant error:", error);
    return res.status(500).json({ error: error.message || "Failed to update participant" });
  }
});

router.post("/admin/remove-participant", requireAdmin, async (req, res) => {
  try {
    const registrationId = optionalText(req.body.registration_id, 120);

    if (!registrationId) {
      return res.status(400).json({ error: "registration_id is required" });
    }

    const existingRegistration = await getRegistrationById(registrationId);

    if (!existingRegistration) {
      return res.status(404).json({ error: "Registration not found" });
    }

    const tournament = await getTournamentById(existingRegistration.tournament_id);

    if (!tournament) {
      return res.status(404).json({ error: "Tournament not found" });
    }

    const hasBracket = await tournamentHasGeneratedBracket(tournament.id, tournament);

    if (hasBracket) {
      return res.status(409).json({
        error:
          "Participants cannot be removed after bracket generation. Reset the bracket before editing the roster.",
      });
    }

    const { error } = await supabase
      .from("tournament_registrations")
      .delete()
      .eq("id", registrationId);

    if (error) throw error;

    return res.json({
      ok: true,
      removed_registration_id: registrationId,
    });
  } catch (error) {
    console.error("POST /admin/remove-participant error:", error);
    return res.status(500).json({ error: error.message || "Failed to remove participant" });
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

    assertTournamentCanGenerateBracket(tournament);
    await generateTournamentStructure(tournament);
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
