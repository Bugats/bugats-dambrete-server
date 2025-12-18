import express from "express";
import path from "path";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public"))); // Pārliecinies, ka public mape satur HTML un CSS failus

// Socket.IO loģika
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);
  // Tev būs jāievieto sava spēles loģika šeit...
});

server.listen(3000, () => {
  console.log("Server is running on http://localhost:3000");
});
