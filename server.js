import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "path";

// In-memory game data
let rooms = {}; // Store game rooms in-memory

const app = express();
const PORT = process.env.PORT || 10080;
const SIZE = 8;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Multer setup for image upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// Game logic
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
      w: null,
    },
    mustContinueJump: false,
    forceFrom: null, // {row,col} if the same piece must continue
    gameOver: false,
    winner: null, // "b" | "w" | null
  };
  rooms[id] = room;
  return room;
}

function broadcastLobby() {
  io.emit("lobbyState", Object.values(rooms).map(room => ({
    id: room.id,
    playerCount: room.players.b && room.players.w ? 2 : 1,
    gameOver: room.gameOver,
  })));
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);
  socket.data.nickname = "Player";
  socket.data.roomId = null;
  socket.data.color = null;

  socket.on("joinLobby", (payload) => {
    const nick = (payload && payload.nickname) || "Player";
    socket.data.nickname = String(nick).slice(0, 16);
    socket.emit("lobbyState", Object.values(rooms));
  });

  socket.on("createRoom", () => {
    if (!socket.data.nickname) {
      socket.data.nickname = "Player";
    }

    const room = createRoom(socket, socket.data.nickname);
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.color = "b";

    socket.emit("roomJoined", {
      room: room,
      yourColor: "b",
    });
    io.to(room.id).emit("roomState", room);
    broadcastLobby();
  });

  socket.on("joinRoom", (payload) => {
    const roomId = payload && payload.roomId;
    if (!roomId || !rooms[roomId]) {
      socket.emit("errorMessage", { message: "Room doesn't exist." });
      return;
    }

    const room = rooms[roomId];

    // If full (2 players) - don't allow more
    const occupied =
      (room.players.b ? 1 : 0) + (room.players.w ? 1 : 0);
    if (occupied >= 2) {
      socket.emit("errorMessage", { message: "Room is full (2/2)." });
      return;
    }

    let color = null;
    if (!room.players.b) {
      color = "b";
      room.players.b = {
        socketId: socket.id,
        nickname: socket.data.nickname || "Player",
      };
    } else if (!room.players.w) {
      color = "w";
      room.players.w = {
        socketId: socket.id,
        nickname: socket.data.nickname || "Player",
      };
    }

    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.color = color;

    socket.emit("roomJoined", {
      room: room,
      yourColor: color,
    });
    io.to(room.id).emit("roomState", room);
    broadcastLobby();
  });

  socket.on("leaveRoom", () => {
    leaveCurrentRoom(socket);
    socket.emit("leftRoom");
    broadcastLobby();
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
    leaveCurrentRoom(socket);
    broadcastLobby();
  });
});

function leaveCurrentRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId || !rooms[roomId]) {
    socket.data.roomId = null;
    socket.data.color = null;
    return;
  }

  const room = rooms[roomId];

  if (room.players.b && room.players.b.socketId === socket.id) {
    room.players.b = null;
  }
  if (room.players.w && room.players.w.socketId === socket.id) {
    room.players.w = null;
  }

  socket.leave(roomId);
  socket.data.roomId = null;
  socket.data.color = null;

  const someoneLeft =
    (room.players.b ? 1 : 0) + (room.players.w ? 1 : 0);
  if (someoneLeft === 0) {
    delete rooms[roomId];
  } else {
    io.to(room.id).emit("roomState", room);
  }
}

httpServer.listen(PORT, () => {
  console.log("Bugats Dambrete server running on port", PORT);
});
