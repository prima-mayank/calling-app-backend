import dotenv from "dotenv";
import express from "express";
import ServerConfig from "./config/serverConfig.js";
import { Server } from "socket.io";
import http from "http";
import cors from "cors";
import { ExpressPeerServer } from "peer";
import roomHandler from "./handlers/roomHandler.js";
import remoteDesktopHandler from "./handlers/remoteDesktopHandler.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.send("OK");
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ["polling"],
  allowUpgrades: false,
  maxHttpBufferSize: 8 * 1024 * 1024
});

io.on("connection", (socket) => {
  console.log("New user connected:", socket.id);

  roomHandler(socket);
  remoteDesktopHandler(io, socket);

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

process.on("uncaughtException", err => {
  console.error("Uncaught Exception:", err);
});

const peerServer = ExpressPeerServer(server, {
  path: "/myapp"
});

app.use("/peerjs", peerServer);

server.on("error", (err) => {
  if (err?.code === "EADDRINUSE") {
    console.error(`Port ${ServerConfig.PORT} is already in use. Stop the existing process and retry.`);
    process.exit(1);
  }
  console.error("Server startup error:", err);
  process.exit(1);
});

server.listen(ServerConfig.PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${ServerConfig.PORT}`);
  console.log(`Socket.IO available at ws://localhost:${ServerConfig.PORT}`);
  console.log(`PeerJS available at http://localhost:${ServerConfig.PORT}/peerjs/myapp`);
});
