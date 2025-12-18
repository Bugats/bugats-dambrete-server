import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";

// ===== Konstantes =====
const PORT = process.env.PORT || 3000;
const SIZE = 8; // 8x8 dambretes dēlis

// ===== Express app =====
const app = express();
app.use(cors());
app.use(express.json());

// Vienkāršs health-check
app.get("/", (_req, res) => {
  res.send("Bugats Dambrete serveris strādā.");
});

// ===== HTTP + Socket.IO =====
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Hostinger HTML var pieslēgties
    methods: ["GET", "POST"],
  },
});

// ===== Palīgfunkcijas online skaitam =====
function broadcastOnlineCount() {
  const count = io.of("/").sockets.size;
  io.emit("onlineCount", { count });
}

// ===== Spēles loģika (dēlis, gājieni) =====
function createInitialBoard() {
  const board = [];
  for (let r = 0; r < SIZE; r++) {
    const row = [];
    for (let c = 0; c < SIZE; c++) {
      let piece = null;
      const dark = (r + c) % 2 === 1;
      if (dark && r < 3) {
        // melnie augšā
        piece = { color: "b", king: false };
      } else if (dark && r > 4) {
        // baltie apakšā
        piece = { color: "w", king: false };
      }
      row.push(piece);
    }
    board.push(row);
  }
  return board;
}

function inside(r, c) {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

// visi iespējamie gājieni vienam kauliņam
function getMovesForPiece(board, row, col, onlyJumps = false, playerColor = null) {
  const piece = board[row]?.[col];
  if (!piece) return [];
  const color = playerColor || piece.color;
  if (piece.color !== color) return [];

  const dirs = [];
  if (piece.king) {
    dirs.push([-1, -1], [-1, 1], [1, -1], [1, 1]);
  } else if (piece.color === "b") {
    // melnie iet uz leju (r++)
    dirs.push([1, -1], [1, 1]);
  } else {
    // baltie iet uz augšu (r--)
    dirs.push([-1, -1], [-1, 1]);
  }

  const moves = [];

  for (const [dr, dc] of dirs) {
    const nr = row + dr;
    const nc = col + dc;

    // vienkāršs gājiens
    if (!onlyJumps && inside(nr, nc) && !board[nr][nc]) {
      moves.push({
        from: { row, col },
        to: { row: nr, col: nc },
        type: "move",
        captured: [],
      });
    }

    // ņemšana
    const jr = row + 2 * dr;
    const jc = col + 2 * dc;
    const mr = row + dr;
    const mc = col + dc;
    if (
      inside(jr, jc) &&
      inside(mr, mc) &&
      board[mr][mc] &&
      board[mr][mc].color !== piece.color &&
      !board[jr][jc]
    ) {
      moves.push({
        from: { row, col },
        to: { row: jr, col: jc },
        type: "jump",
        captured: [{ row: mr, col: mc }],
      });
    }
  }

  if (onlyJumps) {
    return moves.filter((m) => m.type === "jump");
  }
  return moves;
}

// vai spēlētājam ir vismaz viens ņemšanas gājiens
function playerHasAnyJump(board, playerColor) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const p = board[r][c];
      if (!p || p.color !== playerColor) continue;
      const jumps = getMovesForPiece(board, r, c, true, playerColor);
      if (jumps.length > 0) return true;
    }
  }
  return false;
}

// vai spēlētājam IR jebkāds legāls gājiens
function hasAnyMove(board, playerColor) {
  const mandatoryJump = playerHasAnyJump(board, playerColor);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const p = board[r][c];
      if (!p || p.color !== playerColor) continue;
      let moves;
      if (mandatoryJump) {
        moves = getMovesForPiece(board, r, c, true, playerColor);
      } else {
        moves = getMovesForPiece(board, r, c, false, playerColor);
      }
      if (moves.length > 0) return true;
    }
  }
  return false;
}

function maybeKing(piece, row) {
  if (!piece.king) {
    if (piece.color === "b" && row === SIZE - 1) {
      piece.king = true;
    } else if (piece.color === "w" && row === 0) {
      piece.king = true;
    }
  }
}

// reālā gājiena aplikācija servera pusē
function applyMove(room, playerColor, from, to) {
  const board = room.board;

  if (room.gameOver) {
    return { ok: false, reason: "gameOver" };
  }
  if (room.currentPlayer !== playerColor) {
    return { ok: false, reason: "notYourTurn" };
  }
  if (!inside(from.row, from.col) || !inside(to.row, to.col)) {
    return { ok: false, reason: "outOfBoard" };
  }

  const piece = board[from.row][from.col];
  if (!piece || piece.color !== playerColor) {
    return { ok: false, reason: "noPiece" };
  }

  let allowedMoves = [];

  if (room.mustContinueJump) {
    // drīkst tikai ar to pašu kauliņu un tikai ņemšanu
    if (
      !room.forceFrom ||
      room.forceFrom.row !== from.row ||
      room.forceFrom.col !== from.col
    ) {
      return { ok: false, reason: "mustContinueJump" };
    }
    allowedMoves = getMovesForPiece(board, from.row, from.col, true, playerColor);
  } else {
    const mandatoryJump = playerHasAnyJump(board, playerColor);
    const allMoves = getMovesForPiece(board, from.row, from.col, false, playerColor);
    allowedMoves = mandatoryJump
      ? allMoves.filter((m) => m.type === "jump")
      : allMoves;
  }

  if (!allowedMoves.length) {
    return { ok: false, reason: "noMovesFromPiece" };
  }

  const move = allowedMoves.find(
    (m) => m.to.row === to.row && m.to.col === to.col
  );
  if (!move) {
    return { ok: false, reason: "illegalDestination" };
  }

  // ==== Veicam gājienu ====
  board[from.row][from.col] = null;
  board[to.row][to.col] = piece;

  if (move.captured && move.captured.length > 0) {
    for (const cap of move.captured) {
      board[cap.row][cap.col] = null;
    }
  }

  maybeKing(piece, to.row);

  if (move.type === "jump") {
    const moreJumps = getMovesForPiece(board, to.row, to.col, true, playerColor);
    if (moreJumps.length > 0) {
      // jāņem tālāk
      room.mustContinueJump = true;
      room.forceFrom = { row: to.row, col: to.col };
      room.currentPlayer = playerColor; // paliek tas pats
      return { ok: true, continueJump: true };
    }
  }

  // ķēde beigusies
  room.mustContinueJump = false;
  room.forceFrom = null;

  // nākamais spēlētājs
  const next = playerColor === "b" ? "w" : "b";
  room.currentPlayer = next;

  // pārbaudām, vai nākamajam ir gājiens
  if (!hasAnyMove(board, next)) {
    room.gameOver = true;
    room.winner = playerColor;
  }

  return { ok: true, continueJump: false };
}

// ===== Istabas / lobby =====
const rooms = new Map(); // roomId -> room

function generateRoomId() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 4; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function createRoom(hostSocket) {
  const id = generateRoomId();
  const board = createInitialBoard();
  const room = {
    id,
    board,
    currentPlayer: "b", // melnie sāk
    players: {
      b: { socketId: hostSocket.id, nickname: hostSocket.data.nickname || "Spēlētājs" },
      w: null,
    },
    mustContinueJump: false,
    forceFrom: null,
    gameOver: false,
    winner: null,
  };
  rooms.set(id, room);
  return room;
}

function lobbySnapshot() {
  const list = [];
  for (const room of rooms.values()) {
    const players = [];
    if (room.players.b) {
      players.push({ color: "b", nickname: room.players.b.nickname });
    }
    if (room.players.w) {
      players.push({ color: "w", nickname: room.players.w.nickname });
    }
    list.push({
      id: room.id,
      playerCount: players.length,
      players,
      gameOver: room.gameOver,
    });
  }
  return { rooms: list };
}

function broadcastLobby() {
  io.emit("lobbyState", lobbySnapshot());
}

function leaveCurrentRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId || !rooms.has(roomId)) {
    socket.data.roomId = null;
    socket.data.color = null;
    return;
  }

  const room = rooms.get(roomId);

  if (room.players.b && room.players.b.socketId === socket.id) {
    room.players.b = null;
  }
  if (room.players.w && room.players.w.socketId === socket.id) {
    room.players.w = null;
  }

  socket.leave(roomId);
  socket.data.roomId = null;
  socket.data.color = null;

  const stillPlayers =
    (room.players.b ? 1 : 0) + (room.players.w ? 1 : 0);
  if (stillPlayers === 0) {
    rooms.delete(roomId);
  } else {
    io.to(room.id).emit("roomState", room);
  }

  broadcastLobby();
}

// ===== Socket.IO savienojumi =====
io.on("connection", (socket) => {
  console.log("Pieslēdzās:", socket.id);
  socket.data.nickname = "Spēlētājs";
  socket.data.roomId = null;
  socket.data.color = null;

  broadcastOnlineCount();

  socket.on("joinLobby", (payload) => {
    const nick =
      (payload && typeof payload.nickname === "string" && payload.nickname.trim()) ||
      "Spēlētājs";
    socket.data.nickname = nick.slice(0, 16); // max 16 simboli
    socket.emit("lobbyState", lobbySnapshot());
  });

  socket.on("createRoom", () => {
    if (!socket.data.nickname) {
      socket.data.nickname = "Spēlētājs";
    }
    leaveCurrentRoom(socket);
    const room = createRoom(socket);
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.color = "b";

    socket.emit("roomJoined", {
      room,
      yourColor: "b",
    });
    io.to(room.id).emit("roomState", room);
    broadcastLobby();
  });

  socket.on("joinRoom", (payload) => {
    const roomId = payload && payload.roomId;
    if (!roomId || !rooms.has(roomId)) {
      socket.emit("errorMessage", { message: "Istaba neeksistē." });
      return;
    }

    const room = rooms.get(roomId);
    const occupied =
      (room.players.b ? 1 : 0) + (room.players.w ? 1 : 0);
    if (occupied >= 2) {
      socket.emit("errorMessage", { message: "Istaba ir pilna (2/2)." });
      return;
    }

    leaveCurrentRoom(socket);

    let color = null;
    if (!room.players.b) {
      color = "b";
      room.players.b = {
        socketId: socket.id,
        nickname: socket.data.nickname || "Spēlētājs",
      };
    } else if (!room.players.w) {
      color = "w";
      room.players.w = {
        socketId: socket.id,
        nickname: socket.data.nickname || "Spēlētājs",
      };
    }

    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.color = color;

    socket.emit("roomJoined", {
      room,
      yourColor: color,
    });
    io.to(room.id).emit("roomState", room);
    broadcastLobby();
  });

  socket.on("leaveRoom", () => {
    leaveCurrentRoom(socket);
    socket.emit("leftRoom");
  });

  // ===== Spēles gājieni =====
  socket.on("makeMove", (payload) => {
    try {
      const roomId = payload && payload.roomId;
      const from = payload && payload.from;
      const to = payload && payload.to;

      if (!roomId || !rooms.has(roomId)) {
        socket.emit("invalidMove", { reason: "noRoom" });
        return;
      }
      if (!from || !to) {
        socket.emit("invalidMove", { reason: "badPayload" });
        return;
      }
      const room = rooms.get(roomId);
      if (socket.data.roomId !== roomId) {
        socket.emit("invalidMove", { reason: "notInRoom" });
        return;
      }
      const color = socket.data.color;
      if (color !== "b" && color !== "w") {
        socket.emit("invalidMove", { reason: "noColor" });
        return;
      }

      const result = applyMove(room, color, from, to);

      if (!result.ok) {
        // kļūdas tekstu varēsi interpretēt klienta pusē, ja gribēsi
        socket.emit("invalidMove", { reason: result.reason });
        return;
      }

      // nosūtām aktuālo istabas stāvokli abiem spēlētājiem
      io.to(room.id).emit("roomState", room);
      broadcastLobby();
    } catch (err) {
      console.error("makeMove kļūda:", err);
      socket.emit("invalidMove", { reason: "serverError" });
    }
  });

  socket.on("disconnect", () => {
    console.log("Atvienojās:", socket.id);
    leaveCurrentRoom(socket);
    broadcastOnlineCount();
  });
});

// ===== Servera palaišana =====
httpServer.listen(PORT, () => {
  console.log("Bugats Dambretes serveris klausās uz porta", PORT);
});
