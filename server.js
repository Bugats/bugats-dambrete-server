import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";

const PORT = process.env.PORT || 10080;
const JWT_SECRET = process.env.JWT_SECRET || "BUGATS_DAMBRETE_SECRET";
const DATA_FILE = path.join(process.cwd(), "users.json");
const UPLOAD_DIR = path.join(process.cwd(), "uploads");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ users: [] }, null, 2));

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { users: [] };
  }
}
function writeDB(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function publicUser(u) {
  return {
    username: u.username,
    avatarUrl: u.avatarUrl || "",
    stats: u.stats || { rating: 1000, xp: 0, wins: 0, losses: 0 }
  };
}

function signToken(username) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: "30d" });
}

function authHttp(req, res, next) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: "NO_TOKEN" });
  try {
    req.user = jwt.verify(m[1], JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "BAD_TOKEN" });
  }
}

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use("/uploads", express.static(UPLOAD_DIR));

app.post("/api/signup", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) return res.status(400).json({ error: "BAD_USERNAME" });
  if (password.length < 6) return res.status(400).json({ error: "BAD_PASSWORD" });

  const db = readDB();
  if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ error: "USER_EXISTS" });
  }

  const passHash = bcrypt.hashSync(password, 10);
  const user = {
    username,
    passHash,
    avatarUrl: "",
    stats: { rating: 1000, xp: 0, wins: 0, losses: 0 }
  };
  db.users.push(user);
  writeDB(db);

  const token = signToken(username);
  return res.json({ token, user: publicUser(user) });
});

app.post("/api/login", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  const db = readDB();
  const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return res.status(400).json({ error: "BAD_LOGIN" });
  if (!bcrypt.compareSync(password, user.passHash)) return res.status(400).json({ error: "BAD_LOGIN" });

  const token = signToken(user.username);
  return res.json({ token, user: publicUser(user) });
});

app.get("/api/me", authHttp, (req, res) => {
  const db = readDB();
  const user = db.users.find(u => u.username === req.user.username);
  if (!user) return res.status(404).json({ error: "NO_USER" });
  return res.json({ user: publicUser(user) });
});

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname) || "").toLowerCase();
    const safeExt = [".png", ".jpg", ".jpeg", ".webp"].includes(ext) ? ext : ".png";
    cb(null, `ava_${Date.now()}_${Math.random().toString(16).slice(2)}${safeExt}`);
  }
});
const upload = multer({ storage });

app.post("/api/avatar", authHttp, upload.single("avatar"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "NO_FILE" });
  const db = readDB();
  const user = db.users.find(u => u.username === req.user.username);
  if (!user) return res.status(404).json({ error: "NO_USER" });

  user.avatarUrl = `/uploads/${req.file.filename}`;
  writeDB(db);
  return res.json({ avatarUrl: user.avatarUrl });
});

app.get("/api/leaderboard/top10", (_req, res) => {
  const db = readDB();
  const top = [...db.users]
    .sort((a, b) => (b.stats?.rating ?? 1000) - (a.stats?.rating ?? 1000))
    .slice(0, 10)
    .map(u => ({
      username: u.username,
      avatarUrl: u.avatarUrl || "",
      rating: u.stats?.rating ?? 1000,
      xp: u.stats?.xp ?? 0,
      wins: u.stats?.wins ?? 0
    }));
  res.json({ top10: top });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true }
});

// ====== Rooms + Game engine (Krievu dambrete) ======
const rooms = new Map(); // id -> room
let onlineCount = 0;

function genRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function now() { return Date.now(); }
function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
function isDark(r, c) { return (r + c) % 2 === 1; }

function createInitialBoard() {
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 8; c++) if (isDark(r, c)) b[r][c] = "b";
  }
  for (let r = 5; r < 8; r++) {
    for (let c = 0; c < 8; c++) if (isDark(r, c)) b[r][c] = "w";
  }
  return b;
}
function pieceSide(p) { return p ? p.toLowerCase() : null; }
function isKing(p) { return p === "W" || p === "B"; }
function opponent(side) { return side === "w" ? "b" : "w"; }

function cloneBoard(board) {
  return board.map(row => row.slice());
}

function findAllMoves(board, side, mustFrom /* {r,c} or null */) {
  const all = [];
  const captures = [];

  const sideChar = side; // 'w'/'b'
  const opp = opponent(sideChar);

  function addMove(list, mv) { list.push(mv); }

  function genManMoves(r, c, p) {
    const forward = sideChar === "w" ? -1 : 1;
    // non-capture
    for (const dc of [-1, +1]) {
      const nr = r + forward, nc = c + dc;
      if (inBounds(nr, nc) && isDark(nr, nc) && !board[nr][nc]) {
        addMove(all, { from: { r, c }, to: { r: nr, c: nc }, captures: [] });
      }
    }
    // capture (all 4 dirs)
    for (const dr of [-2, +2]) {
      for (const dc of [-2, +2]) {
        const nr = r + dr, nc = c + dc;
        const mr = r + dr / 2, mc = c + dc / 2;
        if (!inBounds(nr, nc) || !isDark(nr, nc)) continue;
        if (board[nr][nc]) continue;
        const mid = board[mr][mc];
        if (mid && pieceSide(mid) === opp) {
          addMove(captures, { from: { r, c }, to: { r: nr, c: nc }, captures: [{ r: mr, c: mc }] });
        }
      }
    }
  }

  function genKingMoves(r, c, p) {
    const dirs = [
      [-1, -1], [-1, +1], [+1, -1], [+1, +1]
    ];

    // non-capture slides
    for (const [dr, dc] of dirs) {
      let nr = r + dr, nc = c + dc;
      while (inBounds(nr, nc) && isDark(nr, nc) && !board[nr][nc]) {
        addMove(all, { from: { r, c }, to: { r: nr, c: nc }, captures: [] });
        nr += dr; nc += dc;
      }
    }

    // capture (jump over exactly one enemy, land on any empty beyond)
    for (const [dr, dc] of dirs) {
      let nr = r + dr, nc = c + dc;
      // skip empty
      while (inBounds(nr, nc) && isDark(nr, nc) && !board[nr][nc]) { nr += dr; nc += dc; }
      if (!inBounds(nr, nc) || !isDark(nr, nc)) continue;
      const hit = board[nr][nc];
      if (!hit || pieceSide(hit) !== opp) continue;

      const hitPos = { r: nr, c: nc };
      // squares after hit must be empty for landing
      nr += dr; nc += dc;
      while (inBounds(nr, nc) && isDark(nr, nc) && !board[nr][nc]) {
        addMove(captures, { from: { r, c }, to: { r: nr, c: nc }, captures: [hitPos] });
        nr += dr; nc += dc;
      }
    }
  }

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (!isDark(r, c)) continue;
      const p = board[r][c];
      if (!p) continue;
      if (pieceSide(p) !== sideChar) continue;
      if (mustFrom && (mustFrom.r !== r || mustFrom.c !== c)) continue;

      if (isKing(p)) genKingMoves(r, c, p);
      else genManMoves(r, c, p);
    }
  }

  // mandatory capture rule
  if (captures.length > 0) return { moves: captures, mustCapture: true };
  return { moves: all, mustCapture: false };
}

function applyMove(room, mv) {
  const b = cloneBoard(room.board);
  const p = b[mv.from.r][mv.from.c];
  b[mv.from.r][mv.from.c] = null;
  b[mv.to.r][mv.to.c] = p;

  // remove captures
  for (const cap of mv.captures) b[cap.r][cap.c] = null;

  // promotion (immediate)
  let placed = b[mv.to.r][mv.to.c];
  if (placed && !isKing(placed)) {
    if (placed === "w" && mv.to.r === 0) placed = "W";
    if (placed === "b" && mv.to.r === 7) placed = "B";
    b[mv.to.r][mv.to.c] = placed;
  }

  room.board = b;

  // check chain capture continuation
  const side = room.turn;
  const cont = findAllMoves(room.board, side, { r: mv.to.r, c: mv.to.c });
  const canContinue = cont.mustCapture && cont.moves.length > 0;

  if (mv.captures.length > 0 && canContinue) {
    room.mustContinue = { r: mv.to.r, c: mv.to.c };
  } else {
    room.mustContinue = null;
    room.turn = opponent(room.turn);
  }

  room.lastMove = mv;
  room.updatedAt = now();
}

function countPieces(board, side) {
  let n = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const p = board[r][c];
    if (p && pieceSide(p) === side) n++;
  }
  return n;
}

function gameState(room) {
  const legal = findAllMoves(room.board, room.turn, room.mustContinue);
  const map = {};
  for (const mv of legal.moves) {
    const k = `${mv.from.r},${mv.from.c}`;
    if (!map[k]) map[k] = [];
    map[k].push({ r: mv.to.r, c: mv.to.c, captures: mv.captures });
  }

  return {
    id: room.id,
    status: room.status,
    turn: room.turn, // 'w' or 'b'
    mustContinue: room.mustContinue,
    mustCapture: legal.mustCapture,
    board: room.board,
    white: room.white || null,
    black: room.black || null,
    bot: room.bot || false,
    legalByFrom: map
  };
}

function serializeRooms() {
  const list = [];
  for (const r of rooms.values()) {
    // cleanup info
    const spectators = r.spectators?.size || 0;
    list.push({
      id: r.id,
      status: r.status,
      bot: !!r.bot,
      spectators,
      white: r.white ? publicUser(r.white) : null,
      black: r.black ? publicUser(r.black) : null
    });
  }
  // newest first
  list.sort((a, b) => (b.id > a.id ? 1 : -1));
  return list;
}

function broadcastLobby() {
  io.emit("room:list", serializeRooms());
  const db = readDB();
  const top10 = [...db.users]
    .sort((a, b) => (b.stats?.rating ?? 1000) - (a.stats?.rating ?? 1000))
    .slice(0, 10)
    .map(u => ({
      username: u.username,
      avatarUrl: u.avatarUrl || "",
      rating: u.stats?.rating ?? 1000,
      xp: u.stats?.xp ?? 0,
      wins: u.stats?.wins ?? 0
    }));
  io.emit("leaderboard:top10", top10);
}

function getUserFromDB(username) {
  const db = readDB();
  return db.users.find(u => u.username === username) || null;
}

function updateStats(winnerName, loserName) {
  const db = readDB();
  const w = db.users.find(u => u.username === winnerName);
  const l = db.users.find(u => u.username === loserName);
  if (w) {
    w.stats.wins = (w.stats.wins || 0) + 1;
    w.stats.xp = (w.stats.xp || 0) + 20;
    w.stats.rating = (w.stats.rating || 1000) + 15;
  }
  if (l) {
    l.stats.losses = (l.stats.losses || 0) + 1;
    l.stats.xp = (l.stats.xp || 0) + 5;
    l.stats.rating = Math.max(0, (l.stats.rating || 1000) - 15);
  }
  writeDB(db);
}

function ensureRoom(id, bot = false) {
  if (rooms.has(id)) return rooms.get(id);
  const room = {
    id,
    status: "waiting",
    board: createInitialBoard(),
    turn: "w",
    mustContinue: null,
    white: null,
    black: null,
    bot: !!bot,
    spectators: new Set(),
    createdAt: now(),
    updatedAt: now(),
    emptySince: null,
    lastMove: null,
    botThinking: false
  };
  rooms.set(id, room);
  return room;
}

function scheduleCleanup() {
  const t = now();
  for (const [id, r] of rooms) {
    const hasPlayers = !!r.white || !!r.black;
    if (!hasPlayers) {
      if (!r.emptySince) r.emptySince = t;
      // keep empty rooms 10 minutes
      if (t - r.emptySince > 10 * 60 * 1000) rooms.delete(id);
    } else {
      r.emptySince = null;
    }
  }
}
setInterval(scheduleCleanup, 30 * 1000);

async function botMaybeMove(room) {
  if (!room.bot) return;
  const botSide = "b"; // bot is always black in this version
  if (room.turn !== botSide) return;
  if (room.status !== "playing") return;
  if (room.botThinking) return;

  room.botThinking = true;
  setTimeout(() => {
    try {
      const legal = findAllMoves(room.board, botSide, room.mustContinue);
      if (!legal.moves.length) {
        // bot has no moves -> white wins
        endGame(room, "w");
        return;
      }
      const mv = legal.moves[Math.floor(Math.random() * legal.moves.length)];
      applyMove(room, mv);
      checkEnd(room);
      io.to(room.id).emit("game:state", gameState(room));
      broadcastLobby();
    } finally {
      room.botThinking = false;
    }
  }, 400);
}

function endGame(room, winnerSide) {
  room.status = "ended";
  const wUser = room.white?.username;
  const bUser = room.black?.username;

  if (winnerSide === "w" && wUser && bUser && bUser !== "BOT") updateStats(wUser, bUser);
  if (winnerSide === "b" && wUser && bUser && bUser !== "BOT") updateStats(bUser, wUser);

  io.to(room.id).emit("game:ended", { winner: winnerSide });
  io.to(room.id).emit("game:state", gameState(room));
  broadcastLobby();
}

function checkEnd(room) {
  const wCount = countPieces(room.board, "w");
  const bCount = countPieces(room.board, "b");
  if (wCount === 0) return endGame(room, "b");
  if (bCount === 0) return endGame(room, "w");

  const legal = findAllMoves(room.board, room.turn, room.mustContinue);
  if (!legal.moves.length) {
    // current player stuck => other wins
    endGame(room, opponent(room.turn));
  }
}

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("NO_TOKEN"));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = getUserFromDB(payload.username);
    if (!user) return next(new Error("NO_USER"));
    socket.user = user;
    next();
  } catch {
    next(new Error("BAD_TOKEN"));
  }
});

io.on("connection", (socket) => {
  onlineCount++;
  io.emit("online:count", onlineCount);

  socket.emit("me", publicUser(socket.user));

  socket.on("lobby:hello", () => {
    socket.emit("online:count", onlineCount);
    socket.emit("room:list", serializeRooms());
    const db = readDB();
    const top10 = [...db.users]
      .sort((a, b) => (b.stats?.rating ?? 1000) - (a.stats?.rating ?? 1000))
      .slice(0, 10)
      .map(u => ({
        username: u.username,
        avatarUrl: u.avatarUrl || "",
        rating: u.stats?.rating ?? 1000,
        xp: u.stats?.xp ?? 0,
        wins: u.stats?.wins ?? 0
      }));
    socket.emit("leaderboard:top10", top10);
  });

  // Create room (optionally with id & bot)
  socket.on("room:create", (payload = {}, cb) => {
    let id = String(payload.id || "").trim().toUpperCase();
    const bot = !!payload.bot;

    if (id) {
      if (!/^[A-Z0-9]{6}$/.test(id)) {
        cb?.({ ok: false, error: "BAD_ROOM_ID" });
        return socket.emit("room:error", { error: "BAD_ROOM_ID" });
      }
      if (rooms.has(id)) {
        cb?.({ ok: false, error: "ROOM_EXISTS" });
        return socket.emit("room:error", { error: "ROOM_EXISTS" });
      }
    } else {
      do { id = genRoomId(); } while (rooms.has(id));
    }

    ensureRoom(id, bot);
    cb?.({ ok: true, id });
    socket.emit("room:created", { id });
    broadcastLobby();
  });

  // Join room (game page)
  socket.on("room:join", ({ id } = {}, cb) => {
    const roomId = String(id || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(roomId)) {
      cb?.({ ok: false, error: "BAD_ROOM_ID" });
      return socket.emit("room:error", { error: "BAD_ROOM_ID" });
    }

    const room = rooms.get(roomId);
    if (!room) {
      cb?.({ ok: false, error: "ROOM_NOT_FOUND" });
      return socket.emit("room:error", { error: "ROOM_NOT_FOUND" });
    }

    socket.join(roomId);

    // assign seat or spectator (allow rejoin)
    const u = socket.user;

    const isWhite = room.white?.username === u.username;
    const isBlack = room.black?.username === u.username;

    if (!room.white && !room.black && room.bot) {
      // bot room: first human is white, bot is black
      room.white = u;
      room.black = { username: "BOT", avatarUrl: "", stats: { rating: 0, xp: 0, wins: 0, losses: 0 } };
      room.status = "playing";
    } else if (isWhite) {
      room.white = u;
    } else if (isBlack) {
      room.black = u;
    } else if (!room.white) {
      room.white = u;
    } else if (!room.black && room.white.username !== u.username) {
      room.black = u;
      room.status = "playing";
    } else {
      room.spectators.add(socket.id);
    }

    room.updatedAt = now();

    cb?.({ ok: true });
    socket.emit("room:joined", { roomId });
    io.to(roomId).emit("game:state", gameState(room));
    broadcastLobby();

    botMaybeMove(room);
  });

  socket.on("game:move", ({ roomId, from, to } = {}) => {
    const id = String(roomId || "").trim().toUpperCase();
    const room = rooms.get(id);
    if (!room) return socket.emit("game:error", { error: "ROOM_NOT_FOUND" });
    if (room.status !== "playing") return socket.emit("game:error", { error: "NOT_PLAYING" });

    const side =
      room.white?.username === socket.user.username ? "w" :
      room.black?.username === socket.user.username ? "b" :
      null;

    if (!side) return socket.emit("game:error", { error: "SPECTATOR" });
    if (room.turn !== side) return socket.emit("game:error", { error: "NOT_YOUR_TURN" });

    const fr = { r: Number(from?.r), c: Number(from?.c) };
    const tt = { r: Number(to?.r), c: Number(to?.c) };
    if (!inBounds(fr.r, fr.c) || !inBounds(tt.r, tt.c)) return socket.emit("game:error", { error: "BAD_MOVE" });

    if (room.mustContinue && (room.mustContinue.r !== fr.r || room.mustContinue.c !== fr.c)) {
      return socket.emit("game:error", { error: "MUST_CONTINUE_CAPTURE" });
    }

    const legal = findAllMoves(room.board, side, room.mustContinue);
    const mv = legal.moves.find(m =>
      m.from.r === fr.r && m.from.c === fr.c && m.to.r === tt.r && m.to.c === tt.c
    );
    if (!mv) return socket.emit("game:error", { error: "ILLEGAL_MOVE" });

    applyMove(room, mv);
    checkEnd(room);
    io.to(id).emit("game:state", gameState(room));
    broadcastLobby();

    botMaybeMove(room);
  });

  socket.on("game:resign", ({ roomId } = {}) => {
    const id = String(roomId || "").trim().toUpperCase();
    const room = rooms.get(id);
    if (!room) return;

    const side =
      room.white?.username === socket.user.username ? "w" :
      room.black?.username === socket.user.username ? "b" :
      null;
    if (!side) return;

    endGame(room, opponent(side));
  });

  socket.on("disconnect", () => {
    onlineCount = Math.max(0, onlineCount - 1);
    io.emit("online:count", onlineCount);

    // remove spectator socket ids
    for (const r of rooms.values()) r.spectators.delete(socket.id);

    broadcastLobby();
  });
});

server.listen(PORT, () => {
  console.log("Dambretes server listening on", PORT);
});
