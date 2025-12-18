
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
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://thezone.lv,http://localhost:5500,http://127.0.0.1:5500")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

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

// ---- atomic JSON write queue (lai nesalauž fails paralēli rakstot) ----
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
  const arr = Object.values(users).map(u => ({
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

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin));
  },
  credentials: true
}));

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));
app.use("/uploads", express.static(UPLOADS_DIR));

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
  limits: { fileSize: 2 * 1024 * 1024 },
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

app.post("/api/avatar", authMiddleware, upload.single("avatar"), async (req, res) => {
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
  return board.map(row => row.slice());
}

function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
function isDark(r, c) { return (r + c) % 2 === 1; }

function colorOf(p) {
  if (!p) return null;
  return (p === "w" || p === "W") ? "w" : "b";
}
function isKing(p) { return p === "W" || p === "B"; }
function opponent(color) { return color === "w" ? "b" : "w"; }

function promoteIfNeeded(piece, toR, color) {
  if (isKing(piece)) return piece;
  if (color === "w" && toR === 0) return "W";
  if (color === "b" && toR === 7) return "B";
  return piece;
}

// ---- Capture sequence generation (with immediate promotion) ----
const DIRS = [
  [-1, -1], [-1, 1],
  [1, -1], [1, 1]
];

function genCapturesFrom(board, r, c, piece, capturedSet) {
  const color = colorOf(piece);
  const opp = opponent(color);
  const results = [];

  if (!isKing(piece)) {
    // men capture in all diagonal directions in Russian checkers
    for (const [dr, dc] of DIRS) {
      const mr = r + dr, mc = c + dc;
      const lr = r + 2 * dr, lc = c + 2 * dc;
      if (!inBounds(lr, lc)) continue;
      if (!isDark(lr, lc)) continue;

      const mid = board[mr]?.[mc];
      if (!mid) continue;
      if (colorOf(mid) !== opp) continue;
      const midKey = `${mr},${mc}`;
      if (capturedSet.has(midKey)) continue;

      if (board[lr][lc] !== null) continue;

      // simulate
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
    let rr = r + dr, cc = c + dc;
    let foundOpp = null;

    while (inBounds(rr, cc) && isDark(rr, cc)) {
      const cell = board[rr][cc];

      if (cell === null) {
        if (foundOpp) {
          // landing after capturing foundOpp
          const [or, oc] = foundOpp;
          const oppKey = `${or},${oc}`;
          if (capturedSet.has(oppKey)) { rr += dr; cc += dc; continue; }

          // simulate landing
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
        rr += dr; cc += dc;
        continue;
      }

      // piece encountered
      if (colorOf(cell) === color) break; // blocked by own
      if (colorOf(cell) === opp) {
        // if already found opponent, cannot jump over two in one segment
        if (foundOpp) break;
        foundOpp = [rr, cc];
        rr += dr; cc += dc;
        continue;
      }

      rr += dr; cc += dc;
    }
  }

  return results;
}

function allCapturePlans(board, color) {
  const plans = new Map(); // key "r,c" -> array of sequences (each seq is [ [r1,c1], [r2,c2], ... ] landings)
  let maxCap = 0;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      if (colorOf(p) !== color) continue;
      const seqs = genCapturesFrom(board, r, c, p, new Set());
      if (seqs.length > 0) {
        // captures count = seq length
        for (const s of seqs) maxCap = Math.max(maxCap, s.length);
        plans.set(`${r},${c}`, seqs);
      }
    }
  }

  if (maxCap === 0) return { mustCapture: false, maxCap: 0, plans: new Map() };

  // filter only max capture sequences (Russian rule: must capture maximum)
  const filtered = new Map();
  for (const [from, seqs] of plans.entries()) {
    const keep = seqs.filter(s => s.length === maxCap);
    if (keep.length) filtered.set(from, keep);
  }
  return { mustCapture: true, maxCap, plans: filtered };
}

function allQuietMoves(board, color) {
  // only when no captures exist
  const moves = new Map(); // "r,c" -> array of to squares [[r,c],...]
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      if (colorOf(p) !== color) continue;

      if (!isKing(p)) {
        const dr = (color === "w") ? -1 : 1;
        for (const dc of [-1, 1]) {
          const nr = r + dr, nc = c + dc;
          if (!inBounds(nr, nc)) continue;
          if (!isDark(nr, nc)) continue;
          if (board[nr][nc] !== null) continue;
          const key = `${r},${c}`;
          if (!moves.has(key)) moves.set(key, []);
          moves.get(key).push([nr, nc]);
        }
      } else {
        for (const [dr, dc] of DIRS) {
          let nr = r + dr, nc = c + dc;
          while (inBounds(nr, nc) && isDark(nr, nc) && board[nr][nc] === null) {
            const key = `${r},${c}`;
            if (!moves.has(key)) moves.set(key, []);
            moves.get(key).push([nr, nc]);
            nr += dr; nc += dc;
          }
        }
      }
    }
  }
  return moves;
}

function findCapturedSquare(board, fr, fc, tr, tc) {
  // assumes diagonal move
  const dr = Math.sign(tr - fr);
  const dc = Math.sign(tc - fc);
  let r = fr + dr, c = fc + dc;
  let found = null;

  while (r !== tr && c !== tc) {
    const p = board[r][c];
    if (p !== null) {
      if (found) return null; // more than one piece in between
      found = [r, c];
    }
    r += dr; c += dc;
  }
  return found; // may be null for quiet move
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
    white: room.white ? { username: room.white.username, avatarUrl: room.white.avatarUrl } : null,
    black: room.black ? { username: room.black.username, avatarUrl: room.black.avatarUrl } : null,
    spectators: room.spectators.size,
    status: room.status
  };
}

async function getUserPublic(username) {
  const users = await readUsers();
  const u = users[username.toLowerCase()];
  return u ? safeUserPublic(u) : null;
}

function buildYourMoves(room, color) {
  // if pending chain -> only that piece can move and only next steps allowed
  if (room.pending && room.pending.color === color) {
    const key = `${room.pending.cur[0]},${room.pending.cur[1]}`;
    const nextIndex = room.pending.stepIndex + 1; // landings index in sequence
    const nextTo = new Set();

    for (const seq of room.pending.remainingSeqs) {
      const step = seq[nextIndex - 1]; // seq contains landings only; stepIndex counts landings done
      // careful: pending.stepIndex = number of landings already done
      // next landing is seq[pending.stepIndex]
      const nxt = seq[room.pending.stepIndex];
      if (nxt) nextTo.add(`${nxt[0]},${nxt[1]}`);
    }
    const tos = Array.from(nextTo).map(s => s.split(",").map(n => parseInt(n, 10)));
    return {
      pending: true,
      mustCapture: true,
      selectable: [room.pending.cur],
      moves: { [key]: tos }
    };
  }

  // not pending -> compute captures; if none, compute quiet moves
  const cap = allCapturePlans(room.board, color);
  if (cap.mustCapture) {
    const selectable = [];
    const moves = {};
    for (const [from, seqs] of cap.plans.entries()) {
      const [fr, fc] = from.split(",").map(n => parseInt(n, 10));
      selectable.push([fr, fc]);

      // allowed first steps: unique of seq[0]
      const set = new Set();
      for (const seq of seqs) set.add(`${seq[0][0]},${seq[0][1]}`);
      moves[from] = Array.from(set).map(s => s.split(",").map(n => parseInt(n, 10)));
    }
    room.turnPlan = { color, capPlans: cap.plans, maxCap: cap.maxCap };
    return { pending: false, mustCapture: true, selectable, moves };
  }

  const quiet = allQuietMoves(room.board, color);
  const selectable = [];
  const moves = {};
  for (const [from, tos] of quiet.entries()) {
    const [fr, fc] = from.split(",").map(n => parseInt(n, 10));
    selectable.push([fr, fc]);
    moves[from] = tos;
  }
  room.turnPlan = { color, capPlans: new Map(), maxCap: 0 };
  return { pending: false, mustCapture: false, selectable, moves };
}

function emitRoomList() {
  const list = Array.from(rooms.values()).map(publicRoomInfo);
  io.to("lobby").emit("room:list", list);
}

function emitOnlineCount() {
  io.emit("online:count", io.engine.clientsCount);
}

async function updateStatsOnResult(winnerUsername, loserUsername) {
  const users = await readUsers();
  const wKey = winnerUsername.toLowerCase();
  const lKey = loserUsername.toLowerCase();
  if (!users[wKey] || !users[lKey]) return;

  // basic competitive numbers
  users[wKey].stats.wins += 1;
  users[wKey].stats.xp += 25;
  users[wKey].stats.rating += 10;

  users[lKey].stats.losses += 1;
  users[lKey].stats.xp += 5;
  users[lKey].stats.rating = Math.max(800, (users[lKey].stats.rating || 1000) - 8);

  await atomicWriteJSON(USERS_FILE, users);

  io.emit("leaderboard:top10", computeTop10(users));
}

function roomStatePayload(room) {
  return {
    id: room.id,
    board: room.board,
    turn: room.turn,
    status: room.status,
    lastMove: room.lastMove || null,
    white: room.white ? { username: room.white.username, avatarUrl: room.white.avatarUrl } : null,
    black: room.black ? { username: room.black.username, avatarUrl: room.black.avatarUrl } : null,
    winner: room.winner || null,
    reason: room.reason || null
  };
}

// ---- Socket events ----
io.on("connection", async (socket) => {
  const me = socket.username;

  socket.join("lobby");
  emitOnlineCount();

  // initial lobby data
  const users = await readUsers();
  socket.emit("leaderboard:top10", computeTop10(users));
  emitRoomList();

  socket.on("lobby:hello", async () => {
    const u = await getUserPublic(me);
    socket.emit("me", u);
    emitRoomList();
    emitOnlineCount();
  });

  socket.on("room:create", async () => {
    const id = makeRoomId();
    const u = await getUserPublic(me);
    if (!u) return;

    const room = {
      id,
      board: initialBoard(),
      turn: "w",
      status: "waiting", // waiting|playing|finished
      white: null,
      black: null,
      spectators: new Set(),
      pending: null,
      turnPlan: null,
      winner: null,
      reason: null,
      lastMove: null
    };

    // creator becomes white by default if free
    room.white = { username: u.username, avatarUrl: u.avatarUrl };
    rooms.set(id, room);

    emitRoomList();
    socket.emit("room:created", { id });
  });

  socket.on("room:join", async ({ id }) => {
    id = String(id || "").toUpperCase().trim();
    const room = rooms.get(id);
    const u = await getUserPublic(me);
    if (!room || !u) return socket.emit("room:error", { error: "ROOM_NOT_FOUND" });

    // leave lobby join room
    socket.leave("lobby");
    socket.join(id);

    // assign seat
    let role = "spectator";
    if (!room.white || room.white.username === u.username) {
      room.white = { username: u.username, avatarUrl: u.avatarUrl };
      role = "white";
    } else if (!room.black || room.black.username === u.username) {
      room.black = { username: u.username, avatarUrl: u.avatarUrl };
      role = "black";
    } else {
      room.spectators.add(u.username);
    }

    // start if both present
    if (room.white && room.black) {
      room.status = "playing";
      room.winner = null;
      room.reason = null;
      room.pending = null;
      room.turn = "w";
      room.turnPlan = null;
    }

    io.to(id).emit("game:state", roomStatePayload(room));
    emitRoomList();

    // send legal moves to that socket if it's their turn
    const myColor = (role === "white") ? "w" : (role === "black") ? "b" : null;
    if (room.status === "playing" && myColor && room.turn === myColor) {
      const legal = buildYourMoves(room, myColor);
      socket.emit("game:yourMoves", legal);
    } else {
      socket.emit("game:yourMoves", null);
    }

    socket.emit("room:joined", { id, role });
  });

  socket.on("game:move", async ({ id, from, to }) => {
    id = String(id || "").toUpperCase().trim();
    const room = rooms.get(id);
    if (!room || room.status !== "playing") return;

    const u = await getUserPublic(me);
    if (!u) return;

    const myColor =
      room.white?.username === u.username ? "w" :
      room.black?.username === u.username ? "b" : null;

    if (!myColor) return; // spectator can't move
    if (room.turn !== myColor) return;

    const [fr, fc] = from || [];
    const [tr, tc] = to || [];
    if (![fr, fc, tr, tc].every(n => Number.isInteger(n))) return;
    if (!inBounds(fr, fc) || !inBounds(tr, tc)) return;
    if (!isDark(tr, tc) || !isDark(fr, fc)) return;

    const piece = room.board[fr][fc];
    if (!piece || colorOf(piece) !== myColor) return;
    if (room.board[tr][tc] !== null) return;

    const legal = buildYourMoves(room, myColor);
    if (!legal) return;

    const key = `${fr},${fc}`;
    const allowedTos = (legal.moves && legal.moves[key]) ? legal.moves[key] : null;
    if (!allowedTos) return;

    const okTo = allowedTos.some(([r, c]) => r === tr && c === tc);
    if (!okTo) return;

    // determine capture or quiet
    let didCapture = false;
    let captured = null;

    const dr = tr - fr;
    const dc = tc - fc;
    if (Math.abs(dr) === Math.abs(dc)) {
      captured = findCapturedSquare(room.board, fr, fc, tr, tc);
    } else {
      return; // must be diagonal always
    }

    if (captured) {
      const [cr, cc] = captured;
      const capPiece = room.board[cr][cc];
      if (!capPiece) return;
      if (colorOf(capPiece) !== opponent(myColor)) return;
      didCapture = true;
    }

    // apply move
    room.board[fr][fc] = null;
    if (didCapture) {
      const [cr, cc] = captured;
      room.board[cr][cc] = null;
    }

    let newPiece = piece;
    newPiece = promoteIfNeeded(newPiece, tr, myColor);
    room.board[tr][tc] = newPiece;

    room.lastMove = { by: u.username, from: [fr, fc], to: [tr, tc], capture: didCapture };
    io.to(id).emit("game:state", roomStatePayload(room));

    // handle pending capture chain based on max-capture sequences
    if (didCapture) {
      // if no pending yet -> lock to matching sequences
      if (!room.pending) {
        const plan = room.turnPlan;
        if (!plan || plan.color !== myColor || !plan.capPlans) return;

        const seqs = plan.capPlans.get(`${fr},${fc}`) || [];
        // sequences are landings only; must match first landing
        const matching = seqs.filter(s => s[0][0] === tr && s[0][1] === tc);
        room.pending = {
          color: myColor,
          start: [fr, fc],
          cur: [tr, tc],
          stepIndex: 1, // landings done
          remainingSeqs: matching
        };
      } else {
        // continue
        const rem = room.pending.remainingSeqs;
        const idx = room.pending.stepIndex; // next landing index is idx (0-based)
        const matching = rem.filter(s => s[idx] && s[idx][0] === tr && s[idx][1] === tc);
        room.pending.cur = [tr, tc];
        room.pending.stepIndex += 1;
        room.pending.remainingSeqs = matching;
      }

      // check if chain must continue (if any remaining sequences still have next step)
      const stillHasNext = room.pending.remainingSeqs.some(s => s[room.pending.stepIndex] != null);

      if (stillHasNext) {
        // same player's turn continues
        const yours = buildYourMoves(room, myColor);
        // send to current mover
        const moverSocketId = socket.id;
        io.to(moverSocketId).emit("game:yourMoves", yours);
        // opponent gets nothing
        const oppSock = (myColor === "w")
          ? findSocketIdByUsername(room.black?.username)
          : findSocketIdByUsername(room.white?.username);
        if (oppSock) io.to(oppSock).emit("game:yourMoves", null);
        return;
      }

      // chain complete -> clear pending
      room.pending = null;
    }

    // end of turn
    room.turn = opponent(room.turn);
    room.turnPlan = null;

    // check win condition: opponent no pieces or no moves
    const oppColor = room.turn;
    const oppHas = hasAnyMove(room.board, oppColor);

    if (!oppHas) {
      room.status = "finished";
      room.winner = (myColor === "w") ? room.white?.username : room.black?.username;
      room.reason = "NO_MOVES";

      io.to(id).emit("game:state", roomStatePayload(room));

      const loser = (myColor === "w") ? room.black?.username : room.white?.username;
      if (room.winner && loser) await updateStatsOnResult(room.winner, loser);

      emitRoomList();
      return;
    }

    // send legal moves to new turn player
    const nextPlayerUsername = (room.turn === "w") ? room.white?.username : room.black?.username;
    const nextSock = findSocketIdByUsername(nextPlayerUsername);
    if (nextSock) {
      const legalNext = buildYourMoves(room, room.turn);
      io.to(nextSock).emit("game:yourMoves", legalNext);
    }

    // clear for other
    const otherUsername = (room.turn === "w") ? room.black?.username : room.white?.username;
    const otherSock = findSocketIdByUsername(otherUsername);
    if (otherSock) io.to(otherSock).emit("game:yourMoves", null);

    io.to(id).emit("game:state", roomStatePayload(room));
  });

  socket.on("game:resign", async ({ id }) => {
    id = String(id || "").toUpperCase().trim();
    const room = rooms.get(id);
    if (!room || room.status !== "playing") return;

    const u = await getUserPublic(me);
    if (!u) return;

    const myColor =
      room.white?.username === u.username ? "w" :
      room.black?.username === u.username ? "b" : null;

    if (!myColor) return;

    room.status = "finished";
    room.winner = (myColor === "w") ? room.black?.username : room.white?.username;
    room.reason = "RESIGN";

    io.to(id).emit("game:state", roomStatePayload(room));

    const loser = u.username;
    if (room.winner && loser) await updateStatsOnResult(room.winner, loser);

    emitRoomList();
  });

  socket.on("disconnect", () => {
    emitOnlineCount();

    // remove from rooms seats if present
    for (const room of rooms.values()) {
      if (room.white?.username === me) room.white = null;
      if (room.black?.username === me) room.black = null;
      room.spectators.delete(me);

      if (room.status === "playing") {
        // if a seat drops, pause/finish
        room.status = "waiting";
        room.winner = null;
        room.reason = null;
        room.pending = null;
        room.turnPlan = null;
      }

      // remove empty rooms
      const empty = !room.white && !room.black && room.spectators.size === 0;
      if (empty) rooms.delete(room.id);
    }

    emitRoomList();
  });
});

// helper to find socket id by username
function findSocketIdByUsername(username) {
  if (!username) return null;
  for (const [id, s] of io.of("/").sockets) {
    if (s.username === username) return id;
  }
  return null;
}

server.listen(PORT, () => {
  console.log("Bugats Dambretes server running on port", PORT);
  console.log("Allowed origins:", ALLOWED_ORIGINS);
});
