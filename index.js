const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const matchmakingRouter = require("./routes/matchmaking");
const { QUESTIONS, QUESTION_CATEGORIES } = require("./questions");

const DIFFICULTY_MULTIPLIERS = {
  easy: 1,
  medium: 1.5,
  hard: 2,
};

const REVEAL_DURATION_MS = 4000;
const TIMER_TICK_MS = 250;

const app = express();

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "https://epicojackalaoe4community.vercel.app",
      "https://aoe4community.vercel.app",
    ],
    credentials: true,
  })
);

app.use(express.json());

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

app.use("/matchmaking", matchmakingRouter);

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000",
      "https://epicojackalaoe4community.vercel.app",
      "https://aoe4community.vercel.app",
    ],
    credentials: true,
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

function getRemainingQuestionTime(room, question) {
  if (!room || !question || !room.roundStartedAt) {
    return question?.durationMs ?? 0;
  }

  const pausedExtraMs = room.isPaused && room.pausedAt
    ? Date.now() - room.pausedAt
    : 0;

  const elapsed =
    Date.now() -
    room.roundStartedAt -
    (room.pauseAccumulatedMs || 0) -
    pausedExtraMs;

  return Math.max(0, question.durationMs - elapsed);
}

function getRemainingRevealTime(room) {
  if (!room || !room.revealStartedAt) {
    return REVEAL_DURATION_MS;
  }

  const pausedExtraMs = room.isPaused && room.pausedAt
    ? Date.now() - room.pausedAt
    : 0;

  const elapsed =
    Date.now() -
    room.revealStartedAt -
    (room.pauseAccumulatedMs || 0) -
    pausedExtraMs;

  return Math.max(0, REVEAL_DURATION_MS - elapsed);
}

function sanitizeRoom(room) {
  const currentQuestion = getCurrentQuestion(room);

  return {
    code: room.code,
    hostId: room.hostId,
    players: room.players.map(sanitizePlayer),
    state: room.state,
    currentQuestionIndex: room.currentQuestionIndex,
    settings: room.settings,
    isPaused: room.isPaused,
    remainingMs:
      room.state === "question" && currentQuestion
        ? getRemainingQuestionTime(room, currentQuestion)
        : room.state === "reveal"
        ? getRemainingRevealTime(room)
        : null,
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

  if (room.questionTicker) {
    clearInterval(room.questionTicker);
    room.questionTicker = null;
  }

  if (room.revealTicker) {
    clearInterval(room.revealTicker);
    room.revealTicker = null;
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
  const desiredCount = Math.min(
    room.settings.totalQuestions,
    shuffledQuestions.length
  );

  return shuffledQuestions.slice(0, desiredCount);
}

function getCurrentQuestion(room) {
  return room.gameQuestions[room.currentQuestionIndex] || null;
}

function getAnswerMarkers(room) {
  return Object.entries(room.currentAnswers || {}).map(
    ([playerId, answerIndex]) => {
      const player = room.players.find((entry) => entry.id === playerId);

      return {
        playerId,
        playerName: player?.name ?? "Giocatore",
        answerIndex,
      };
    }
  );
}

function getRoundResults(room) {
  return Object.values(room.currentRoundResults || {}).sort(
    (a, b) => b.totalScore - a.totalScore
  );
}

function getFinalResults(room) {
  return sortPlayers(room.players).map((player) => {
    const stats = room.playerStats[player.id] || {
      correctAnswers: 0,
      wrongAnswers: 0,
      answeredQuestions: 0,
      totalPointsEarned: 0,
      totalResponseTimeMs: 0,
      rounds: [],
    };

    const avgResponseTimeMs =
      stats.answeredQuestions > 0
        ? Math.round(stats.totalResponseTimeMs / stats.answeredQuestions)
        : 0;

    return {
      playerId: player.id,
      playerName: player.name,
      finalScore: player.score,
      correctAnswers: stats.correctAnswers,
      wrongAnswers: stats.wrongAnswers,
      answeredQuestions: stats.answeredQuestions,
      accuracy:
        stats.answeredQuestions > 0
          ? Math.round((stats.correctAnswers / stats.answeredQuestions) * 100)
          : 0,
      totalPointsEarned: stats.totalPointsEarned,
      avgResponseTimeMs,
      rounds: stats.rounds,
    };
  });
}

function finishGame(code) {
  const room = rooms[code];
  if (!room) return;

  clearExistingTimeouts(room);
  room.state = "finished";
  room.isPaused = false;
  room.pausedAt = null;
  room.pauseAccumulatedMs = 0;

  io.to(code).emit("game:finished", {
    room: sanitizeRoom(room),
    players: sortPlayers(room.players).map(sanitizePlayer),
    finalResults: getFinalResults(room),
  });

  emitRoomUpdate(code);
}

function startRevealTicker(code) {
  const room = rooms[code];
  if (!room) return;

  if (room.revealTicker) {
    clearInterval(room.revealTicker);
    room.revealTicker = null;
  }

  room.revealTicker = setInterval(() => {
    const currentRoom = rooms[code];
    if (!currentRoom) {
      clearInterval(room.revealTicker);
      room.revealTicker = null;
      return;
    }

    if (currentRoom.state !== "reveal") {
      clearInterval(currentRoom.revealTicker);
      currentRoom.revealTicker = null;
      return;
    }

    const remainingMs = getRemainingRevealTime(currentRoom);

    io.to(code).emit("game:timer", {
      phase: "reveal",
      remainingMs,
      isPaused: currentRoom.isPaused,
    });

    if (currentRoom.isPaused) {
      return;
    }

    if (remainingMs <= 0) {
      clearInterval(currentRoom.revealTicker);
      currentRoom.revealTicker = null;

      currentRoom.currentQuestionIndex += 1;

      if (currentRoom.currentQuestionIndex >= currentRoom.gameQuestions.length) {
        finishGame(code);
        return;
      }

      startQuestion(code);
    }
  }, TIMER_TICK_MS);
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
  const revealStartedAt = Date.now();

  room.state = "reveal";
  room.revealStartedAt = revealStartedAt;
  room.pauseAccumulatedMs = 0;
  room.pausedAt = null;
  room.isPaused = false;

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
    answerMarkers: getAnswerMarkers(room),
    roundResults: getRoundResults(room),
    revealStartedAt,
    revealDurationMs: REVEAL_DURATION_MS,
    isPaused: room.isPaused,
    remainingMs: REVEAL_DURATION_MS,
  });

  emitRoomUpdate(code);
  startRevealTicker(code);
}

function startQuestionTicker(code) {
  const room = rooms[code];
  if (!room) return;

  if (room.questionTicker) {
    clearInterval(room.questionTicker);
    room.questionTicker = null;
  }

  room.questionTicker = setInterval(() => {
    const currentRoom = rooms[code];
    if (!currentRoom) {
      clearInterval(room.questionTicker);
      room.questionTicker = null;
      return;
    }

    if (currentRoom.state !== "question") {
      clearInterval(currentRoom.questionTicker);
      currentRoom.questionTicker = null;
      return;
    }

    const question = getCurrentQuestion(currentRoom);
    if (!question) {
      clearInterval(currentRoom.questionTicker);
      currentRoom.questionTicker = null;
      finishGame(code);
      return;
    }

    const remainingMs = getRemainingQuestionTime(currentRoom, question);

    io.to(code).emit("game:timer", {
      phase: "question",
      remainingMs,
      isPaused: currentRoom.isPaused,
    });

    if (currentRoom.isPaused) {
      return;
    }

    if (remainingMs <= 0) {
      clearInterval(currentRoom.questionTicker);
      currentRoom.questionTicker = null;
      revealAnswer(code);
    }
  }, TIMER_TICK_MS);
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
  room.revealStartedAt = null;
  room.doublePoints = Math.random() < 0.25;
  room.currentAnswers = {};
  room.currentRoundResults = {};
  room.isPaused = false;
  room.pausedAt = null;
  room.pauseAccumulatedMs = 0;

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
    answerMarkers: [],
    isPaused: room.isPaused,
    remainingMs: question.durationMs,
  });

  emitRoomUpdate(code);
  startQuestionTicker(code);
}

function resetRoomForNewGame(room) {
  clearExistingTimeouts(room);
  room.state = "lobby";
  room.currentQuestionIndex = 0;
  room.roundStartedAt = null;
  room.revealStartedAt = null;
  room.doublePoints = false;
  room.gameQuestions = [];
  room.currentAnswers = {};
  room.currentRoundResults = {};
  room.playerStats = {};
  room.isPaused = false;
  room.pausedAt = null;
  room.pauseAccumulatedMs = 0;

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

  const filtered = rawCategories.filter((category) =>
    validIds.includes(category)
  );
  return filtered.length > 0 ? filtered : validIds;
}

function getRoomAndPlayer(code, socketId) {
  const roomCode = String(code || "")
    .trim()
    .toUpperCase();
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
      revealStartedAt: null,
      questionTimeout: null,
      revealTimeout: null,
      questionTicker: null,
      revealTicker: null,
      doublePoints: false,
      gameQuestions: [],
      currentAnswers: {},
      currentRoundResults: {},
      playerStats: {},
      isPaused: false,
      pausedAt: null,
      pauseAccumulatedMs: 0,
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
    const roomCode = String(code || "")
      .trim()
      .toUpperCase();
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
      const oldPlayerId = existingPlayerBySession.id;
      existingPlayerBySession.id = socket.id;
      existingPlayerBySession.name = trimmedName;
      existingPlayerBySession.connected = true;

      if (room.hostId === oldPlayerId) {
        room.hostId = socket.id;
      }

      if (room.currentAnswers?.[oldPlayerId] !== undefined) {
        room.currentAnswers[socket.id] = room.currentAnswers[oldPlayerId];
        delete room.currentAnswers[oldPlayerId];
      }

      if (room.currentRoundResults?.[oldPlayerId]) {
        room.currentRoundResults[socket.id] = {
          ...room.currentRoundResults[oldPlayerId],
          playerId: socket.id,
          playerName: trimmedName,
        };
        delete room.currentRoundResults[oldPlayerId];
      }

      if (room.playerStats?.[oldPlayerId]) {
        room.playerStats[socket.id] = room.playerStats[oldPlayerId];
        delete room.playerStats[oldPlayerId];
      }

      socket.join(roomCode);
      callback?.({ ok: true, room: sanitizeRoom(room), rejoined: true });
      emitRoomUpdate(roomCode);

      if (room.state === "question") {
        const question = getCurrentQuestion(room);

        if (question) {
          socket.emit("game:question", {
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
            difficultyMultiplier: getDifficultyMultiplier(question.difficulty),
            answerMarkers: getAnswerMarkers(room),
            isPaused: room.isPaused,
            remainingMs: getRemainingQuestionTime(room, question),
          });
        }
      }

      if (room.state === "reveal") {
        const question = getCurrentQuestion(room);

        if (question) {
          socket.emit("game:reveal", {
            room: sanitizeRoom(room),
            question: {
              id: question.id,
              category: question.category,
              difficulty: question.difficulty,
              text: question.text,
              options: question.options,
              durationMs: question.durationMs,
            },
            difficultyMultiplier: getDifficultyMultiplier(question.difficulty),
            correctIndex: question.correctIndex,
            correctAnswer: question.options[question.correctIndex],
            players: sortPlayers(room.players).map(sanitizePlayer),
            answerMarkers: getAnswerMarkers(room),
            roundResults: getRoundResults(room),
            revealStartedAt: room.revealStartedAt,
            revealDurationMs: REVEAL_DURATION_MS,
            isPaused: room.isPaused,
            remainingMs: getRemainingRevealTime(room),
          });
        }
      }

      if (room.state === "finished") {
        socket.emit("game:finished", {
          room: sanitizeRoom(room),
          players: sortPlayers(room.players).map(sanitizePlayer),
          finalResults: getFinalResults(room),
        });
      }

      return;
    }

    if (room.state !== "lobby") {
      callback?.({
        ok: false,
        error:
          "La partita è già iniziata. Può rientrare solo chi era già dentro.",
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
      callback?.({
        ok: false,
        error: "Solo l'host può modificare le impostazioni.",
      });
      return;
    }

    if (room.state !== "lobby") {
      callback?.({
        ok: false,
        error: "Le impostazioni si cambiano solo in lobby.",
      });
      return;
    }

    room.settings = {
      categories: ensureValidCategories(settings?.categories),
      totalQuestions: Math.max(
        5,
        Math.min(
          20,
          Number(settings?.totalQuestions || room.settings.totalQuestions || 10)
        )
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
    room.playerStats = {};
    room.isPaused = false;
    room.pausedAt = null;
    room.pauseAccumulatedMs = 0;

    room.players.forEach((entry) => {
      entry.score = 0;
      entry.answered = false;
      room.playerStats[entry.id] = {
        correctAnswers: 0,
        wrongAnswers: 0,
        answeredQuestions: 0,
        totalPointsEarned: 0,
        totalResponseTimeMs: 0,
        rounds: [],
      };
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
      callback?.({
        ok: false,
        error: "Solo l'host può avviare la rivincita.",
      });
      return;
    }

    resetRoomForNewGame(room);
    emitRoomUpdate(roomCode);
    callback?.({ ok: true });
  });

  socket.on("game:pause", ({ code }, callback) => {
    const { roomCode, room, player } = getRoomAndPlayer(code, socket.id);

    if (!room || !player) {
      callback?.({ ok: false, error: "Stanza o giocatore non trovato." });
      return;
    }

    if (room.hostId !== socket.id) {
      callback?.({ ok: false, error: "Solo l'host può mettere in pausa." });
      return;
    }

    if (room.state !== "question" && room.state !== "reveal") {
      callback?.({
        ok: false,
        error: "La pausa è disponibile solo durante la partita.",
      });
      return;
    }

    if (room.isPaused) {
      callback?.({ ok: false, error: "La partita è già in pausa." });
      return;
    }

    room.isPaused = true;
    room.pausedAt = Date.now();

    io.to(roomCode).emit("game:paused", {
      room: sanitizeRoom(room),
      isPaused: true,
      phase: room.state,
      remainingMs:
        room.state === "question"
          ? getRemainingQuestionTime(room, getCurrentQuestion(room))
          : getRemainingRevealTime(room),
    });

    emitRoomUpdate(roomCode);
    callback?.({ ok: true });
  });

  socket.on("game:resume", ({ code }, callback) => {
    const { roomCode, room, player } = getRoomAndPlayer(code, socket.id);

    if (!room || !player) {
      callback?.({ ok: false, error: "Stanza o giocatore non trovato." });
      return;
    }

    if (room.hostId !== socket.id) {
      callback?.({ ok: false, error: "Solo l'host può riprendere la partita." });
      return;
    }

    if (!room.isPaused || !room.pausedAt) {
      callback?.({ ok: false, error: "La partita non è in pausa." });
      return;
    }

    room.pauseAccumulatedMs += Date.now() - room.pausedAt;
    room.pausedAt = null;
    room.isPaused = false;

    io.to(roomCode).emit("game:resumed", {
      room: sanitizeRoom(room),
      isPaused: false,
      phase: room.state,
      remainingMs:
        room.state === "question"
          ? getRemainingQuestionTime(room, getCurrentQuestion(room))
          : getRemainingRevealTime(room),
    });

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

    if (room.isPaused) {
      callback?.({ ok: false, error: "La partita è in pausa." });
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
    room.currentAnswers[player.id] = answerIndex;

    const elapsed = Math.max(
      0,
      Date.now() - room.roundStartedAt - (room.pauseAccumulatedMs || 0)
    );
    const isCorrect = Number(answerIndex) === question.correctIndex;

    let pointsEarned = 0;

    if (isCorrect) {
      const speedBonus = Math.max(0, 50 - Math.floor(elapsed / 150));
      const baseScore = 50 + speedBonus;
      const difficultyMultiplier = getDifficultyMultiplier(question.difficulty);
      const scoreWithDifficulty = Math.round(baseScore * difficultyMultiplier);
      pointsEarned = room.doublePoints
        ? scoreWithDifficulty * 2
        : scoreWithDifficulty;
      player.score += pointsEarned;
    }

    room.currentRoundResults[player.id] = {
      playerId: player.id,
      playerName: player.name,
      answerIndex,
      selectedAnswer: question.options[answerIndex],
      isCorrect,
      pointsEarned,
      totalScore: player.score,
    };

    if (!room.playerStats[player.id]) {
      room.playerStats[player.id] = {
        correctAnswers: 0,
        wrongAnswers: 0,
        answeredQuestions: 0,
        totalPointsEarned: 0,
        totalResponseTimeMs: 0,
        rounds: [],
      };
    }

    room.playerStats[player.id].answeredQuestions += 1;
    room.playerStats[player.id].totalPointsEarned += pointsEarned;
    room.playerStats[player.id].totalResponseTimeMs += elapsed;

    if (isCorrect) {
      room.playerStats[player.id].correctAnswers += 1;
    } else {
      room.playerStats[player.id].wrongAnswers += 1;
    }

    room.playerStats[player.id].rounds.push({
      questionText: question.text,
      category: question.category,
      difficulty: question.difficulty,
      selectedAnswer: question.options[answerIndex],
      correctAnswer: question.options[question.correctIndex],
      isCorrect,
      pointsEarned,
    });

    callback?.({
      ok: true,
      isCorrect,
      correctIndex: question.correctIndex,
    });

    io.to(roomCode).emit("answers:updated", {
      answerMarkers: getAnswerMarkers(room),
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