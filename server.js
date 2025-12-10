// ======== BUGATS DAMBRETE SERVER ========
// Node + Socket.IO, istabas, 1vs1, obligātā ņemšana, dubultnieciens

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

const PORT = process.env.PORT || 10080;
const SIZE = 8;

// ====== Express + Socket.IO bāze ======
const app = express();
app.use(cors());

app.get("/", (req, res) => {
  res.send("Bugats Dambretes serveris darbojas.");
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ====== Spēles loģika ======

function createInitialBoard() {
  const board = [];
  for (let r = 0; r < SIZE; r++) {
    const row = [];
    for (let c = 0; c < SIZE; c++) {
      let piece = null;
      const dark = (r + c) % 2 === 1;
      if (dark && r < 3) {
        piece = { color: "b", king: false };
      } else if (dark && r > 4) {
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

function getMovesForPiece(board, row, col, onlyJumps = false, playerColor = null) {
  const piece = board[row][col];
  if (!piece) return [];
  const color = playerColor || piece.color;
  if (piece.color !== color) return [];

  const dirs = [];
  if (piece.king) {
    dirs.push([-1, -1], [-1, 1], [1, -1], [1, 1]);
  } else if (piece.color === "b") {
    // melnie iet uz leju
    dirs.push([1, -1], [1, 1]);
  } else {
    // baltie iet uz augšu
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

function getValidMovesForPiece(board, row, col, currentPlayer) {
  const piece = board[row][col];
  if (!piece || piece.color !== currentPlayer) return [];
  const mandatoryJump = playerHasAnyJump(board, currentPlayer);
  const allMoves = getMovesForPiece(board, row, col, false, currentPlayer);
  if (!mandatoryJump) return allMoves;
  return allMoves.filter((m) => m.type === "jump");
}

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

// ====== Room stāvoklis ======

const rooms = new Map(); // roomId -> room

function generateRoomId() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 4; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function createRoom(hostSocket, nickname) {
  const id = generateRoomId();
  const board = createInitialBoard();
  const room = {
    id,
    board,
    currentPlayer: "b", // melnie sāk
    players: {
      b: { socketId: hostSocket.id, nickname: nickname || "Spēlētājs" },
      w: null,
    },
    mustContinueJump: false,
    forceFrom: null, // {row,col} ja jāturpina ar to pašu
    gameOver: false,
    winner: null, // "b" | "w" | null
  };
  rooms.set(id, room);
  return room;
}

function serializeRoom(room) {
  return {
    id: room.id,
    board: room.board,
    currentPlayer: room.currentPlayer,
    players: {
      b: room.players.b ? { nickname: room.players.b.nickname } : null,
      w: room.players.w ? { nickname: room.players.w.nickname } : null,
    },
    mustContinueJump: room.mustContinueJump,
    forceFrom: room.forceFrom,
    gameOver: room.gameOver,
    winner: room.winner,
  };
}

function lobbySnapshot() {
  const list = [];
  for (const room of rooms.values()) {
    const playerList = [];
    if (room.players.b) {
      playerList.push({ color: "b", nickname: room.players.b.nickname });
    }
    if (room.players.w) {
      playerList.push({ color: "w", nickname: room.players.w.nickname });
    }
    list.push({
      id: room.id,
      playerCount: playerList.length,
      players: playerList,
      gameOver: room.gameOver,
    });
  }
  return { rooms: list };
}

function broadcastLobby() {
  io.emit("lobbyState", lobbySnapshot());
}

function applyMoveOnRoom(room, move) {
  const { from, to, type, captured } = move;
  const board = room.board;
  const piece = board[from.row][from.col];
  if (!piece) return;

  board[from.row][from.col] = null;
  board[to.row][to.col] = piece;

  if (captured && captured.length > 0) {
    for (const cap of captured) {
      board[cap.row][cap.col] = null;
    }
  }

  maybeKing(piece, to.row);

  if (type === "jump") {
    const furtherJumps = getMovesForPiece(
      board,
      to.row,
      to.col,
      true,
      piece.color
    );
    if (furtherJumps.length > 0) {
      room.mustContinueJump = true;
      room.forceFrom = { row: to.row, col: to.col };
      // currentPlayer paliek tas pats
      return;
    }
  }

  // ķēde beigusies – nākamais spēlētājs
  room.mustContinueJump = false;
  room.forceFrom = null;
  room.currentPlayer = room.currentPlayer === "b" ? "w" : "b";

  // Pārbaudām, vai nākamajam ir gājieni
  if (!hasAnyMove(room.board, room.currentPlayer)) {
    room.gameOver = true;
    room.winner = room.currentPlayer === "b" ? "w" : "b";
  }
}

function tryMakeMove(room, color, fromRow, fromCol, toRow, toCol) {
  if (room.gameOver) {
    return { ok: false, reason: "gameOver" };
  }
  if (room.currentPlayer !== color) {
    return { ok: false, reason: "notYourTurn" };
  }

  const board = room.board;

  // ja jāturpina ķēdes ņemšana – drīkst tikai ar konkrēto kauliņu
  if (room.mustContinueJump) {
    if (
      !room.forceFrom ||
      room.forceFrom.row !== fromRow ||
      room.forceFrom.col !== fromCol
    ) {
      return { ok: false, reason: "mustContinueSamePiece" };
    }
    const jumps = getMovesForPiece(board, fromRow, fromCol, true, color);
    const move = jumps.find(
      (m) => m.to.row === toRow && m.to.col === toCol
    );
    if (!move) {
      return { ok: false, reason: "invalidMove" };
    }
    applyMoveOnRoom(room, move);
    return { ok: true };
  }

  const moves = getValidMovesForPiece(board, fromRow, fromCol, color);
  const move = moves.find(
    (m) => m.to.row === toRow && m.to.col === toCol
  );
  if (!move) {
    return { ok: false, reason: "invalidMove" };
  }
  applyMoveOnRoom(room, move);
  return { ok: true };
}

// ====== Socket.IO notikumi ======

io.on("connection", (socket) => {
  console.log("Savienots:", socket.id);
  socket.data.nickname = "Spēlētājs";
  socket.data.roomId = null;
  socket.data.color = null;

  socket.on("joinLobby", (payload) => {
    const nick = (payload && payload.nickname) || "Spēlētājs";
    socket.data.nickname = String(nick).slice(0, 16);
    socket.emit("lobbyState", lobbySnapshot());
  });

  socket.on("createRoom", () => {
    if (!socket.data.nickname) {
      socket.data.nickname = "Spēlētājs";
    }

    // ja jau ir istabā – vispirms izņemam
    leaveCurrentRoom(socket);

    const room = createRoom(socket, socket.data.nickname);
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.color = "b";

    socket.emit("roomJoined", {
      room: serializeRoom(room),
      yourColor: "b",
    });
    io.to(room.id).emit("roomState", serializeRoom(room));
    broadcastLobby();
  });

  socket.on("joinRoom", (payload) => {
    const roomId = payload && payload.roomId;
    if (!roomId || !rooms.has(roomId)) {
      socket.emit("errorMessage", { message: "Istaba neeksistē." });
      return;
    }

    const room = rooms.get(roomId);

    // ja pilna (2 spēlētāji) – nedodam iekšā
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
      room: serializeRoom(room),
      yourColor: color,
    });
    io.to(room.id).emit("roomState", serializeRoom(room));
    broadcastLobby();
  });

  socket.on("leaveRoom", () => {
    leaveCurrentRoom(socket);
    socket.emit("leftRoom");
    broadcastLobby();
  });

  socket.on("makeMove", (payload) => {
    const roomId = socket.data.roomId;
    const color = socket.data.color;
    if (!roomId || !color || !rooms.has(roomId)) {
      socket.emit("invalidMove", { reason: "notInRoom" });
      return;
    }

    const room = rooms.get(roomId);
    const { from, to } = payload || {};
    if (
      !from ||
      !to ||
      typeof from.row !== "number" ||
      typeof from.col !== "number" ||
      typeof to.row !== "number" ||
      typeof to.col !== "number"
    ) {
      socket.emit("invalidMove", { reason: "badPayload" });
      return;
    }

    const result = tryMakeMove(
      room,
      color,
      from.row,
      from.col,
      to.row,
      to.col
    );

    if (!result.ok) {
      socket.emit("invalidMove", { reason: result.reason });
      return;
    }

    io.to(room.id).emit("roomState", serializeRoom(room));
    broadcastLobby();
  });

  socket.on("disconnect", () => {
    console.log("Atvienots:", socket.id);
    leaveCurrentRoom(socket);
    broadcastLobby();
  });
});

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

  // ja viens aiziet un otrs paliek – varam viņu uzlikt par uzvarētāju
  if (!room.gameOver) {
    const remainingColor = room.players.b
      ? "b"
      : room.players.w
      ? "w"
      : null;
    if (remainingColor) {
      room.gameOver = true;
      room.winner = remainingColor;
    }
  }

  // ja istabā vairs nav neviena spēlētāja – izdzēšam
  const someoneLeft =
    (room.players.b ? 1 : 0) + (room.players.w ? 1 : 0);
  if (someoneLeft === 0) {
    rooms.delete(roomId);
  } else {
    io.to(room.id).emit("roomState", serializeRoom(room));
  }
}

// ====== Start ======
httpServer.listen(PORT, () => {
  console.log("Bugats Dambrete serveris klausās uz porta", PORT);
});
