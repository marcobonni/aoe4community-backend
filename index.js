const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { QUESTIONS } = require("./questions");

const app = express();
app.use(cors());

app.get("/", (_req, res) => {
  res.send("Beasty server awake");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000"],
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

function sortPlayers(players) {
  return [...players].sort((a, b) => b.score - a.score);
}

function sanitizeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      connected: player.connected,
    })),
    state: room.state,
    currentQuestionIndex: room.currentQuestionIndex,
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
}

function emitRoomUpdate(code) {
  const room = rooms[code];
  if (!room) return;

  io.to(code).emit("room:updated", sanitizeRoom(room));
}

function finishGame(code) {
  const room = rooms[code];
  if (!room) return;

  clearExistingTimeouts(room);
  room.state = "finished";

  io.to(code).emit("game:finished", {
    room: sanitizeRoom(room),
    players: sortPlayers(room.players).map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      connected: player.connected,
    })),
  });

  emitRoomUpdate(code);
}

function revealAnswer(code) {
  const room = rooms[code];
  if (!room || room.state !== "question") return;

  clearExistingTimeouts(room);

  const question = QUESTIONS[room.currentQuestionIndex];
  if (!question) {
    finishGame(code);
    return;
  }

  room.state = "reveal";

  io.to(code).emit("game:reveal", {
    room: sanitizeRoom(room),
    question: {
      id: question.id,
      text: question.text,
      options: question.options,
      durationMs: question.durationMs,
    },
    correctIndex: question.correctIndex,
    correctAnswer: question.options[question.correctIndex],
    players: sortPlayers(room.players).map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      connected: player.connected,
    })),
  });

  emitRoomUpdate(code);

  room.revealTimeout = setTimeout(() => {
    room.currentQuestionIndex += 1;

    if (room.currentQuestionIndex >= QUESTIONS.length) {
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

  const question = QUESTIONS[room.currentQuestionIndex];
  if (!question) {
    finishGame(code);
    return;
  }

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
      text: question.text,
      options: question.options,
      durationMs: question.durationMs,
    },
    startedAt: room.roundStartedAt,
    doublePoints: room.doublePoints,
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

  room.players.forEach((player) => {
    player.score = 0;
    player.answered = false;
  });
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("room:create", ({ name }, callback) => {
    const trimmedName = String(name || "").trim();

    if (!trimmedName) {
      callback?.({ ok: false, error: "Inserisci un nome valido." });
      return;
    }

    let code = generateCode();
    while (rooms[code]) {
      code = generateCode();
    }

    rooms[code] = {
      code,
      hostId: socket.id,
      players: [
        {
          id: socket.id,
          name: trimmedName,
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
    };

    socket.join(code);

    callback?.({ ok: true, room: sanitizeRoom(rooms[code]) });
    emitRoomUpdate(code);
  });

  socket.on("room:join", ({ code, name }, callback) => {
    const roomCode = String(code || "").trim().toUpperCase();
    const trimmedName = String(name || "").trim();
    const room = rooms[roomCode];

    if (!room) {
      callback?.({ ok: false, error: "Stanza non trovata." });
      return;
    }

    if (!trimmedName) {
      callback?.({ ok: false, error: "Inserisci un nome valido." });
      return;
    }

    if (room.state !== "lobby") {
      callback?.({
        ok: false,
        error: "La partita è già iniziata. Entra in una lobby nuova.",
      });
      return;
    }

    const existingPlayer = room.players.find((player) => player.id === socket.id);

    if (!existingPlayer) {
      room.players.push({
        id: socket.id,
        name: trimmedName,
        score: 0,
        answered: false,
        connected: true,
      });
    }

    socket.join(roomCode);

    callback?.({ ok: true, room: sanitizeRoom(room) });
    emitRoomUpdate(roomCode);
  });

  socket.on("game:start", ({ code }, callback) => {
    const roomCode = String(code || "").trim().toUpperCase();
    const room = rooms[roomCode];

    if (!room) {
      callback?.({ ok: false, error: "Stanza non trovata." });
      return;
    }

    if (room.hostId !== socket.id) {
      callback?.({ ok: false, error: "Solo l'host può avviare la partita." });
      return;
    }

    room.currentQuestionIndex = 0;
    room.players.forEach((player) => {
      player.score = 0;
      player.answered = false;
    });

    startQuestion(roomCode);

    callback?.({ ok: true });
  });

  socket.on("game:rematch", ({ code }, callback) => {
    const roomCode = String(code || "").trim().toUpperCase();
    const room = rooms[roomCode];

    if (!room) {
      callback?.({ ok: false, error: "Stanza non trovata." });
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

  socket.on("answer:submit", ({ code, answerIndex }, callback) => {
    const roomCode = String(code || "").trim().toUpperCase();
    const room = rooms[roomCode];

    if (!room || room.state !== "question") {
      callback?.({ ok: false, error: "Nessuna domanda attiva." });
      return;
    }

    const question = QUESTIONS[room.currentQuestionIndex];
    if (!question) {
      callback?.({ ok: false, error: "Domanda non trovata." });
      return;
    }

    const player = room.players.find((p) => p.id === socket.id);

    if (!player) {
      callback?.({ ok: false, error: "Giocatore non trovato." });
      return;
    }

    if (player.answered) {
      callback?.({ ok: false, error: "Hai già risposto." });
      return;
    }

    player.answered = true;

    const elapsed = Date.now() - room.roundStartedAt;
    const isCorrect = Number(answerIndex) === question.correctIndex;

    if (isCorrect) {
      const speedBonus = Math.max(0, 50 - Math.floor(elapsed / 150));
      const baseScore = 50 + speedBonus;
      player.score += room.doublePoints ? baseScore * 2 : baseScore;
    }

    callback?.({
      ok: true,
      isCorrect,
      correctIndex: question.correctIndex,
    });

    io.to(roomCode).emit("scoreboard:updated", {
      players: sortPlayers(room.players).map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        connected: p.connected,
      })),
    });

    const activePlayers = room.players.filter((playerItem) => playerItem.connected);
    const everyoneAnswered =
      activePlayers.length > 0 &&
      activePlayers.every((playerItem) => playerItem.answered);

    if (everyoneAnswered) {
      revealAnswer(roomCode);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    Object.values(rooms).forEach((room) => {
      const player = room.players.find((p) => p.id === socket.id);

      if (!player) return;

      player.connected = false;
      emitRoomUpdate(room.code);
    });
  });
});

server.listen(8080, () => {
  console.log("Server running on http://localhost:8080");
});