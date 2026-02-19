import dotenv from "dotenv";
import express from "express";
import ServerConfig from "./config/serverConfig.js";
import { Server } from "socket.io";
import http from "http";
import cors from "cors";
import { ExpressPeerServer } from "peer";
// Keep path casing consistent with the on-disk filename (Linux/Render is case-sensitive).
import roomHandler from "./handlers/roomHandler.js";
import remoteDesktopHandler from "./handlers/remoteDesktopHandler.js";

dotenv.config();

const app = express();

const isOriginAllowed = (origin) => {
  if (!origin) return true;
  if (ServerConfig.ALLOWED_ORIGINS.includes("*")) return true;
  return ServerConfig.ALLOWED_ORIGINS.includes(origin);
};

app.use(
  cors({
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("CORS origin blocked"));
    },
    methods: ["GET", "POST"],
  })
);
app.use(express.json());

app.get("/health", (req, res) => {
  res.send("OK");
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("CORS origin blocked"));
    },
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
  allowUpgrades: true,
  maxHttpBufferSize: 8 * 1024 * 1024
});

io.use((socket, next) => {
  if (!ServerConfig.REMOTE_CONTROL_TOKEN) {
    return next();
  }

  const token = String(socket.handshake?.auth?.token || "").trim();
  if (token !== ServerConfig.REMOTE_CONTROL_TOKEN) {
    return next(new Error("unauthorized"));
  }

  return next();
});

io.on("connection", (socket) => {
  roomHandler(socket);
  remoteDesktopHandler(io, socket);
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
  // Server started.
});
