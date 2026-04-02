const {
  sortPlayers,
  sanitizePlayer,
} = require("./roomUtils");
const {
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

function createGameFlow(context) {
  const {
    io,
    roomStore,
    DIFFICULTY_MULTIPLIERS,
    REVEAL_DURATION_MS,
    TIMER_TICK_MS,
  } = context;

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
      isResumeCountingDown: Boolean(room.isResumeCountingDown),
      remainingMs:
        room.state === "question" && currentQuestion
          ? getRemainingQuestionTime(room, currentQuestion)
          : room.state === "reveal"
          ? getRemainingRevealTime(room, REVEAL_DURATION_MS)
          : null,
    };
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

    if (room.resumeCountdownTimeout) {
      clearTimeout(room.resumeCountdownTimeout);
      room.resumeCountdownTimeout = null;
    }

    room.isResumeCountingDown = false;
  }

  function emitRoomUpdate(code) {
    const room = roomStore.get(code);
    if (!room) return;

    io.to(code).emit("room:updated", sanitizeRoom(room));
  }

  function finishGame(code) {
    const room = roomStore.get(code);
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
    const room = roomStore.get(code);
    if (!room) return;

    if (room.revealTicker) {
      clearInterval(room.revealTicker);
      room.revealTicker = null;
    }

    room.revealTicker = setInterval(() => {
      const currentRoom = roomStore.get(code);

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

      const remainingMs = getRemainingRevealTime(
        currentRoom,
        REVEAL_DURATION_MS
      );

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

        if (
          currentRoom.currentQuestionIndex >= currentRoom.gameQuestions.length
        ) {
          finishGame(code);
          return;
        }

        startQuestion(code);
      }
    }, TIMER_TICK_MS);
  }

  function revealAnswer(code) {
    const room = roomStore.get(code);
    if (!room || room.state !== "question") return;

    clearExistingTimeouts(room);

    const question = getCurrentQuestion(room);
    if (!question) {
      finishGame(code);
      return;
    }

    const difficultyMultiplier = getDifficultyMultiplier(
      question.difficulty,
      DIFFICULTY_MULTIPLIERS
    );
    const revealStartedAt = Date.now();

    room.state = "reveal";
    room.revealStartedAt = revealStartedAt;
    room.pauseAccumulatedMs = 0;
    room.pausedAt = null;
    room.isPaused = false;
    room.isResumeCountingDown = false;

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
    const room = roomStore.get(code);
    if (!room) return;

    if (room.questionTicker) {
      clearInterval(room.questionTicker);
      room.questionTicker = null;
    }

    room.questionTicker = setInterval(() => {
      const currentRoom = roomStore.get(code);

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
    const room = roomStore.get(code);
    if (!room) return;

    clearExistingTimeouts(room);

    const question = getCurrentQuestion(room);
    if (!question) {
      finishGame(code);
      return;
    }

    const difficultyMultiplier = getDifficultyMultiplier(
      question.difficulty,
      DIFFICULTY_MULTIPLIERS
    );

    room.state = "question";
    room.roundStartedAt = Date.now();
    room.revealStartedAt = null;
    room.doublePoints = Math.random() < 0.25;
    room.currentAnswers = {};
    room.currentRoundResults = {};
    room.isPaused = false;
    room.pausedAt = null;
    room.pauseAccumulatedMs = 0;
    room.isResumeCountingDown = false;

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
    room.isResumeCountingDown = false;

    room.players.forEach((player) => {
      player.score = 0;
      player.answered = false;
    });
  }

  return {
    sanitizeRoom,
    clearExistingTimeouts,
    emitRoomUpdate,
    finishGame,
    revealAnswer,
    startQuestion,
    resetRoomForNewGame,
  };
}

module.exports = {
  createGameFlow,
};