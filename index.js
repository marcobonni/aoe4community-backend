
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { QUESTIONS, QUESTION_CATEGORIES } = require("./questions");

const DIFFICULTY_MULTIPLIERS = {
  easy: 1,
  medium: 1.5,
  hard: 2,
};

const app = express();
app.use(cors());

app.get("/", (_req, res) => {
  res.send("Beasty server awake");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/meta", (_req, res) => {
  res.json({
    ok: true,
    categories: QUESTION_CATEGORIES,
    questionCount: QUESTIONS.length,
    difficultyMultipliers: DIFFICULTY_MULTIPLIERS,
  });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000",
      "https://epicojackalaoe4community.vercel.app",
      "https://aoe4community.vercel.app",
    ],
  },
});

const rooms = {};

function generateCode() {
  let code = "";
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  for (let i = 0; i < 5; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return code;
}

function shuffleArray(items) {
  const cloned = [...items];

  for (let i = cloned.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [cloned[i], cloned[j]] = [cloned[j], cloned[i]];
  }

  return cloned;
}

function shuffleQuestionOptions(question) {
  const optionsWithIndex = question.options.map((option, index) => ({
    option,
    originalIndex: index,
  }));

  const shuffledOptions = shuffleArray(optionsWithIndex);
  const nextCorrectIndex = shuffledOptions.findIndex(
    (entry) => entry.originalIndex === question.correctIndex
  );

  return {
    ...question,
    options: shuffledOptions.map((entry) => entry.option),
    correctIndex: nextCorrectIndex,
  };
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

function sanitizeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    players: room.players.map(sanitizePlayer),
    state: room.state,
    currentQuestionIndex: room.currentQuestionIndex,
    settings: room.settings,
  };
}

function getDifficultyMultiplier(difficulty) {
  return DIFFICULTY_MULTIPLIERS[difficulty] ?? 1;
}

function clearExistingTimeouts(room) {
  if (room.questionTimeout) {
    clearTimeout(room.questionTimeout);
    room.questionTimeout = null;
  }

  if (room.revealTimeout) {
    clearTimeout(room.revealTimeout);
    room.revealTimeout = null;
  }
}

function emitRoomUpdate(code) {
  const room = rooms[code];
  if (!room) return;

  io.to(code).emit("room:updated", sanitizeRoom(room));
}

function pickHost(room) {
  const connectedPlayer = room.players.find((player) => player.connected);
  if (connectedPlayer) {
    room.hostId = connectedPlayer.id;
  }
}

function buildQuestionPool(room) {
  const selectedCategories =
    room.settings?.categories?.length > 0
      ? room.settings.categories
      : QUESTION_CATEGORIES.map((category) => category.id);

  const filtered = QUESTIONS.filter((question) =>
    selectedCategories.includes(question.category)
  );

  const shuffledQuestions = shuffleArray(filtered).map(shuffleQuestionOptions);
  const desiredCount = Math.min(room.settings.totalQuestions, shuffledQuestions.length);

  return shuffledQuestions.slice(0, desiredCount);
}

function getCurrentQuestion(room) {
  return room.gameQuestions[room.currentQuestionIndex] || null;
}

function finishGame(code) {
  const room = rooms[code];
  if (!room) return;

  clearExistingTimeouts(room);
  room.state = "finished";

  io.to(code).emit("game:finished", {
    room: sanitizeRoom(room),
    players: sortPlayers(room.players).map(sanitizePlayer),
  });

  emitRoomUpdate(code);
}

function revealAnswer(code) {
  const room = rooms[code];
  if (!room || room.state !== "question") return;

  clearExistingTimeouts(room);

  const question = getCurrentQuestion(room);
  if (!question) {
    finishGame(code);
    return;
  }

  const difficultyMultiplier = getDifficultyMultiplier(question.difficulty);

  room.state = "reveal";

  io.to(code).emit("game:reveal", {
    room: sanitizeRoom(room),
    question: {
      id: question.id,
      category: question.category,
      difficulty: question.difficulty,
      text: question.text,
      options: question.options,
      durationMs: question.durationMs,
    },
    difficultyMultiplier,
    correctIndex: question.correctIndex,
    correctAnswer: question.options[question.correctIndex],
    players: sortPlayers(room.players).map(sanitizePlayer),
  });

  emitRoomUpdate(code);

  room.revealTimeout = setTimeout(() => {
    room.currentQuestionIndex += 1;

    if (room.currentQuestionIndex >= room.gameQuestions.length) {
      finishGame(code);
      return;
    }

    startQuestion(code);
  }, 3000);
}

function startQuestion(code) {
  const room = rooms[code];
  if (!room) return;

  clearExistingTimeouts(room);

  const question = getCurrentQuestion(room);
  if (!question) {
    finishGame(code);
    return;
  }

  const difficultyMultiplier = getDifficultyMultiplier(question.difficulty);

  room.state = "question";
  room.roundStartedAt = Date.now();
  room.doublePoints = Math.random() < 0.25;

  room.players.forEach((player) => {
    player.answered = false;
  });

  io.to(code).emit("game:question", {
    room: sanitizeRoom(room),
    question: {
      id: question.id,
      category: question.category,
      difficulty: question.difficulty,
      text: question.text,
      options: question.options,
      durationMs: question.durationMs,
    },
    startedAt: room.roundStartedAt,
    doublePoints: room.doublePoints,
    difficultyMultiplier,
  });

  emitRoomUpdate(code);

  room.questionTimeout = setTimeout(() => {
    revealAnswer(code);
  }, question.durationMs);
}

function resetRoomForNewGame(room) {
  clearExistingTimeouts(room);
  room.state = "lobby";
  room.currentQuestionIndex = 0;
  room.roundStartedAt = null;
  room.doublePoints = false;
  room.gameQuestions = [];

  room.players.forEach((player) => {
    player.score = 0;
    player.answered = false;
  });
}

function ensureValidCategories(rawCategories) {
  const validIds = QUESTION_CATEGORIES.map((category) => category.id);

  if (!Array.isArray(rawCategories) || rawCategories.length === 0) {
    return validIds;
  }

  const filtered = rawCategories.filter((category) => validIds.includes(category));
  return filtered.length > 0 ? filtered : validIds;
}

function getRoomAndPlayer(code, socketId) {
  const roomCode = String(code || "").trim().toUpperCase();
  const room = rooms[roomCode];

  if (!room) {
    return { roomCode, room: null, player: null };
  }

  const player = room.players.find((entry) => entry.id === socketId) || null;
  return { roomCode, room, player };
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("room:create", ({ name, playerSessionId, settings }, callback) => {
    const trimmedName = String(name || "").trim();
    const trimmedSessionId = String(playerSessionId || "").trim();

    if (!trimmedName) {
      callback?.({ ok: false, error: "Inserisci un nome valido." });
      return;
    }

    if (!trimmedSessionId) {
      callback?.({ ok: false, error: "Sessione giocatore non valida." });
      return;
    }

    let code = generateCode();
    while (rooms[code]) {
      code = generateCode();
    }

    const categories = ensureValidCategories(settings?.categories);
    const totalQuestions = Math.max(
      5,
      Math.min(20, Number(settings?.totalQuestions || 10))
    );

    rooms[code] = {
      code,
      hostId: socket.id,
      players: [
        {
          id: socket.id,
          name: trimmedName,
          sessionId: trimmedSessionId,
          score: 0,
          answered: false,
          connected: true,
        },
      ],
      state: "lobby",
      currentQuestionIndex: 0,
      roundStartedAt: null,
      questionTimeout: null,
      revealTimeout: null,
      doublePoints: false,
      gameQuestions: [],
      settings: {
        categories,
        totalQuestions,
      },
    };

    socket.join(code);

    callback?.({ ok: true, room: sanitizeRoom(rooms[code]) });
    emitRoomUpdate(code);
  });

  socket.on("room:join", ({ code, name, playerSessionId }, callback) => {
    const roomCode = String(code || "").trim().toUpperCase();
    const trimmedName = String(name || "").trim();
    const trimmedSessionId = String(playerSessionId || "").trim();
    const room = rooms[roomCode];

    if (!room) {
      callback?.({ ok: false, error: "Stanza non trovata." });
      return;
    }

    if (!trimmedName) {
      callback?.({ ok: false, error: "Inserisci un nome valido." });
      return;
    }

    if (!trimmedSessionId) {
      callback?.({ ok: false, error: "Sessione giocatore non valida." });
      return;
    }

    const existingPlayerBySession = room.players.find(
      (player) => player.sessionId === trimmedSessionId
    );

    if (existingPlayerBySession) {
      existingPlayerBySession.id = socket.id;
      existingPlayerBySession.name = trimmedName;
      existingPlayerBySession.connected = true;

      socket.join(roomCode);
      callback?.({ ok: true, room: sanitizeRoom(room), rejoined: true });
      emitRoomUpdate(roomCode);
      return;
    }

    if (room.state !== "lobby") {
      callback?.({
        ok: false,
        error: "La partita è già iniziata. Può rientrare solo chi era già dentro.",
      });
      return;
    }

    room.players.push({
      id: socket.id,
      name: trimmedName,
      sessionId: trimmedSessionId,
      score: 0,
      answered: false,
      connected: true,
    });

    socket.join(roomCode);

    callback?.({ ok: true, room: sanitizeRoom(room), rejoined: false });
    emitRoomUpdate(roomCode);
  });

  socket.on("room:update-settings", ({ code, settings }, callback) => {
    const { roomCode, room, player } = getRoomAndPlayer(code, socket.id);

    if (!room || !player) {
      callback?.({ ok: false, error: "Stanza o giocatore non trovato." });
      return;
    }

    if (room.hostId !== socket.id) {
      callback?.({ ok: false, error: "Solo l'host può modificare le impostazioni." });
      return;
    }

    if (room.state !== "lobby") {
      callback?.({ ok: false, error: "Le impostazioni si cambiano solo in lobby." });
      return;
    }

    room.settings = {
      categories: ensureValidCategories(settings?.categories),
      totalQuestions: Math.max(
        5,
        Math.min(20, Number(settings?.totalQuestions || room.settings.totalQuestions || 10))
      ),
    };

    emitRoomUpdate(roomCode);
    callback?.({ ok: true, room: sanitizeRoom(room) });
  });

  socket.on("game:start", ({ code }, callback) => {
    const { roomCode, room, player } = getRoomAndPlayer(code, socket.id);

    if (!room || !player) {
      callback?.({ ok: false, error: "Stanza o giocatore non trovato." });
      return;
    }

    if (room.hostId !== socket.id) {
      callback?.({ ok: false, error: "Solo l'host può avviare la partita." });
      return;
    }

    room.currentQuestionIndex = 0;
    room.players.forEach((entry) => {
      entry.score = 0;
      entry.answered = false;
    });

    room.gameQuestions = buildQuestionPool(room);

    if (room.gameQuestions.length === 0) {
      callback?.({
        ok: false,
        error: "Nessuna domanda disponibile con le categorie selezionate.",
      });
      return;
    }

    startQuestion(roomCode);
    callback?.({ ok: true });
  });

  socket.on("game:rematch", ({ code }, callback) => {
    const { roomCode, room, player } = getRoomAndPlayer(code, socket.id);

    if (!room || !player) {
      callback?.({ ok: false, error: "Stanza o giocatore non trovato." });
      return;
    }

    if (room.hostId !== socket.id) {
      callback?.({ ok: false, error: "Solo l'host può avviare la rivincita." });
      return;
    }

    resetRoomForNewGame(room);
    emitRoomUpdate(roomCode);
    callback?.({ ok: true });
  });

  socket.on("answer:submit", ({ code, answerIndex, questionId }, callback) => {
    const { roomCode, room, player } = getRoomAndPlayer(code, socket.id);

    if (!room || !player) {
      callback?.({ ok: false, error: "Stanza o giocatore non trovato." });
      return;
    }

    if (room.state !== "question") {
      callback?.({ ok: false, error: "Nessuna domanda attiva." });
      return;
    }

    const question = getCurrentQuestion(room);
    if (!question) {
      callback?.({ ok: false, error: "Domanda non trovata." });
      return;
    }

    if (player.answered) {
      callback?.({ ok: false, error: "Hai già risposto." });
      return;
    }

    if (question.id !== questionId) {
      callback?.({ ok: false, error: "Domanda non valida." });
      return;
    }

    if (
      !Number.isInteger(answerIndex) ||
      answerIndex < 0 ||
      answerIndex >= question.options.length
    ) {
      callback?.({ ok: false, error: "Risposta non valida." });
      return;
    }

    player.answered = true;

    const elapsed = Date.now() - room.roundStartedAt;
    const isCorrect = Number(answerIndex) === question.correctIndex;

    if (isCorrect) {
      const speedBonus = Math.max(0, 50 - Math.floor(elapsed / 150));
      const baseScore = 50 + speedBonus;
      const difficultyMultiplier = getDifficultyMultiplier(question.difficulty);
      const scoreWithDifficulty = Math.round(baseScore * difficultyMultiplier);
      const finalScore = room.doublePoints
        ? scoreWithDifficulty * 2
        : scoreWithDifficulty;

      player.score += finalScore;
    }

    callback?.({
      ok: true,
      isCorrect,
      correctIndex: question.correctIndex,
    });

    io.to(roomCode).emit("scoreboard:updated", {
      players: sortPlayers(room.players).map(sanitizePlayer),
    });

    const activePlayers = room.players.filter((entry) => entry.connected);
    const everyoneAnswered =
      activePlayers.length > 0 && activePlayers.every((entry) => entry.answered);

    if (everyoneAnswered) {
      revealAnswer(roomCode);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    Object.values(rooms).forEach((room) => {
      const player = room.players.find((entry) => entry.id === socket.id);

      if (!player) return;

      player.connected = false;

      if (room.hostId === socket.id) {
        pickHost(room);
      }

      emitRoomUpdate(room.code);
    });
  });
});

const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});