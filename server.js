import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 10080;
const SIZE = 8; // 8x8 checkers board size

app.use(cors());
app.use(express.json());

// Socket.IO setup
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Initialize board for checkers
function createInitialBoard() {
  const board = [];
  for (let r = 0; r < SIZE; r++) {
    const row = [];
    for (let c = 0; c < SIZE; c++) {
      let piece = null;
      const dark = (r + c) % 2 === 1;
      if (dark && r < 3) {
        piece = { color: "b", king: false }; // Black pieces
      } else if (dark && r > 4) {
        piece = { color: "w", king: false }; // White pieces
      }
      row.push(piece);
    }
    board.push(row);
  }
  return board;
}

// Room management
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
    currentPlayer: "b", // Black starts
    players: {
      b: { socketId: hostSocket.id, nickname: nickname || "Player" },
      w: null
    },
    gameOver: false,
    winner: null // "b" | "w" | null
  };
  rooms.set(id, room);
  return room;
}

io.on("connection", (socket) => {
  socket.data.nickname = "Player";
  socket.data.roomId = null;
  socket.data.color = null;

  // Join lobby
  socket.on("joinLobby", (payload) => {
    const nick = (payload && payload.nickname) || "Player";
    socket.data.nickname = nick;
    socket.emit("lobbyState", { rooms: Array.from(rooms.values()) });
  });

  // Create room
  socket.on("createRoom", () => {
    const room = createRoom(socket, socket.data.nickname);
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.color = "b";
    socket.emit("roomJoined", { room, yourColor: "b" });
    io.to(room.id).emit("roomState", room);
  });

  // Join existing room
  socket.on("joinRoom", (payload) => {
    const roomId = payload.roomId;
    const room = rooms.get(roomId);
    if (!room) return socket.emit("errorMessage", { message: "Room doesn't exist." });

    if (room.players.b && room.players.w) {
      return socket.emit("errorMessage", { message: "Room is full." });
    }

    let color = null;
    if (!room.players.b) {
      color = "b";
      room.players.b = { socketId: socket.id, nickname: socket.data.nickname || "Player" };
    } else {
      color = "w";
      room.players.w = { socketId: socket.id, nickname: socket.data.nickname || "Player" };
    }

    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.color = color;
    socket.emit("roomJoined", { room, yourColor: color });
    io.to(room.id).emit("roomState", room);
  });

  // Leave room
  socket.on("leaveRoom", () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    if (room.players.b && room.players.b.socketId === socket.id) {
      room.players.b = null;
    } else if (room.players.w && room.players.w.socketId === socket.id) {
      room.players.w = null;
    }

    socket.leave(roomId);
    socket.data.roomId = null;
    socket.data.color = null;

    if (!room.players.b && !room.players.w) {
      rooms.delete(roomId);
    }
    io.to(room.id).emit("roomState", room);
  });

  // Make move
  socket.on("makeMove", (payload) => {
    const roomId = socket.data.roomId;
    const color = socket.data.color;
    const room = rooms.get(roomId);
    if (!room) return;

    const { from, to } = payload || {};
    if (!from || !to) return socket.emit("invalidMove", { reason: "badPayload" });

    const result = tryMakeMove(room, color, from.row, from.col, to.row, to.col);
    if (!result.ok) return socket.emit("invalidMove", { reason: result.reason });

    io.to(room.id).emit("roomState", room);
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    if (room.players.b && room.players.b.socketId === socket.id) {
      room.players.b = null;
    } else if (room.players.w && room.players.w.socketId === socket.id) {
      room.players.w = null;
    }

    if (!room.players.b && !room.players.w) {
      rooms.delete(roomId);
    }
    io.to(room.id).emit("roomState", room);
  });
});

// Start server
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));
