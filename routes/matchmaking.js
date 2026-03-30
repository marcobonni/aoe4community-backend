const express = require("express");

const router = express.Router();

const SEARCH_CANDIDATE_LIMIT = 5;

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function getModeField(mode) {
  if (mode === "1v1") return "rm_1v1_elo";
  if (mode === "2v2") return "rm_2v2_elo";
  if (mode === "3v3") return "rm_3v3_elo";
  return "rm_4v4_elo";
}

function getRatingFromProfile(profile, mode) {
  const field = getModeField(mode);

  if (profile?.[field]?.rating != null) {
    return Number(profile[field].rating) || 0;
  }

  if (mode === "1v1") {
    return (
      Number(profile?.modes?.rm_1v1_elo?.rating) ||
      Number(profile?.modes?.rm_solo?.rating) ||
      0
    );
  }

  if (mode === "2v2") {
    return (
      Number(profile?.modes?.rm_2v2_elo?.rating) ||
      Number(profile?.modes?.rm_team?.rating) ||
      0
    );
  }

  if (mode === "3v3") {
    return (
      Number(profile?.modes?.rm_3v3_elo?.rating) ||
      Number(profile?.modes?.rm_team?.rating) ||
      0
    );
  }

  return (
    Number(profile?.modes?.rm_4v4_elo?.rating) ||
    Number(profile?.modes?.rm_team?.rating) ||
    0
  );
}

function getStringSimilarityScore(queryNormalized, candidateNormalized) {
  if (!queryNormalized || !candidateNormalized) return 0;

  if (queryNormalized === candidateNormalized) return 1000;

  let score = 0;

  if (candidateNormalized.startsWith(queryNormalized)) {
    score += 400;
  }

  if (candidateNormalized.includes(queryNormalized)) {
    score += 250;
  }

  if (queryNormalized.includes(candidateNormalized)) {
    score += 150;
  }

  const lengthDiff = Math.abs(candidateNormalized.length - queryNormalized.length);
  score -= lengthDiff * 5;

  let commonPrefix = 0;
  const maxPrefix = Math.min(queryNormalized.length, candidateNormalized.length);

  for (let i = 0; i < maxPrefix; i += 1) {
    if (queryNormalized[i] !== candidateNormalized[i]) break;
    commonPrefix += 1;
  }

  score += commonPrefix * 20;

  return score;
}

function scoreSearchResult(query, item) {
  const raw = String(query || "").trim();
  const lowered = raw.toLowerCase();
  const normalized = normalizeName(raw);

  const candidateName = String(item?.name || "");
  const candidateLowered = candidateName.toLowerCase();
  const candidateNormalized = normalizeName(candidateName);
  const candidateCountry = String(item?.country || "").toLowerCase();

  let score = 0;

  if (candidateLowered === lowered) {
    score += 5000;
  }

  if (candidateNormalized === normalized) {
    score += 3500;
  }

  score += getStringSimilarityScore(normalized, candidateNormalized);

  if (candidateCountry === "it") {
    score += 1200;
  }

  return score;
}

function rankInitialSearchResults(query, results) {
  return results
    .map((item) => ({
      item,
      searchScore: scoreSearchResult(query, item),
    }))
    .sort((a, b) => b.searchScore - a.searchScore);
}

async function fetchPlayerProfile(profileId) {
  const response = await fetch(
    `https://aoe4world.com/api/v0/players/${profileId}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Profilo non trovato per ID ${profileId}`);
  }

  return response.json();
}

function scoreResolvedCandidate({ query, mode, searchScore, searchItem, profile }) {
  const raw = String(query || "").trim();
  const lowered = raw.toLowerCase();
  const normalized = normalizeName(raw);

  const profileName = String(profile?.name || searchItem?.name || "");
  const profileLowered = profileName.toLowerCase();
  const profileNormalized = normalizeName(profileName);
  const profileCountry = String(
    profile?.country || searchItem?.country || ""
  ).toLowerCase();

  const elo = getRatingFromProfile(profile, mode);

  let score = searchScore;

  if (profileLowered === lowered) {
    score += 7000;
  }

  if (profileNormalized === normalized) {
    score += 5000;
  }

  score += getStringSimilarityScore(normalized, profileNormalized);

  if (profileCountry === "it") {
    score += 2500;
  }

  if (elo > 0) {
    score += 1800;
  } else {
    score -= 1500;
  }

  return {
    score,
    elo,
  };
}

async function searchPlayerByName(name, mode) {
  const response = await fetch(
    `https://aoe4world.com/api/v0/players/search?query=${encodeURIComponent(name)}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Ricerca fallita per "${name}"`);
  }

  const payload = await response.json();

  let results = [];
  if (Array.isArray(payload)) {
    results = payload;
  } else if (Array.isArray(payload?.players)) {
    results = payload.players;
  } else if (Array.isArray(payload?.results)) {
    results = payload.results;
  }

  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }

  const rankedSearchResults = rankInitialSearchResults(name, results).slice(
    0,
    SEARCH_CANDIDATE_LIMIT
  );

  const resolvedCandidates = await Promise.all(
    rankedSearchResults.map(async ({ item, searchScore }) => {
      if (!item?.profile_id) return null;

      try {
        const profileId = Number(item.profile_id);
        const profile = await fetchPlayerProfile(profileId);
        const scored = scoreResolvedCandidate({
          query: name,
          mode,
          searchScore,
          searchItem: item,
          profile,
        });

        return {
          profileId,
          matchedName: profile?.name || item?.name || name,
          country: profile?.country ?? item?.country ?? null,
          profile,
          elo: scored.elo,
          score: scored.score,
        };
      } catch {
        return null;
      }
    })
  );

  const validCandidates = resolvedCandidates
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (validCandidates.length === 0) {
    return null;
  }

  return validCandidates[0];
}

function getWinProbabilities(averageA, averageB) {
  const probabilityA = 1 / (1 + Math.pow(10, (averageB - averageA) / 400));
  const probabilityB = 1 - probabilityA;

  return {
    teamAWinProbability: Number((probabilityA * 100).toFixed(1)),
    teamBWinProbability: Number((probabilityB * 100).toFixed(1)),
  };
}

function balanceTeams(players) {
  if (!Array.isArray(players) || players.length < 2 || players.length % 2 !== 0) {
    return null;
  }

  const ordered = [...players].sort((a, b) => b.elo - a.elo);
  const teamSize = ordered.length / 2;
  const totalAll = ordered.reduce((sum, player) => sum + player.elo, 0);

  let bestMask = 0;
  let bestDiff = Number.POSITIVE_INFINITY;

  function search(startIndex, pickedCount, mask, totalA) {
    if (pickedCount === teamSize) {
      const totalB = totalAll - totalA;
      const diff = Math.abs(totalA - totalB);

      if (diff < bestDiff) {
        bestDiff = diff;
        bestMask = mask;
      }

      return;
    }

    for (let i = startIndex; i < ordered.length; i += 1) {
      if ((mask & (1 << i)) !== 0) continue;

      search(i + 1, pickedCount + 1, mask | (1 << i), totalA + ordered[i].elo);
    }
  }

  search(1, 1, 1 << 0, ordered[0].elo);

  const teamA = [];
  const teamB = [];

  ordered.forEach((player, index) => {
    if ((bestMask & (1 << index)) !== 0) {
      teamA.push(player);
    } else {
      teamB.push(player);
    }
  });

  const totalA = teamA.reduce((sum, player) => sum + player.elo, 0);
  const totalB = teamB.reduce((sum, player) => sum + player.elo, 0);
  const averageA = Math.round(totalA / teamA.length);
  const averageB = Math.round(totalB / teamB.length);
  const winProbabilities = getWinProbabilities(averageA, averageB);

  return {
    teamA,
    teamB,
    totalA,
    totalB,
    averageA,
    averageB,
    diff: Math.abs(totalA - totalB),
    ...winProbabilities,
  };
}

router.post("/balance-from-names", async (req, res) => {
  try {
    const { mode = "2v2", names = [] } = req.body || {};

    if (!Array.isArray(names) || names.length === 0) {
      return res.status(400).json({
        error: "Inserisci almeno un nome.",
      });
    }

    const cleanedNames = names
      .map((name) => String(name || "").trim())
      .filter(Boolean);

    if (cleanedNames.length < 2) {
      return res.status(400).json({
        error: "Servono almeno 2 giocatori.",
      });
    }

    if (cleanedNames.length % 2 !== 0) {
      return res.status(400).json({
        error: "Il numero di giocatori deve essere pari.",
      });
    }

    const resolvedPlayers = [];
    const unresolved = [];

    for (const name of cleanedNames) {
      if (name.length < 3) {
        unresolved.push({
          input: name,
          reason: "Il nome deve avere almeno 3 caratteri.",
        });
        continue;
      }

      try {
        const found = await searchPlayerByName(name, mode);

        if (!found?.profileId) {
          unresolved.push({
            input: name,
            reason: "Nessun profilo trovato.",
          });
          continue;
        }

        const elo = Number(found.elo) || 0;

        resolvedPlayers.push({
          input: name,
          profileId: found.profileId,
          name: found.profile?.name || found.matchedName || name,
          elo,
          country: found.profile?.country ?? found.country ?? null,
          avatarUrl: found.profile?.avatar_url ?? found.profile?.avatar ?? null,
        });
      } catch (error) {
        unresolved.push({
          input: name,
          reason:
            error instanceof Error ? error.message : "Errore durante la ricerca.",
        });
      }
    }

    if (unresolved.length > 0) {
      return res.status(400).json({
        error: "Alcuni nomi non sono stati risolti.",
        unresolved,
        resolvedPlayers,
      });
    }

    const result = balanceTeams(resolvedPlayers);

    if (!result) {
      return res.status(400).json({
        error: "Impossibile creare squadre bilanciate con questi giocatori.",
      });
    }

    return res.json({
      mode,
      players: resolvedPlayers,
      ...result,
    });
  } catch (error) {
    return res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Errore interno durante il matchmaking.",
    });
  }
});

module.exports = router;