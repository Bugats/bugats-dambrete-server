const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const express = require("express");
const http = require("http");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 10080;
const JWT_SECRET = process.env.JWT_SECRET || "BUGATS_DAMBRETE_SECRET_CHANGE_ME";

// thezone.lv + lokālie test URL
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  "https://thezone.lv,http://localhost:5500,http://127.0.0.1:5500")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ===== BOT konfigurācija =====
const BOT_JOIN_WAIT_MS = parseInt(process.env.BOT_JOIN_WAIT_MS || "60000", 10); // 60s
const BOT_THINK_MIN_MS = parseInt(process.env.BOT_THINK_MIN_MS || "450", 10);
const BOT_THINK_MAX_MS = parseInt(process.env.BOT_THINK_MAX_MS || "900", 10);

// Ranked disconnect forfeit (ja neatgriežas)
const FORFEIT_GRACE_MS = parseInt(process.env.FORFEIT_GRACE_MS || "20000", 10);

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const UPLOADS_DIR = path.join(ROOT, "uploads");
const AVATARS_DIR = path.join(UPLOADS_DIR, "avatars");
const PUBLIC_DIR = path.join(ROOT, "public");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
ensureDir(DATA_DIR);
ensureDir(UPLOADS_DIR);
ensureDir(AVATARS_DIR);

if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "{}", "utf8");

// ---- atomic JSON write queue ----
let writeQueue = Promise.resolve();
function atomicWriteJSON(file, obj) {
  writeQueue = writeQueue.then(async () => {
    const tmp = file + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
    await fsp.rename(tmp, file);
  });
  return writeQueue;
}

async function readUsers() {
  try {
    const raw = await fsp.readFile(USERS_FILE, "utf8");
    const json = JSON.parse(raw || "{}");
    return json && typeof json === "object" ? json : {};
  } catch {
    return {};
  }
}

function safeUserPublic(u) {
  return {
    username: u.username,
    avatarUrl: u.avatarUrl || "",
    stats: u.stats || { wins: 0, losses: 0, draws: 0, xp: 0, rating: 1000 }
  };
}

function computeTop10(users) {
  const arr = Object.values(users).map((u) => ({
    username: u.username,
    avatarUrl: u.avatarUrl || "",
    wins: u.stats?.wins || 0,
    losses: u.stats?.losses || 0,
    xp: u.stats?.xp || 0,
    rating: u.stats?.rating ?? 1000
  }));
  arr.sort((a, b) => (b.rating - a.rating) || (b.wins - a.wins) || (b.xp - a.xp));
  return arr.slice(0, 10);
}

// ---- Express ----
const app = express();
app.set("trust proxy", 1);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin));
    },
    credentials: true
  })
);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));
app.use("/uploads", express.static(UPLOADS_DIR));

app.get("/health", (req, res) => res.json({ ok: true }));

// ---- Auth helpers ----
function signToken(username) {
  return jwt.sign({ u: username }, JWT_SECRET, { expiresIn: "30d" });
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload.u;
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }
}

function validUsername(s) {
  return typeof s === "string" && /^[a-zA-Z0-9_]{3,16}$/.test(s);
}
function validPassword(s) {
  return typeof s === "string" && s.length >= 6 && s.length <= 64;
}
function validRoomId(id) {
  return typeof id === "string" && /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(id);
}

// ---- Multer (avatar upload) ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AVATARS_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || "").toLowerCase();
    const safeExt = [".png", ".jpg", ".jpeg", ".webp"].includes(ext) ? ext : ".png";
    cb(null, `${req.user}_${Date.now()}${safeExt}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("Only PNG/JPG/WEBP allowed"), ok);
  }
});

// ---- API ----
app.post("/api/signup", async (req, res) => {
  const { username, password } = req.body || {};
  if (!validUsername(username)) return res.status(400).json({ ok: false, error: "BAD_USERNAME" });
  if (!validPassword(password)) return res.status(400).json({ ok: false, error: "BAD_PASSWORD" });

  const users = await readUsers();
  const key = username.toLowerCase();
  if (users[key]) return res.status(409).json({ ok: false, error: "USERNAME_TAKEN" });

  const passwordHash = await bcrypt.hash(password, 10);
  users[key] = {
    username,
    passwordHash,
    avatarUrl: "",
    createdAt: Date.now(),
    stats: { wins: 0, losses: 0, draws: 0, xp: 0, rating: 1000 }
  };
  await atomicWriteJSON(USERS_FILE, users);

  const token = signToken(username);
  return res.json({ ok: true, token, user: safeUserPublic(users[key]) });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!validUsername(username)) return res.status(400).json({ ok: false, error: "BAD_USERNAME" });
  if (!validPassword(password)) return res.status(400).json({ ok: false, error: "BAD_PASSWORD" });

  const users = await readUsers();
  const key = username.toLowerCase();
  const u = users[key];
  if (!u) return res.status(401).json({ ok: false, error: "INVALID_LOGIN" });

  const ok = await bcrypt.compare(password, u.passwordHash);
  if (!ok) return res.status(401).json({ ok: false, error: "INVALID_LOGIN" });

  const token = signToken(u.username);
  return res.json({ ok: true, token, user: safeUserPublic(u) });
});

app.get("/api/me", authMiddleware, async (req, res) => {
  const users = await readUsers();
  const key = req.user.toLowerCase();
  const u = users[key];
  if (!u) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  return res.json({ ok: true, user: safeUserPublic(u) });
});

// Avatar upload ar skaidru error atbildi
app.post("/api/avatar", authMiddleware, (req, res) => {
  upload.single("avatar")(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ ok: false, error: err.message || "UPLOAD_FAILED" });
    }

    const users = await readUsers();
    const key = req.user.toLowerCase();
    const u = users[key];
    if (!u) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: "NO_FILE" });

    u.avatarUrl = `/uploads/avatars/${file.filename}`;
    users[key] = u;
    await atomicWriteJSON(USERS_FILE, users);

    return res.json({ ok: true, avatarUrl: u.avatarUrl });
  });
});

app.get("/api/leaderboard", async (req, res) => {
  const users = await readUsers();
  return res.json({ ok: true, top10: computeTop10(users) });
});

// ---- Socket.IO ----
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
    credentials: true
  }
});

// socket auth
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || "";
    const payload = jwt.verify(token, JWT_SECRET);
    socket.username = payload.u;
    return next();
  } catch {
    return next(new Error("UNAUTHORIZED"));
  }
});

// ---- Game engine (Krievu dambrete) ----
// piece codes: 'w','b' men ; 'W','B' kings
function initialBoard() {
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const dark = (r + c) % 2 === 1;
      if (!dark) continue;
      if (r < 3) b[r][c] = "b";
      if (r > 4) b[r][c] = "w";
    }
  }
  return b;
}

function cloneBoard(board) {
  return board.map((row) => row.slice());
}

function inBounds(r, c) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}
function isDark(r, c) {
  return (r + c) % 2 === 1;
}

function colorOf(p) {
  if (!p) return null;
  return p === "w" || p === "W" ? "w" : "b";
}
function isKing(p) {
  return p === "W" || p === "B";
}
function opponent(color) {
  return color === "w" ? "b" : "w";
}

function promoteIfNeeded(piece, toR, color) {
  if (isKing(piece)) return piece;
  if (color === "w" && toR === 0) return "W";
  if (color === "b" && toR === 7) return "B";
  return piece;
}

// ---- Capture sequence generation (with immediate promotion) ----
const DIRS = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1]
];

function genCapturesFrom(board, r, c, piece, capturedSet) {
  const color = colorOf(piece);
  const opp = opponent(color);
  const results = [];

  if (!isKing(piece)) {
    // men capture in all diagonal directions in Russian checkers
    for (const [dr, dc] of DIRS) {
      const mr = r + dr,
        mc = c + dc;
      const lr = r + 2 * dr,
        lc = c + 2 * dc;
      if (!inBounds(lr, lc)) continue;
      if (!isDark(lr, lc)) continue;

      const mid = board[mr]?.[mc];
      if (!mid) continue;
      if (colorOf(mid) !== opp) continue;
      const midKey = `${mr},${mc}`;
      if (capturedSet.has(midKey)) continue;

      if (board[lr][lc] !== null) continue;

      const nb = cloneBoard(board);
      nb[r][c] = null;
      nb[mr][mc] = null;

      let np = piece;
      np = promoteIfNeeded(np, lr, color);
      nb[lr][lc] = np;

      const nCaptured = new Set(capturedSet);
      nCaptured.add(midKey);

      const tails = genCapturesFrom(nb, lr, lc, np, nCaptured);
      if (tails.length === 0) {
        results.push([[lr, lc]]);
      } else {
        for (const t of tails) results.push([[lr, lc], ...t]);
      }
    }
    return results;
  }

  // King capture: one opponent in line, land any empty beyond it
  for (const [dr, dc] of DIRS) {
    let rr = r + dr,
      cc = c + dc;
    let foundOpp = null;

    while (inBounds(rr, cc) && isDark(rr, cc)) {
      const cell = board[rr][cc];

      if (cell === null) {
        if (foundOpp) {
          const [or, oc] = foundOpp;
          const oppKey = `${or},${oc}`;
          if (capturedSet.has(oppKey)) {
            rr += dr;
            cc += dc;
            continue;
          }

          const nb = cloneBoard(board);
          nb[r][c] = null;
          nb[or][oc] = null;
          nb[rr][cc] = piece;

          const nCaptured = new Set(capturedSet);
          nCaptured.add(oppKey);

          const tails = genCapturesFrom(nb, rr, cc, piece, nCaptured);
          if (tails.length === 0) {
            results.push([[rr, cc]]);
          } else {
            for (const t of tails) results.push([[rr, cc], ...t]);
          }
        }
        rr += dr;
        cc += dc;
        continue;
      }

      if (colorOf(cell) === color) break;
      if (colorOf(cell) === opp) {
        if (foundOpp) break;
        foundOpp = [rr, cc];
        rr += dr;
        cc += dc;
        continue;
      }

      rr += dr;
      cc += dc;
    }
  }

  return results;
}

function allCapturePlans(board, color) {
  const plans = new Map();
  let maxCap = 0;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      if (colorOf(p) !== color) continue;
      const seqs = genCapturesFrom(board, r, c, p, new Set());
      if (seqs.length > 0) {
        for (const s of seqs) maxCap = Math.max(maxCap, s.length);
        plans.set(`${r},${c}`, seqs);
      }
    }
  }

  if (maxCap === 0) return { mustCapture: false, maxCap: 0, plans: new Map() };

  const filtered = new Map();
  for (const [from, seqs] of plans.entries()) {
    const keep = seqs.filter((s) => s.length === maxCap);
    if (keep.length) filtered.set(from, keep);
  }
  return { mustCapture: true, maxCap, plans: filtered };
}

function allQuietMoves(board, color) {
  const moves = new Map();
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      if (colorOf(p) !== color) continue;

      if (!isKing(p)) {
        const dr = color === "w" ? -1 : 1;
        for (const dc of [-1, 1]) {
          const nr = r + dr,
            nc = c + dc;
          if (!inBounds(nr, nc)) continue;
          if (!isDark(nr, nc)) continue;
          if (board[nr][nc] !== null) continue;
          const key = `${r},${c}`;
          if (!moves.has(key)) moves.set(key, []);
          moves.get(key).push([nr, nc]);
        }
      } else {
        for (const [dr, dc] of DIRS) {
          let nr = r + dr,
            nc = c + dc;
          while (inBounds(nr, nc) && isDark(nr, nc) && board[nr][nc] === null) {
            const key = `${r},${c}`;
            if (!moves.has(key)) moves.set(key, []);
            moves.get(key).push([nr, nc]);
            nr += dr;
            nc += dc;
          }
        }
      }
    }
  }
  return moves;
}

function findCapturedSquare(board, fr, fc, tr, tc) {
  const dr = Math.sign(tr - fr);
  const dc = Math.sign(tc - fc);
  let r = fr + dr,
    c = fc + dc;
  let found = null;

  while (r !== tr && c !== tc) {
    const p = board[r][c];
    if (p !== null) {
      if (found) return null;
      found = [r, c];
    }
    r += dr;
    c += dc;
  }
  return found;
}

function hasAnyMove(board, color) {
  const caps = allCapturePlans(board, color);
  if (caps.mustCapture) return caps.plans.size > 0;
  const quiet = allQuietMoves(board, color);
  return quiet.size > 0;
}

// ---- Rooms & state ----
const rooms = new Map(); // roomId -> roomState

function makeRoomId() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function publicRoomInfo(room) {
  return {
    id: room.id,
    white: room.white ? { username: room.white.username, avatarUrl: room.white.avatarUrl || "" } : null,
    black: room.black ? { username: room.black.username, avatarUrl: room.black.avatarUrl || "" } : null,
    spectators: room.spectators.size,
    status: room.status
  };
}

async function getUserPublic(username) {
  const users = await readUsers();
  const u = users[username.toLowerCase()];
  return u ? safeUserPublic(u) : null;
}

// ===== BOT helpers =====
function rnd(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}
function makeBotSeat(roomId, color) {
  return { username: `BOT_${roomId}_${color.toUpperCase()}`, avatarUrl: "", isBot: true };
}
function seatIsBot(seat) {
  return !!seat?.isBot || (typeof seat?.username === "string" && seat.username.startsWith("BOT_"));
}
function botColor(room) {
  if (seatIsBot(room.white)) return "w";
  if (seatIsBot(room.black)) return "b";
  return null;
}
function botUsername(room) {
  if (seatIsBot(room.white)) return room.white.username;
  if (seatIsBot(room.black)) return room.black.username;
  return null;
}
function otherHumanUsername(room, myColor) {
  if (myColor === "w") return room.black && !seatIsBot(room.black) ? room.black.username : null;
  return room.white && !seatIsBot(room.white) ? room.white.username : null;
}

function roomStatePayload(room) {
  return {
    id: room.id,
    board: room.board,
    turn: room.turn,
    status: room.status,
    lastMove: room.lastMove || null,
    white: room.white ? { username: room.white.username, avatarUrl: room.white.avatarUrl || "" } : null,
    black: room.black ? { username: room.black.username, avatarUrl: room.black.avatarUrl || "" } : null,
    winner: room.winner || null,
    reason: room.reason || null,
    ranked: room.ranked
      ? {
          eligible: !!room.ranked.eligible,
          status: room.ranked.status || "none",
          winner: room.ranked.winner || null,
          loser: room.ranked.loser || null,
          deadline: room.ranked.deadline || null,
          awarded: !!room.ranked.awarded,
          reason: room.ranked.reason || null
        }
      : { eligible: false, status: "none", winner: null, loser: null, deadline: null, awarded: false, reason: null }
  };
}

function emitRoomList() {
  const list = Array.from(rooms.values()).map(publicRoomInfo);
  io.to("lobby").emit("room:list", list);
}

function emitOnlineCount() {
  io.emit("online:count", io.engine.clientsCount);
}

function findSocketIdByUsername(username) {
  if (!username) return null;
  for (const [id, s] of io.of("/").sockets) {
    if (s.username === username) return id;
  }
  return null;
}

// ===== Turn move packaging =====
function buildYourMoves(room, color) {
  // pending chain: only that piece can move
  if (room.pending && room.pending.color === color) {
    const key = `${room.pending.cur[0]},${room.pending.cur[1]}`;
    const nextTo = new Set();
    for (const seq of room.pending.remainingSeqs) {
      const nxt = seq[room.pending.stepIndex];
      if (nxt) nextTo.add(`${nxt[0]},${nxt[1]}`);
    }
    const tos = Array.from(nextTo).map((s) => s.split(",").map((n) => parseInt(n, 10)));
    return {
      pending: true,
      mustCapture: true,
      selectable: [room.pending.cur],
      moves: { [key]: tos }
    };
  }

  const cap = allCapturePlans(room.board, color);
  if (cap.mustCapture) {
    const selectable = [];
    const moves = {};
    for (const [from, seqs] of cap.plans.entries()) {
      const [fr, fc] = from.split(",").map((n) => parseInt(n, 10));
      selectable.push([fr, fc]);
      const set = new Set();
      for (const seq of seqs) set.add(`${seq[0][0]},${seq[0][1]}`);
      moves[from] = Array.from(set).map((s) => s.split(",").map((n) => parseInt(n, 10)));
    }
    room.turnPlan = { color, capPlans: cap.plans, maxCap: cap.maxCap };
    return { pending: false, mustCapture: true, selectable, moves };
  }

  const quiet = allQuietMoves(room.board, color);
  const selectable = [];
  const moves = {};
  for (const [from, tos] of quiet.entries()) {
    const [fr, fc] = from.split(",").map((n) => parseInt(n, 10));
    selectable.push([fr, fc]);
    moves[from] = tos;
  }
  room.turnPlan = { color, capPlans: new Map(), maxCap: 0 };
  return { pending: false, mustCapture: false, selectable, moves };
}

async function updateStatsOnResult(winnerUsername, loserUsername) {
  if (!winnerUsername || !loserUsername) return;
  if (winnerUsername.startsWith("BOT_") || loserUsername.startsWith("BOT_")) return;

  const users = await readUsers();
  const wKey = winnerUsername.toLowerCase();
  const lKey = loserUsername.toLowerCase();
  if (!users[wKey] || !users[lKey]) return;

  users[wKey].stats.wins += 1;
  users[wKey].stats.xp += 25;
  users[wKey].stats.rating += 10;

  users[lKey].stats.losses += 1;
  users[lKey].stats.xp += 5;
  users[lKey].stats.rating = Math.max(800, (users[lKey].stats.rating || 1000) - 8);

  await atomicWriteJSON(USERS_FILE, users);
  io.emit("leaderboard:top10", computeTop10(users));
}

function scheduleBotIfWaiting(room) {
  if (!room || room.status !== "waiting") return;
  if (room.botTimer) return;

  const wHuman = room.white && !seatIsBot(room.white);
  const bHuman = room.black && !seatIsBot(room.black);

  const hasExactlyOneHuman = (wHuman && !room.black) || (bHuman && !room.white);
  if (!hasExactlyOneHuman) return;

  room.botTimer = setTimeout(() => {
    room.botTimer = null;

    const current = rooms.get(room.id);
    if (!current || current.status !== "waiting") return;
    if (current.white && current.black) return;

    const wH = current.white && !seatIsBot(current.white);
    const bH = current.black && !seatIsBot(current.black);

    if (wH && !current.black) current.black = makeBotSeat(current.id, "b");
    else if (bH && !current.white) current.white = makeBotSeat(current.id, "w");
    else return;

    current.status = "playing";
    current.winner = null;
    current.reason = null;
    current.pending = null;
    current.turnPlan = null;
    current.lastMove = null;

    // REMATCH reset
    current.rematch = { w: false, b: false };

    io.to(current.id).emit("game:state", roomStatePayload(current));
    emitRoomList();
    sendTurnMoves(current);
  }, BOT_JOIN_WAIT_MS);
}

function clearBotTimers(room) {
  if (!room) return;
  if (room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }
  if (room.botThinkTimer) {
    clearTimeout(room.botThinkTimer);
    room.botThinkTimer = null;
  }
}

function finishGame(room, winnerUsername, reason) {
  room.status = "finished";
  room.winner = winnerUsername || null;
  room.reason = reason || "END";
  room.pending = null;
  room.turnPlan = null;

  // REMATCH: reset uz “neviens nav apstiprinājis”
  room.rematch = { w: false, b: false };

  io.to(room.id).emit("game:state", roomStatePayload(room));
  emitRoomList();
}

// ===== Ranked forfeit (disconnect) =====
function ensureRanked(room) {
  if (!room.ranked) {
    room.ranked = {
      eligible: false,
      status: "none",
      winner: null,
      loser: null,
      deadline: null,
      reason: null,
      timer: null,
      awarded: false
    };
  }
}
function clearRankedTimer(room) {
  if (room?.ranked?.timer) {
    clearTimeout(room.ranked.timer);
    room.ranked.timer = null;
  }
}
function cancelForfeitIfReturning(room, username) {
  if (!room?.ranked) return;
  if (room.ranked.status !== "pending") return;
  if (room.ranked.loser !== username) return;

  clearRankedTimer(room);
  room.ranked.status = "none";
  room.ranked.winner = null;
  room.ranked.loser = null;
  room.ranked.deadline = null;
  room.ranked.reason = null;
  room.ranked.awarded = false;
}
function startForfeitTimer(room, winner, loser) {
  ensureRanked(room);
  if (!room.ranked.eligible) return;
  if (room.ranked.awarded) return;
  if (room.ranked.status === "pending") return;

  room.ranked.status = "pending";
  room.ranked.winner = winner;
  room.ranked.loser = loser;
  room.ranked.deadline = Date.now() + FORFEIT_GRACE_MS;
  room.ranked.reason = "DISCONNECT";
  room.ranked.awarded = false;

  clearRankedTimer(room);
  room.ranked.timer = setTimeout(async () => {
    const stillLoserMissing =
      room.white?.username !== loser &&
      room.black?.username !== loser;

    if (!stillLoserMissing) {
      cancelForfeitIfReturning(room, loser);
      io.to(room.id).emit("game:state", roomStatePayload(room));
      return;
    }

    room.ranked.status = "awarded";
    room.ranked.awarded = true;
    room.ranked.timer = null;

    await updateStatsOnResult(winner, loser);

    io.to(room.id).emit("ranked:forfeit", { winner, loser });
    io.to(room.id).emit("game:state", roomStatePayload(room));
  }, FORFEIT_GRACE_MS);
}

// ===== REMATCH / NEXT GAME (tajā pašā room) =====
function resetRoomForNewGame(room, { forceBotIfSolo = true, swapColors = true } = {}) {
  clearBotTimers(room);
  clearRankedTimer(room);

  // ✅ GODĪGA MAIŅA: ja ir abi sēdekļi (white+black), katrai nākamajai spēlei apmainām krāsas
  if (swapColors && room.white && room.black) {
    const tmp = room.white;
    room.white = room.black;
    room.black = tmp;
  }

  room.board = initialBoard();
  room.turn = "w";
  room.status = "waiting";

  room.pending = null;
  room.turnPlan = null;
  room.winner = null;
  room.reason = null;
  room.lastMove = null;

  room.rematch = { w: false, b: false };

  ensureRanked(room);
  room.ranked.status = "none";
  room.ranked.winner = null;
  room.ranked.loser = null;
  room.ranked.deadline = null;
  room.ranked.reason = null;
  room.ranked.awarded = false;
  room.ranked.timer = null;

  const bothSeatsPresent = !!room.white && !!room.black;

  if (!bothSeatsPresent && forceBotIfSolo) {
    const wHuman = room.white && !seatIsBot(room.white);
    const bHuman = room.black && !seatIsBot(room.black);

    if (wHuman && !room.black) room.black = makeBotSeat(room.id, "b");
    else if (bHuman && !room.white) room.white = makeBotSeat(room.id, "w");
  }

  if (room.white && room.black) room.status = "playing";
  else room.status = "waiting";

  // ranked tikai cilvēks pret cilvēku
  if (room.white && room.black && !seatIsBot(room.white) && !seatIsBot(room.black)) {
    room.ranked.eligible = true;
  } else {
    room.ranked.eligible = false;
  }
}
  room.board = initialBoard();
  room.turn = "w";
  room.status = "waiting";

  room.pending = null;
  room.turnPlan = null;
  room.winner = null;
  room.reason = null;
  room.lastMove = null;

  room.rematch = { w: false, b: false };

  ensureRanked(room);
  room.ranked.status = "none";
  room.ranked.winner = null;
  room.ranked.loser = null;
  room.ranked.deadline = null;
  room.ranked.reason = null;
  room.ranked.awarded = false;
  room.ranked.timer = null;

  const bothSeatsPresent = !!room.white && !!room.black;

  if (!bothSeatsPresent && forceBotIfSolo) {
    const wHuman = room.white && !seatIsBot(room.white);
    const bHuman = room.black && !seatIsBot(room.black);

    if (wHuman && !room.black) room.black = makeBotSeat(room.id, "b");
    else if (bHuman && !room.white) room.white = makeBotSeat(room.id, "w");
  }

  if (room.white && room.black) room.status = "playing";
  else room.status = "waiting";

  if (room.white && room.black && !seatIsBot(room.white) && !seatIsBot(room.black)) {
    room.ranked.eligible = true;
  } else {
    room.ranked.eligible = false;
  }
}

function sendTurnMoves(room) {
  if (!room || room.status !== "playing") return;

  const turnColor = room.turn;
  const currentSeat = turnColor === "w" ? room.white : room.black;
  const currentUsername = currentSeat?.username || null;

  if (seatIsBot(currentSeat)) {
    const otherUser = otherHumanUsername(room, turnColor);
    const otherSock = findSocketIdByUsername(otherUser);
    if (otherSock) io.to(otherSock).emit("game:yourMoves", null);

    scheduleBotMove(room);
    return;
  }

  const sId = findSocketIdByUsername(currentUsername);
  if (sId) {
    const legal = buildYourMoves(room, turnColor);
    io.to(sId).emit("game:yourMoves", legal);
  }

  const otherUser = otherHumanUsername(room, turnColor);
  const otherSock = findSocketIdByUsername(otherUser);
  if (otherSock) io.to(otherSock).emit("game:yourMoves", null);
}

function pickBotMove(legal) {
  if (!legal || !legal.moves || !legal.selectable || legal.selectable.length === 0) return null;

  const from = legal.selectable[rnd(0, legal.selectable.length - 1)];
  const key = `${from[0]},${from[1]}`;
  const tos = legal.moves[key] || [];
  if (!tos.length) return null;

  const to = tos[rnd(0, tos.length - 1)];
  return { from, to };
}

function applyMoveCore(room, myColor, from, to, byUsername) {
  const [fr, fc] = from;
  const [tr, tc] = to;

  if (!inBounds(fr, fc) || !inBounds(tr, tc)) return { ok: false };
  if (!isDark(fr, fc) || !isDark(tr, tc)) return { ok: false };
  if (room.board[tr][tc] !== null) return { ok: false };

  const piece = room.board[fr][fc];
  if (!piece || colorOf(piece) !== myColor) return { ok: false };

  const legal = buildYourMoves(room, myColor);
  const key = `${fr},${fc}`;
  const allowedTos = legal?.moves?.[key] || null;
  if (!allowedTos) return { ok: false };
  const okTo = allowedTos.some(([r, c]) => r === tr && c === tc);
  if (!okTo) return { ok: false };

  const dr = tr - fr;
  const dc = tc - fc;
  if (Math.abs(dr) !== Math.abs(dc)) return { ok: false };

  let didCapture = false;
  let captured = findCapturedSquare(room.board, fr, fc, tr, tc);
  if (captured) {
    const [cr, cc] = captured;
    const capPiece = room.board[cr][cc];
    if (!capPiece) return { ok: false };
    if (colorOf(capPiece) !== opponent(myColor)) return { ok: false };
    didCapture = true;
  }

  room.board[fr][fc] = null;
  if (didCapture) {
    const [cr, cc] = captured;
    room.board[cr][cc] = null;
  }

  let newPiece = promoteIfNeeded(piece, tr, myColor);
  room.board[tr][tc] = newPiece;

  room.lastMove = { by: byUsername, from: [fr, fc], to: [tr, tc], capture: didCapture };

  if (didCapture) {
    if (!room.pending) {
      const plan = room.turnPlan;
      const seqs = plan?.capPlans?.get(`${fr},${fc}`) || [];
      const matching = seqs.filter((s) => s[0][0] === tr && s[0][1] === tc);
      room.pending = {
        color: myColor,
        start: [fr, fc],
        cur: [tr, tc],
        stepIndex: 1,
        remainingSeqs: matching
      };
    } else {
      const rem = room.pending.remainingSeqs;
      const idx = room.pending.stepIndex;
      const matching = rem.filter((s) => s[idx] && s[idx][0] === tr && s[idx][1] === tc);
      room.pending.cur = [tr, tc];
      room.pending.stepIndex += 1;
      room.pending.remainingSeqs = matching;
    }

    const stillHasNext = room.pending.remainingSeqs.some((s) => s[room.pending.stepIndex] != null);
    if (stillHasNext) return { ok: true, continued: true };
    room.pending = null;
  }

  room.turn = opponent(room.turn);
  room.turnPlan = null;

  const oppColor = room.turn;
  const oppHas = hasAnyMove(room.board, oppColor);
  if (!oppHas) {
    const winner = myColor === "w" ? room.white?.username : room.black?.username;
    return { ok: true, finished: true, winner, reason: "NO_MOVES" };
  }

  return { ok: true, continued: false, finished: false };
}

function scheduleBotMove(room) {
  if (!room || room.status !== "playing") return;

  const bc = botColor(room);
  if (!bc) return;
  if (room.turn !== bc) return;
  if (room.botThinkTimer) return;

  room.botThinkTimer = setTimeout(async () => {
    room.botThinkTimer = null;

    const current = rooms.get(room.id);
    if (!current || current.status !== "playing") return;

    const botC = botColor(current);
    if (!botC || current.turn !== botC) return;

    const legal = buildYourMoves(current, botC);
    const pick = pickBotMove(legal);
    if (!pick) {
      const human = otherHumanUsername(current, botC);
      finishGame(current, human, "BOT_NO_MOVES");
      return;
    }

    const res = applyMoveCore(current, botC, pick.from, pick.to, botUsername(current) || "BOT");
    io.to(current.id).emit("game:state", roomStatePayload(current));

    if (!res.ok) {
      scheduleBotMove(current);
      return;
    }

    if (res.finished) {
      finishGame(current, res.winner, res.reason);
      if (res.winner) {
        const loser = otherHumanUsername(current, botC);
        await updateStatsOnResult(res.winner, loser);
      }
      return;
    }

    if (res.continued) {
      scheduleBotMove(current);
      return;
    }

    sendTurnMoves(current);
  }, rnd(BOT_THINK_MIN_MS, BOT_THINK_MAX_MS));
}

// ---- Socket events ----
io.on("connection", async (socket) => {
  const me = socket.username;

  socket.join("lobby");
  emitOnlineCount();

  const users = await readUsers();
  socket.emit("leaderboard:top10", computeTop10(users));
  emitRoomList();

  socket.on("lobby:hello", async () => {
    const u = await getUserPublic(me);
    socket.emit("me", u);
    emitRoomList();
    emitOnlineCount();
  });

  // room:create (optional vsBot flag)
  socket.on("room:create", async ({ vsBot } = {}) => {
    const id = makeRoomId();
    const u = await getUserPublic(me);
    if (!u) return;

    const room = {
      id,
      board: initialBoard(),
      turn: "w",
      status: "waiting",
      white: null,
      black: null,
      spectators: new Set(),
      pending: null,
      turnPlan: null,
      winner: null,
      reason: null,
      lastMove: null,
      botTimer: null,
      botThinkTimer: null,
      ranked: { eligible: false, status: "none", winner: null, loser: null, deadline: null, reason: null, timer: null, awarded: false },
      rematch: { w: false, b: false }
    };

    room.white = { username: u.username, avatarUrl: u.avatarUrl };
    rooms.set(id, room);

    emitRoomList();
    socket.emit("room:created", { id });

    if (vsBot) {
      room.black = makeBotSeat(room.id, "b");
      room.status = "playing";
      room.rematch = { w: false, b: false };
      io.to(room.id).emit("game:state", roomStatePayload(room));
      emitRoomList();
      sendTurnMoves(room);
    } else {
      scheduleBotIfWaiting(room);
    }
  });

  // room:join (+ allowCreateIfMissing)
  socket.on("room:join", async ({ id, allowCreateIfMissing } = {}) => {
    id = String(id || "").toUpperCase().trim();
    const u = await getUserPublic(me);
    if (!u) return;

    let room = rooms.get(id);

    // AUTO CREATE, ja nav atrasts
    if (!room) {
      if (!allowCreateIfMissing) {
        return socket.emit("room:error", { error: "ROOM_NOT_FOUND" });
      }
      if (!validRoomId(id)) {
        return socket.emit("room:error", { error: "BAD_ROOM_ID" });
      }

      room = {
        id,
        board: initialBoard(),
        turn: "w",
        status: "waiting",
        white: { username: u.username, avatarUrl: u.avatarUrl },
        black: null,
        spectators: new Set(),
        pending: null,
        turnPlan: null,
        winner: null,
        reason: null,
        lastMove: null,
        botTimer: null,
        botThinkTimer: null,
        ranked: { eligible: false, status: "none", winner: null, loser: null, deadline: null, reason: null, timer: null, awarded: false },
        rematch: { w: false, b: false }
      };

      rooms.set(id, room);

      socket.leave("lobby");
      socket.join(id);

      emitRoomList();
      scheduleBotIfWaiting(room);

      io.to(id).emit("game:state", roomStatePayload(room));
      socket.emit("room:joined", { id, role: "white", created: true });
      socket.emit("game:yourMoves", null);
      return;
    }

    // room eksistē
    socket.leave("lobby");
    socket.join(id);

    cancelForfeitIfReturning(room, u.username);

    if (room.botTimer) {
      clearTimeout(room.botTimer);
      room.botTimer = null;
    }

    let role = "spectator";

    if (!room.white || room.white.username === u.username || seatIsBot(room.white)) {
      room.white = { username: u.username, avatarUrl: u.avatarUrl };
      role = "white";
    } else if (!room.black || room.black.username === u.username || seatIsBot(room.black)) {
      room.black = { username: u.username, avatarUrl: u.avatarUrl };
      role = "black";
    } else {
      room.spectators.add(u.username);
    }

    if (room.white && room.black) {
      if (room.status === "waiting") {
        room.status = "playing";
        room.winner = null;
        room.reason = null;
        room.pending = null;
        room.turnPlan = null;
        room.lastMove = null;
        clearBotTimers(room);
        room.rematch = { w: false, b: false };
      }

      ensureRanked(room);
      if (!room.ranked.eligible && !seatIsBot(room.white) && !seatIsBot(room.black)) {
        room.ranked.eligible = true;
      }
    } else {
      room.status = "waiting";
      room.pending = null;
      room.turnPlan = null;
      scheduleBotIfWaiting(room);
    }

    io.to(id).emit("game:state", roomStatePayload(room));
    emitRoomList();

    socket.emit("room:joined", { id, role });

    if (room.status === "playing") sendTurnMoves(room);
    else socket.emit("game:yourMoves", null);
  });

  socket.on("game:move", async ({ id, from, to }) => {
    id = String(id || "").toUpperCase().trim();
    const room = rooms.get(id);
    if (!room || room.status !== "playing") return;

    const u = await getUserPublic(me);
    if (!u) return;

    const myColor =
      room.white?.username === u.username ? "w" : room.black?.username === u.username ? "b" : null;

    if (!myColor) return;
    if (room.turn !== myColor) return;

    const [fr, fc] = from || [];
    const [tr, tc] = to || [];
    if (![fr, fc, tr, tc].every((n) => Number.isInteger(n))) return;

    const res = applyMoveCore(room, myColor, [fr, fc], [tr, tc], u.username);
    io.to(id).emit("game:state", roomStatePayload(room));

    if (!res.ok) return;

    if (res.finished) {
      finishGame(room, res.winner, res.reason);
      const loser = myColor === "w" ? room.black?.username : room.white?.username;
      if (res.winner && loser) await updateStatsOnResult(res.winner, loser);
      return;
    }

    if (res.continued) {
      const sId = findSocketIdByUsername(u.username);
      if (sId) io.to(sId).emit("game:yourMoves", buildYourMoves(room, myColor));
      return;
    }

    sendTurnMoves(room);
  });

  socket.on("game:resign", async ({ id }) => {
    id = String(id || "").toUpperCase().trim();
    const room = rooms.get(id);
    if (!room || room.status !== "playing") return;

    const u = await getUserPublic(me);
    if (!u) return;

    const myColor =
      room.white?.username === u.username ? "w" : room.black?.username === u.username ? "b" : null;

    if (!myColor) return;

    const winner = myColor === "w" ? room.black?.username : room.white?.username;
    finishGame(room, winner, "RESIGN");

    const loser = u.username;
    if (winner && loser) await updateStatsOnResult(winner, loser);
  });

  // ===== REMATCH event (NEXT GAME tajā pašā room) =====
  socket.on("game:rematch", async ({ id } = {}) => {
    id = String(id || "").toUpperCase().trim();
    const room = rooms.get(id);
    if (!room) return;
    if (room.status !== "finished") return;

    const u = await getUserPublic(me);
    if (!u) return;

    const myColor =
      room.white?.username === u.username ? "w" : room.black?.username === u.username ? "b" : null;

    if (!myColor) return;

    if (!room.rematch) room.rematch = { w: false, b: false };
    room.rematch[myColor] = true;

    const oppColor = opponent(myColor);
    const oppSeat = oppColor === "w" ? room.white : room.black;

    // ja otrs ir BOT -> automātiski piekrīt
    if (seatIsBot(oppSeat)) {
      room.rematch[oppColor] = true;
    }

    // ja otrs nav vispār -> tu vari startēt next game pret BOT
    if (!oppSeat) {
      resetRoomForNewGame(room, { forceBotIfSolo: true });

      io.to(room.id).emit("game:rematchStatus", null);
      io.to(room.id).emit("game:state", roomStatePayload(room));
      emitRoomList();

      if (room.status === "playing") sendTurnMoves(room);
      else scheduleBotIfWaiting(room);
      return;
    }

    io.to(room.id).emit("game:rematchStatus", { w: !!room.rematch.w, b: !!room.rematch.b });

    if (room.rematch.w && room.rematch.b) {
      resetRoomForNewGame(room, { forceBotIfSolo: false });

      io.to(room.id).emit("game:rematchStatus", null);
      io.to(room.id).emit("game:state", roomStatePayload(room));
      emitRoomList();

      if (room.status === "playing") sendTurnMoves(room);
      else scheduleBotIfWaiting(room);
    }
  });

  socket.on("disconnect", async () => {
    emitOnlineCount();

    for (const room of rooms.values()) {
      const wasWhite = room.white?.username === me;
      const wasBlack = room.black?.username === me;
      const wasInSeat = wasWhite || wasBlack;

      room.spectators.delete(me);

      if (wasInSeat && room.status === "playing") {
        ensureRanked(room);

        const other = wasWhite ? room.black : room.white;
        const otherHuman = other && !seatIsBot(other) ? other.username : null;

        if (room.ranked.eligible && otherHuman) {
          startForfeitTimer(room, otherHuman, me);
        }

        if (wasWhite) room.white = makeBotSeat(room.id, "w");
        if (wasBlack) room.black = makeBotSeat(room.id, "b");

        clearBotTimers(room);

        io.to(room.id).emit("game:state", roomStatePayload(room));
        emitRoomList();

        sendTurnMoves(room);
      } else {
        if (wasWhite) room.white = null;
        if (wasBlack) room.black = null;
      }

      const hasHuman =
        (room.white && !seatIsBot(room.white)) ||
        (room.black && !seatIsBot(room.black)) ||
        (room.spectators && room.spectators.size > 0);

      if (!hasHuman) {
        clearBotTimers(room);
        clearRankedTimer(room);
        rooms.delete(room.id);
      }
    }

    emitRoomList();
  });
});

server.listen(PORT, () => {
  console.log("Bugats Dambretes server running on port", PORT);
  console.log("Allowed origins:", ALLOWED_ORIGINS);
  console.log("BOT_JOIN_WAIT_MS:", BOT_JOIN_WAIT_MS);
  console.log("FORFEIT_GRACE_MS:", FORFEIT_GRACE_MS);
});
