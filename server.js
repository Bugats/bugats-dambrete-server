import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import mongoose from "mongoose";
import cloudinary from "cloudinary";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "path";

// MongoDB lietotāja modelis
const User = mongoose.model("User", {
  nickname: String,
  profilePic: String,
  score: Number,
});

const app = express();
const PORT = process.env.PORT || 10080;
const SIZE = 8;
app.use(cors());
app.use(express.json());
app.use(express.static("public"));  // Profila attēlu statiskā servēšana

// Cloudinary konfigurācija
cloudinary.config({
  cloud_name: 'your-cloud-name',
  api_key: 'your-api-key',
  api_secret: 'your-api-secret'
});

// Multer konfigurācija attēlu augšupielādei
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// Reģistrācijas funkcija
app.post("/register", async (req, res) => {
  const { nickname, password, profilePic } = req.body;
  const newUser = new User({ nickname, password, profilePic, score: 0 });
  await newUser.save();
  res.status(201).send("User created successfully!");
});

// Pieteikšanās funkcija
app.post("/login", async (req, res) => {
  const { nickname, password } = req.body;
  const user = await User.findOne({ nickname, password });

  if (user) {
    const token = jwt.sign({ userId: user._id }, "your-secret-key");
    res.status(200).json({ token });
  } else {
    res.status(400).send("Invalid credentials");
  }
});

// Profila attēlu augšupielāde
app.post("/uploadProfilePic", upload.single("profilePic"), (req, res) => {
  const filePath = req.file.path;
  cloudinary.uploader.upload(filePath, (error, result) => {
    if (error) {
      return res.status(500).send("Error uploading image");
    }
    res.status(200).json({ imageUrl: result.url });
  });
});

// Iegūt TOP 10 spēlētājus
app.get("/leaderboard", async (req, res) => {
  const topPlayers = await User.find().sort({ score: -1 }).limit(10);
  res.status(200).json(topPlayers);
});

// Savienot ar MongoDB
mongoose.connect("mongodb://localhost/dambretes", { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => app.listen(PORT, () => console.log("Server running on port 3000")));

// Socket.IO konfigurācija
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Dambretes loģika
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

// Spēles loģika, istabas un sockets
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
      room: room,
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

  const someoneLeft =
    (room.players.b ? 1 : 0) + (room.players.w ? 1 : 0);
  if (someoneLeft === 0) {
    rooms.delete(roomId);
  } else {
    io.to(room.id).emit("roomState", room);
  }
}

httpServer.listen(PORT, () => {
  console.log("Bugats Dambrete serveris klausās uz porta", PORT);
});
