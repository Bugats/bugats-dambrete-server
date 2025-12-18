import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import mongoose from "mongoose";
import cors from "cors";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const rooms = new Map(); // roomId -> room

function createRoom() {
  const id = Math.random().toString(36).substring(2, 6);
  const room = {
    id,
    board: Array(8).fill(Array(8).fill(null)),
    currentPlayer: "b",
    players: { b: null, w: null },
    gameOver: false,
  };
  rooms.set(id, room);
  return room;
}

io.on("connection", (socket) => {
  console.log("User connected", socket.id);

  socket.on("newGame", () => {
    const room = createRoom();
    socket.join(room.id);
    room.players.b = socket.id;
    socket.emit("gameState", room);
  });

  socket.on("makeMove", (data) => {
    const { roomId, from, to } = data;
    const room = rooms.get(roomId);
    if (!room) return;

    // Update board and game state
    const { board } = room;
    const piece = board[from.row][from.col];
    board[to.row][to.col] = piece;
    board[from.row][from.col] = null;

    room.currentPlayer = room.currentPlayer === "b" ? "w" : "b";
    io.to(room.id).emit("gameState", room);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected", socket.id);
  });
});

mongoose.connect("mongodb://localhost/dambretes", { useNewUrlParser: true, useUnifiedTopology: true });

httpServer.listen(3000, () => {
  console.log("Server running on port 3000");
});
