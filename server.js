import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 10080;
const SIZE = 8;

app.use(cors());
app.use(express.json());

// Socket.IO konfigurācija
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Spēles dēļa sākotnējais stāvoklis
function createInitialBoard() {
  const board = [];
  for (let r = 0; r < SIZE; r++) {
    const row = [];
    for (let c = 0; c < SIZE; c++) {
      let piece = null;
      const dark = (r + c) % 2 === 1;
      if (dark && r < 3) {
        piece = { color: "b", king: false }; // melnie kauliņi
      } else if (dark && r > 4) {
        piece = { color: "w", king: false }; // baltie kauliņi
      }
      row.push(piece);
    }
    board.push(row);
  }
  return board;
}

// Istabas stāvoklis
const rooms = new Map(); // roomId -> room

// Jaunas istabas ģenerēšana
function generateRoomId() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 4; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// Istabas izveide
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
    gameOver: false,
    winner: null, // "b" | "w" | null
  };
  rooms.set(id, room);
  return room;
}

// Socket.IO notikumi
io.on("connection", (socket) => {
  console.log("Savienots:", socket.id);
  socket.data.nickname = "Spēlētājs";
  socket.data.roomId = null;
  socket.data.color = null;

  // Pievienoties istabai
  socket.on("joinLobby", (payload) => {
    const nick = (payload && payload.nickname) || "Spēlētājs";
    socket.data.nickname = String(nick).slice(0, 16);
    socket.emit("lobbyState", { rooms: Array.from(rooms.values()) });
  });

  // Izveidot istabu
  socket.on("createRoom", () => {
    if (!socket.data.nickname) {
      socket.data.nickname = "Spēlētājs";
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
  });

  // Pievienoties esošai istabai
  socket.on("joinRoom", (payload) => {
    const roomId = payload && payload.roomId;
    if (!roomId || !rooms.has(roomId)) {
      socket.emit("errorMessage", { message: "Istaba neeksistē." });
      return;
    }

    const room = rooms.get(roomId);
    if (room.players.b && room.players.w) {
      socket.emit("errorMessage", { message: "Istaba ir pilna." });
      return;
    }

    // Piešķirt otro spēlētāju
    let color = null;
    if (!room.players.b) {
      color = "b";
      room.players.b = { socketId: socket.id, nickname: socket.data.nickname || "Spēlētājs" };
    } else {
      color = "w";
      room.players.w = { socketId: socket.id, nickname: socket.data.nickname || "Spēlētājs" };
    }

    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.color = color;

    socket.emit("roomJoined", {
      room: room,
      yourColor: color,
    });
    io.to(room.id).emit("roomState", room);
  });

  // Atstāt istabu
  socket.on("leaveRoom", () => {
    leaveCurrentRoom(socket);
    socket.emit("leftRoom");
  });

  // Gājiens
  socket.on("makeMove", (payload) => {
    const roomId = socket.data.roomId;
    const color = socket.data.color;
    if (!roomId || !color || !rooms.has(roomId)) {
      socket.emit("invalidMove", { reason: "notInRoom" });
      return;
    }

    const room = rooms.get(roomId);
    const { from, to } = payload || {};
    if (!from || !to) {
      socket.emit("invalidMove", { reason: "badPayload" });
      return;
    }

    // Pārbauda un piemēro gājienu
    const result = tryMakeMove(room, color, from.row, from.col, to.row, to.col);

    if (!result.ok) {
      socket.emit("invalidMove", { reason: result.reason });
      return;
    }

    io.to(room.id).emit("roomState", room);
  });

  socket.on("disconnect", () => {
    console.log("Atvienots:", socket.id);
    leaveCurrentRoom(socket);
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
    } else if (room.players.w && room.players.w.socketId === socket.id) {
      room.players.w = null;
    }

    socket.leave(roomId);
    socket.data.roomId = null;
    socket.data.color = null;

    if (!room.players.b && !room.players.w) {
      rooms.delete(roomId);
    } else {
      io.to(room.id).emit("roomState", room);
    }
  }
});

// Serveris klausās uz portu
httpServer.listen(PORT, () => {
  console.log("Serveris darbojas uz porta", PORT);
});
