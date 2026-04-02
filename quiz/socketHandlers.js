const {
  generateCode,
  pickHost,
  getRoomAndPlayer,
  ensureValidCategories,
  sortPlayers,
  sanitizePlayer,
} = require("./roomUtils");
const {
  buildQuestionPool,
  getCurrentQuestion,
  getDifficultyMultiplier,
} = require("./questionUtils");
const {
  getAnswerMarkers,
  getRoundResults,
  getFinalResults,
} = require("./resultUtils");
const {
  getRemainingQuestionTime,
  getRemainingRevealTime,
} = require("./timerUtils");
const { createGameFlow } = require("./gameFlow");

function registerQuizHandlers(socket, context) {
  const {
    io,
    roomStore,
    QUESTIONS,
    QUESTION_CATEGORIES,
    DIFFICULTY_MULTIPLIERS,
    REVEAL_DURATION_MS,
  } = context;

  const gameFlow = createGameFlow(context);

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

    const code = generateCode(roomStore);
    const categories = ensureValidCategories(
      settings?.categories,
      QUESTION_CATEGORIES
    );
    const totalQuestions = Math.max(
      5,
      Math.min(20, Number(settings?.totalQuestions || 10))
    );

    const room = {
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
      resumeCountdownTimeout: null,
      doublePoints: false,
      gameQuestions: [],
      currentAnswers: {},
      currentRoundResults: {},
      playerStats: {},
      isPaused: false,
      isResumeCountingDown: false,
      pausedAt: null,
      pauseAccumulatedMs: 0,
      settings: {
        categories,
        totalQuestions,
      },
    };

    roomStore.set(code, room);
    socket.join(code);

    callback?.({ ok: true, room: gameFlow.sanitizeRoom(room) });
    gameFlow.emitRoomUpdate(code);
  });

  socket.on("room:join", ({ code, name, playerSessionId }, callback) => {
    const roomCode = String(code || "").trim().toUpperCase();
    const trimmedName = String(name || "").trim();
    const trimmedSessionId = String(playerSessionId || "").trim();
    const room = roomStore.get(roomCode);

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
      callback?.({
        ok: true,
        room: gameFlow.sanitizeRoom(room),
        rejoined: true,
      });
      gameFlow.emitRoomUpdate(roomCode);

      if (room.state === "question") {
        const question = getCurrentQuestion(room);

        if (question) {
          socket.emit("game:question", {
            room: gameFlow.sanitizeRoom(room),
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
            difficultyMultiplier: getDifficultyMultiplier(
              question.difficulty,
              DIFFICULTY_MULTIPLIERS
            ),
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
            room: gameFlow.sanitizeRoom(room),
            question: {
              id: question.id,
              category: question.category,
              difficulty: question.difficulty,
              text: question.text,
              options: question.options,
              durationMs: question.durationMs,
            },
            difficultyMultiplier: getDifficultyMultiplier(
              question.difficulty,
              DIFFICULTY_MULTIPLIERS
            ),
            correctIndex: question.correctIndex,
            correctAnswer: question.options[question.correctIndex],
            players: sortPlayers(room.players).map(sanitizePlayer),
            answerMarkers: getAnswerMarkers(room),
            roundResults: getRoundResults(room),
            revealStartedAt: room.revealStartedAt,
            revealDurationMs: REVEAL_DURATION_MS,
            isPaused: room.isPaused,
            remainingMs: getRemainingRevealTime(room, REVEAL_DURATION_MS),
          });
        }
      }

      if (room.state === "finished") {
        socket.emit("game:finished", {
          room: gameFlow.sanitizeRoom(room),
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

    callback?.({
      ok: true,
      room: gameFlow.sanitizeRoom(room),
      rejoined: false,
    });
    gameFlow.emitRoomUpdate(roomCode);
  });

  socket.on("room:update-settings", ({ code, settings }, callback) => {
    const { roomCode, room, player } = getRoomAndPlayer(
      roomStore,
      code,
      socket.id
    );

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
      categories: ensureValidCategories(
        settings?.categories,
        QUESTION_CATEGORIES
      ),
      totalQuestions: Math.max(
        5,
        Math.min(
          20,
          Number(settings?.totalQuestions || room.settings.totalQuestions || 10)
        )
      ),
    };

    gameFlow.emitRoomUpdate(roomCode);
    callback?.({ ok: true, room: gameFlow.sanitizeRoom(room) });
  });

  socket.on("game:start", ({ code }, callback) => {
    const { roomCode, room, player } = getRoomAndPlayer(
      roomStore,
      code,
      socket.id
    );

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
    room.isResumeCountingDown = false;
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

    room.gameQuestions = buildQuestionPool(
      room,
      QUESTIONS,
      QUESTION_CATEGORIES
    );

    if (room.gameQuestions.length === 0) {
      callback?.({
        ok: false,
        error: "Nessuna domanda disponibile con le categorie selezionate.",
      });
      return;
    }

    gameFlow.startQuestion(roomCode);
    callback?.({ ok: true });
  });

  socket.on("game:rematch", ({ code }, callback) => {
    const { roomCode, room, player } = getRoomAndPlayer(
      roomStore,
      code,
      socket.id
    );

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

    gameFlow.resetRoomForNewGame(room);
    gameFlow.emitRoomUpdate(roomCode);
    callback?.({ ok: true });
  });

  socket.on("game:pause", ({ code }, callback) => {
    const { roomCode, room, player } = getRoomAndPlayer(
      roomStore,
      code,
      socket.id
    );

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

    if (room.isResumeCountingDown) {
      callback?.({
        ok: false,
        error: "La partita sta già riprendendo con il countdown.",
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
      room: gameFlow.sanitizeRoom(room),
      isPaused: true,
      phase: room.state,
      remainingMs:
        room.state === "question"
          ? getRemainingQuestionTime(room, getCurrentQuestion(room))
          : getRemainingRevealTime(room, REVEAL_DURATION_MS),
    });

    gameFlow.emitRoomUpdate(roomCode);
    callback?.({ ok: true });
  });

  socket.on("game:resume", ({ code }, callback) => {
    const { roomCode, room, player } = getRoomAndPlayer(
      roomStore,
      code,
      socket.id
    );

    if (!room || !player) {
      callback?.({ ok: false, error: "Stanza o giocatore non trovato." });
      return;
    }

    if (room.hostId !== socket.id) {
      callback?.({
        ok: false,
        error: "Solo l'host può riprendere la partita.",
      });
      return;
    }

    if (!room.isPaused || !room.pausedAt) {
      callback?.({ ok: false, error: "La partita non è in pausa." });
      return;
    }

    if (room.isResumeCountingDown) {
      callback?.({
        ok: false,
        error: "Il countdown di ripresa è già in corso.",
      });
      return;
    }

    const COUNTDOWN_MS = 3000;
    const resumeAt = Date.now() + COUNTDOWN_MS;

    room.isResumeCountingDown = true;

    io.to(roomCode).emit("game:resume-countdown", {
      phase: room.state,
      resumeAt,
      countdownMs: COUNTDOWN_MS,
    });

    gameFlow.emitRoomUpdate(roomCode);

    room.resumeCountdownTimeout = setTimeout(() => {
      const currentRoom = roomStore.get(roomCode);
      if (!currentRoom) return;

      currentRoom.resumeCountdownTimeout = null;
      currentRoom.isResumeCountingDown = false;
      currentRoom.pauseAccumulatedMs += Date.now() - currentRoom.pausedAt;
      currentRoom.pausedAt = null;
      currentRoom.isPaused = false;

      io.to(roomCode).emit("game:resumed", {
        room: gameFlow.sanitizeRoom(currentRoom),
        isPaused: false,
        phase: currentRoom.state,
        remainingMs:
          currentRoom.state === "question"
            ? getRemainingQuestionTime(
                currentRoom,
                getCurrentQuestion(currentRoom)
              )
            : getRemainingRevealTime(currentRoom, REVEAL_DURATION_MS),
      });

      gameFlow.emitRoomUpdate(roomCode);
    }, COUNTDOWN_MS);

    callback?.({ ok: true });
  });

  socket.on("answer:submit", ({ code, answerIndex, questionId }, callback) => {
    const { roomCode, room, player } = getRoomAndPlayer(
      roomStore,
      code,
      socket.id
    );

    if (!room || !player) {
      callback?.({ ok: false, error: "Stanza o giocatore non trovato." });
      return;
    }

    if (room.state !== "question") {
      callback?.({ ok: false, error: "Nessuna domanda attiva." });
      return;
    }

    if (room.isPaused || room.isResumeCountingDown) {
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
      const difficultyMultiplier = getDifficultyMultiplier(
        question.difficulty,
        DIFFICULTY_MULTIPLIERS
      );
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
      gameFlow.revealAnswer(roomCode);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    roomStore.getAll().forEach((room) => {
      const player = room.players.find((entry) => entry.id === socket.id);
      if (!player) return;

      player.connected = false;

      if (room.hostId === socket.id) {
        pickHost(room);
      }

      gameFlow.emitRoomUpdate(room.code);
    });
  });
}

module.exports = {
  registerQuizHandlers,
};