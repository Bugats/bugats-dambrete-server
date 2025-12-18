import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 10080;
const SIZE = 8;

app.use(cors());
app.use(express.json());
app.use(express.static("public")); // Serve profile images

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
  const room = {
    id,
    players: {
      b: { socketId: hostSocket.id, nickname: nickname || "Player" },
      w: null,
    },
    currentPlayer: "b", // Black starts
    gameOver: false,
    winner: null,
    board: Array(SIZE).fill(Array(SIZE).fill(null)),
  };
  rooms.set(id, room);
  return room;
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);
  socket.data.nickname = "Player";
  socket.data.roomId = null;
  socket.data.color = null;

  socket.on("createRoom", (nickname) => {
    const room = createRoom(socket, nickname);
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.color = "b";

    socket.emit("roomJoined", { room: room, yourColor: "b" });
    io.to(room.id).emit("roomState", room);
  });

  socket.on("joinRoom", (roomId) => {
    const room = rooms.get(roomId);
    if (!room || room.players.b && room.players.w) {
      socket.emit("errorMessage", { message: "Room is full or doesn't exist." });
      return;
    }

    let color = "w";
    if (!room.players.b) {
      room.players.b = { socketId: socket.id, nickname: socket.data.nickname };
      color = "b";
    } else {
      room.players.w = { socketId: socket.id, nickname: socket.data.nickname };
    }

    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.color = color;

    socket.emit("roomJoined", { room: room, yourColor: color });
    io.to(room.id).emit("roomState", room);
  });

  socket.on("leaveRoom", () => {
    const roomId = socket.data.roomId;
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.players.b = room.players.b?.socketId === socket.id ? null : room.players.b;
      room.players.w = room.players.w?.socketId === socket.id ? null : room.players.w;
      socket.leave(roomId);
      socket.emit("leftRoom");
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    socket.data.roomId = null;
    socket.data.color = null;
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
