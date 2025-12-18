import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 10080;

app.use(cors());
app.use(express.static("public"));  // Public folder for game files

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  console.log("New connection:", socket.id);

  // Handle game events
});

httpServer.listen(PORT, () => {
  console.log("Server is running on port", PORT);
});
