function generateCode(roomStore) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code = "";
  do {
    code = "";
    for (let i = 0; i < 5; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (roomStore.has(code));

  return code;
}

function sortPlayers(players) {
  return [...players].sort((a, b) => b.score - a.score);
}

function sanitizePlayer(player) {
  return {
    id: player.id,
    name: player.name,
    score: player.score,
    connected: player.connected,
    sessionId: player.sessionId,
  };
}

function pickHost(room) {
  const connectedPlayer = room.players.find((p) => p.connected);
  if (connectedPlayer) {
    room.hostId = connectedPlayer.id;
  }
}

function getRoomAndPlayer(roomStore, code, socketId) {
  const roomCode = String(code || "").trim().toUpperCase();
  const room = roomStore.get(roomCode);

  if (!room) {
    return { roomCode, room: null, player: null };
  }

  const player =
    room.players.find((entry) => entry.id === socketId) || null;

  return { roomCode, room, player };
}

function ensureValidCategories(rawCategories, QUESTION_CATEGORIES) {
  const validIds = QUESTION_CATEGORIES.map((c) => c.id);

  if (!Array.isArray(rawCategories) || rawCategories.length === 0) {
    return validIds;
  }

  const filtered = rawCategories.filter((c) => validIds.includes(c));
  return filtered.length > 0 ? filtered : validIds;
}

module.exports = {
  generateCode,
  sortPlayers,
  sanitizePlayer,
  pickHost,
  getRoomAndPlayer,
  ensureValidCategories,
};