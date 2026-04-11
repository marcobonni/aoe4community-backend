require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const matchmakingRouter = require("./routes/matchmaking");
const tournamentRouter = require("./routes/tournament-routes");
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

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://epicojackalaoe4community.vercel.app",
  "https://aoe4community.vercel.app",
];

function parseAllowedOrigins() {
  const configuredOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return configuredOrigins.length ? configuredOrigins : DEFAULT_ALLOWED_ORIGINS;
}

function createRateLimiter({ windowMs, maxRequests }) {
  const buckets = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
    const key = `${ip}:${req.baseUrl || req.path}`;
    const entry = buckets.get(key);

    if (!entry || entry.expiresAt <= now) {
      buckets.set(key, {
        count: 1,
        expiresAt: now + windowMs,
      });
      return next();
    }

    if (entry.count >= maxRequests) {
      res.setHeader("Retry-After", Math.ceil((entry.expiresAt - now) / 1000));
      return res.status(429).json({
        error: "Too many requests, please retry shortly",
      });
    }

    entry.count += 1;
    buckets.set(key, entry);
    return next();
  };
}

const ALLOWED_ORIGINS = parseAllowedOrigins();
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 120);
const tournamentRateLimiter = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: RATE_LIMIT_MAX_REQUESTS,
});

const app = express();
app.disable("x-powered-by");

if (process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", 1);
}

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "200kb" }));

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
app.use("/api/tournament", tournamentRateLimiter, tournamentRouter);

app.use((err, _req, res, _next) => {
  console.error("Express error:", err);

  if (res.headersSent) {
    return;
  }

  res.status(500).json({
    error: "Internal server error",
  });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`Socket origin not allowed by CORS: ${origin}`));
    },
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

console.log("Starting server...", {
  port: PORT,
  allowedOrigins: ALLOWED_ORIGINS.length,
  rateLimitWindowMs: RATE_LIMIT_WINDOW_MS,
  rateLimitMaxRequests: RATE_LIMIT_MAX_REQUESTS,
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

server.on("error", (error) => {
  console.error("Server listen error:", error);
});
