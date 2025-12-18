import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

// MongoDB User Model
const User = mongoose.model("User", {
  nickname: String,
  password: String,
  score: Number,
  xp: Number,
});

// MongoDB Top 10 Players
const TopPlayer = mongoose.model("TopPlayer", {
  nickname: String,
  score: Number,
  xp: Number,
});

const app = express();
const PORT = process.env.PORT || 10080;
const SIZE = 8;

app.use(cors());
app.use(express.json());
app.use(express.static("public")); // Serve profile images

// MongoDB connection
mongoose.connect("mongodb://localhost/dambretes", { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => app.listen(PORT, () => console.log("Server running on port", PORT)));

// Socket.IO setup
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

let rooms = new Map(); // roomId -> room

// Helper function to create a new room
function createRoom(hostSocket, nickname) {
  const id = generateRoomId();
  const room = {
    id,
    board: createInitialBoard(),
    currentPlayer: "b", // Black starts
    players: {
      b: { socketId: hostSocket.id, nickname: nickname || "Player" },
      w: null,
    },
    gameOver: false,
    winner: null, // "b" | "w" | null
  };
  rooms.set(id, room);
  return room;
}

// Helper function to generate random room id
function generateRoomId() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 4; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// Helper function to create the initial board
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

// Helper function to get top 10 players from MongoDB
async function getTopPlayers() {
  const players = await TopPlayer.find().sort({ score: -1 }).limit(10);
  return players;
}

// Player registration route
app.post("/register", async (req, res) => {
  const { nickname, password } = req.body;
  const hashedPassword = bcrypt.hashSync(password, 10);
  const newUser = new User({ nickname, password: hashedPassword, score: 0, xp: 0 });
  await newUser.save();
  res.status(201).send("User created successfully!");
});

// Player login route
app.post("/login", async (req, res) => {
  const { nickname, password } = req.body;
  const user = await User.findOne({ nickname });

  if (user && bcrypt.compareSync(password, user.password)) {
    const token = jwt.sign({ userId: user._id }, "your-secret-key");
    res.status(200).json({ token });
  } else {
    res.status(400).send("Invalid credentials");
  }
});

// Get top 10 players route
app.get("/leaderboard", async (req, res) => {
  const topPlayers = await getTopPlayers();
  res.status(200).json(topPlayers);
});

// Socket.IO events
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Assigning nickname and joining the lobby
  socket.on("joinLobby", (payload) => {
    const nickname = payload.nickname || "Player";
    socket.data.nickname = nickname;
    socket.emit("lobbyState", getLobbyState());
  });

  // Create a new room
  socket.on("createRoom", () => {
    if (!socket.data.nickname) {
      socket.data.nickname = "Player";
    }
    const room = createRoom(socket, socket.data.nickname);
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.color = "b";
    socket.emit("roomJoined", { room });
    io.to(room.id).emit("roomState", room);
  });

  // Join an existing room
  socket.on("joinRoom", (payload) => {
    const roomId = payload.roomId;
    if (!rooms.has(roomId)) {
      socket.emit("errorMessage", { message: "Room doesn't exist." });
      return;
    }

    const room = rooms.get(roomId);
    if (!room.players.b) {
      room.players.b = { socketId: socket.id, nickname: socket.data.nickname };
      socket.data.color = "b";
    } else if (!room.players.w) {
      room.players.w = { socketId: socket.id, nickname: socket.data.nickname };
      socket.data.color = "w";
    }

    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.emit("roomJoined", { room });
    io.to(room.id).emit("roomState", room);
  });

  // Making a move
  socket.on("makeMove", (payload) => {
    const room = rooms.get(payload.roomId);
    if (room) {
      // Handle move logic here
      room.board = payload.board; // Update board after move
      io.to(payload.roomId).emit("roomState", room);
    }
  });

  // Disconnecting from the room
  socket.on("leaveRoom", () => {
    const roomId = socket.data.roomId;
    if (roomId && rooms.has(roomId)) {
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

      if (Object.keys(room.players).length === 0) {
        rooms.delete(roomId); // Remove room if no players left
      } else {
        io.to(room.id).emit("roomState", room); // Update room state
      }
    }
  });

  // Disconnect event
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// Serve the application
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
