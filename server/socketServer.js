import crypto from "crypto";
import { Server } from "socket.io";
import ServerConfig from "../config/serverConfig.js";
import roomHandler from "../handlers/roomHandler.js";
import remoteDesktopHandler from "../handlers/remoteDesktopHandler.js";
import createDirectCallHandler from "../handlers/directCallHandler.js";
import { createPresenceHandler } from "../handlers/presenceHandler.js";
import { resolveSocketAuthenticatedUser } from "./socketAuth.js";
import { createCorsOptions } from "./corsPolicy.js";

export const createSocketServer = (server, options = {}) => {
  const { authRuntime = null, presenceStore = null } = options;

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
    // Constant-time comparison prevents timing-based token enumeration.
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(ServerConfig.REMOTE_CONTROL_TOKEN);
    const tokenValid =
      tokenBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(tokenBuf, expectedBuf);

    if (!tokenValid) {
      return next(new Error("unauthorized"));
    }

    return next();
  });

  io.on("connection", (socket) => {
    const resolvedAuthUser = resolveSocketAuthenticatedUser({
      socket,
      authRuntime,
    });

    if (presenceStore && resolvedAuthUser.userId) {
      socket.data.authUserId = resolvedAuthUser.userId;
      socket.data.authEmail = resolvedAuthUser.email;
      socket.data.authDisplayName = String(resolvedAuthUser.displayName || "").trim();
      presenceStore.register({
        userId: resolvedAuthUser.userId,
        socketId: socket.id,
      });
    }

    const presenceHandler = createPresenceHandler({
      io,
      socket,
      presenceStore: presenceStore || {
        getOnlineUserIds: () => [],
        unregisterSocket: () => "",
      },
    });

    if (resolvedAuthUser.userId) {
      presenceHandler.handleAuthenticatedConnect();
    }

    roomHandler(socket);
    remoteDesktopHandler(io, socket);
    createDirectCallHandler({
      io,
      socket,
      presenceStore: presenceStore || {
        getSocketIdsForUser: () => [],
        unregisterSocket: () => "",
      },
      authRuntime: authRuntime || {
        getUserById: async () => null,
      },
    });

    socket.on("disconnect", presenceHandler.handleDisconnect);
  });

  return io;
};
