import dotenv from "dotenv";
import express from "express";
import ServerConfig from "./config/serverConfig.js";
import { Server } from "socket.io";
import http from "http";
import cors from "cors";
import { ExpressPeerServer } from "peer";
import roomHandler from "./handlers/roomHandler.js"

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.send("OK");
});

const server = http.createServer(app);

// Configure Socket.IO with proper settings
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"]
});

io.on("connection", (socket) => {
  console.log("New user connected:", socket.id);

  // Setup room handlers for this socket
  roomHandler(socket);

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

process.on("uncaughtException", err => {
  console.error("Uncaught Exception:", err);
});

// Attach PeerJS to same server
const peerServer = ExpressPeerServer(server, {
  path: "/myapp"
});

app.use("/peerjs", peerServer);

// Start server
server.listen(ServerConfig.PORT, () => {
  console.log(`Server running on port ${ServerConfig.PORT}`);
  console.log(`Socket.IO available at ws://localhost:${ServerConfig.PORT}`);
  console.log(`PeerJS available at http://localhost:${ServerConfig.PORT}/peerjs/myapp`);
});
