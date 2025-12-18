import express from "express";
import path from "path";
import { createServer } from "http";
import { Server } from "socket.io";

// Inicializē Express aplikāciju
const app = express();

// Izveido HTTP serveri
const server = createServer(app);

// Inicializē Socket.IO
const io = new Server(server);

// Iestata statiskā satura apkalpošanu no "public" mapes
app.use(express.static(path.join(__dirname, "public"))); // Statiskie faili HTML, CSS, JS

// Socket.IO notikumu apstrāde
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Atveras istaba (room)
  socket.on("createRoom", () => {
    const roomId = Math.floor(Math.random() * 10000);
    socket.join(roomId);
    console.log(`Room ${roomId} created.`);
    socket.emit("roomCreated", { roomId });
  });

  // Spēlētāji pievienojas istabai
  socket.on("joinRoom", (roomId) => {
    if (roomId) {
      socket.join(roomId);
      console.log(`Player joined room ${roomId}`);
      socket.emit("roomJoined", { roomId });
    } else {
      socket.emit("error", { message: "Invalid room ID" });
    }
  });

  // Izrakstīšanās no istabas
  socket.on("leaveRoom", (roomId) => {
    if (roomId) {
      socket.leave(roomId);
      console.log(`Player left room ${roomId}`);
      socket.emit("roomLeft", { roomId });
    }
  });

  // Jauns spēles gājiens
  socket.on("move", (moveData) => {
    // Apstrādāt spēles loģiku
    console.log(`Player ${socket.id} made a move:`, moveData);
    // Nosūtīt notikumu visiem spēlētājiem istabā
    io.to(moveData.roomId).emit("moveMade", moveData);
  });

  // Atvienošanās
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// Pārbaudiet, vai serveris darbojas
server.listen(3000, () => {
  console.log("Server is running on http://localhost:3000");
});
