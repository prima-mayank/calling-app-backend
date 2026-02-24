import { Server } from "socket.io";
import ServerConfig from "../config/serverConfig.js";
import roomHandler from "../handlers/roomHandler.js";
import remoteDesktopHandler from "../handlers/remoteDesktopHandler.js";
import { createCorsOptions } from "./corsPolicy.js";

export const createSocketServer = (server) => {
  const io = new Server(server, {
    cors: createCorsOptions(),
    transports: ["websocket", "polling"],
    allowUpgrades: true,
    maxHttpBufferSize: 8 * 1024 * 1024,
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

  return io;
};
