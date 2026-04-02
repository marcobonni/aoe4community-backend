const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const matchmakingRouter = require("./routes/matchmaking");
const { QUESTIONS, QUESTION_CATEGORIES } = require("./questions");
const { createRoomStore } = require("./quiz/roomStore");
const { registerQuizHandlers } = require("./quiz/socketHandlers");

const DIFFICULTY_MULTIPLIERS = {
  easy: 1,
  medium: 1.5,
  hard: 2,
};

const REVEAL_DURATION_MS = 4000;
const TIMER_TICK_MS = 250;

const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "https://epicojackalaoe4community.vercel.app",
  "https://aoe4community.vercel.app",
];

const app = express();

app.use(
  cors({
    origin: ALLOWED_ORIGINS,
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
    origin: ALLOWED_ORIGINS,
    credentials: true,
  },
});

const roomStore = createRoomStore();

const quizContext = {
  io,
  roomStore,
  QUESTIONS,
  QUESTION_CATEGORIES,
  DIFFICULTY_MULTIPLIERS,
  REVEAL_DURATION_MS,
  TIMER_TICK_MS,
};

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);
  registerQuizHandlers(socket, quizContext);
});

const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});