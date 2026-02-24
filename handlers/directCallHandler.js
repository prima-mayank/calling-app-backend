import { v4 as UUIDv4 } from "uuid";

const DEFAULT_DIRECT_CALL_TIMEOUT_MS = 30_000;
const pendingDirectCalls = new Map();

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const DIRECT_CALL_TIMEOUT_MS = parsePositiveInteger(
  process.env.DIRECT_CALL_TIMEOUT_MS,
  DEFAULT_DIRECT_CALL_TIMEOUT_MS
);

const normalizeId = (value) => String(value || "").trim();

const normalizeMode = (value) => {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "audio" || mode === "video") return mode;
  return "";
};

const ensureOnlineSocketIds = (io, socketIds) => {
  return socketIds.filter((socketId) => !!io.sockets.sockets.get(socketId));
};

const buildCallerInfo = (fallbackUserId, fallbackEmail, user) => ({
  id: normalizeId(user?.id || fallbackUserId),
  email: String(user?.email || fallbackEmail || "").trim().toLowerCase(),
  displayName: String(user?.displayName || "").trim(),
});

const createDirectCallHandler = ({ io, socket, presenceStore, authRuntime }) => {
  const emitDirectCallError = (message, code = "direct-call-error") => {
    socket.emit("direct-call-error", {
      message: String(message || "Direct call failed."),
      code: String(code || "direct-call-error"),
    });
  };

  const clearPendingDirectCall = (requestId, options = {}) => {
    const normalizedRequestId = normalizeId(requestId);
    if (!normalizedRequestId) return null;

    const request = pendingDirectCalls.get(normalizedRequestId);
    if (!request) return null;

    pendingDirectCalls.delete(normalizedRequestId);
    if (request.timeoutId) {
      clearTimeout(request.timeoutId);
    }

    const callerSocket = io.sockets.sockets.get(request.callerSocketId);
    const onlineTargetSocketIds = ensureOnlineSocketIds(
      io,
      presenceStore.getSocketIdsForUser(request.targetUserId)
    );

    if (options.notifyCaller && callerSocket) {
      callerSocket.emit(options.callerEventName || "direct-call-ended", {
        requestId: normalizedRequestId,
        roomId: request.roomId,
        mode: request.mode,
        targetUserId: request.targetUserId,
        message: String(options.callerMessage || "").trim() || undefined,
        reason: String(options.reason || "").trim() || undefined,
      });
    }

    if (options.notifyTargets) {
      onlineTargetSocketIds.forEach((targetSocketId) => {
        io.to(targetSocketId).emit("direct-call-cancelled", {
          requestId: normalizedRequestId,
          roomId: request.roomId,
          mode: request.mode,
          callerUserId: request.callerUserId,
          reason: String(options.reason || "").trim() || "cancelled",
          message: String(options.targetMessage || "").trim() || undefined,
        });
      });
    }

    return request;
  };

  const requestDirectCall = async ({ targetUserId, mode } = {}) => {
    const callerUserId = normalizeId(socket.data?.authUserId);
    if (!callerUserId) {
      emitDirectCallError("Login is required for direct calls.", "auth-required");
      return;
    }

    const normalizedTargetUserId = normalizeId(targetUserId);
    if (!normalizedTargetUserId) {
      emitDirectCallError("Select a valid user to call.", "target-required");
      return;
    }

    if (callerUserId === normalizedTargetUserId) {
      emitDirectCallError("You cannot call yourself.", "self-call-not-allowed");
      return;
    }

    const normalizedMode = normalizeMode(mode);
    if (!normalizedMode) {
      emitDirectCallError("Select call mode: audio or video.", "mode-invalid");
      return;
    }

    const onlineTargetSocketIds = ensureOnlineSocketIds(
      io,
      presenceStore.getSocketIdsForUser(normalizedTargetUserId)
    );

    if (onlineTargetSocketIds.length === 0) {
      emitDirectCallError("User is offline right now.", "target-offline");
      return;
    }

    const requestId = UUIDv4();
    const roomId = UUIDv4();
    const callerProfile = await authRuntime.getUserById(callerUserId);
    const caller = buildCallerInfo(callerUserId, socket.data?.authEmail, callerProfile);

    const request = {
      requestId,
      callerUserId,
      callerSocketId: socket.id,
      targetUserId: normalizedTargetUserId,
      mode: normalizedMode,
      roomId,
      timeoutId: null,
    };

    request.timeoutId = setTimeout(() => {
      clearPendingDirectCall(requestId, {
        notifyCaller: true,
        callerEventName: "direct-call-ended",
        callerMessage: "No answer from user.",
        reason: "timeout",
        notifyTargets: true,
        targetMessage: "Call request timed out.",
      });
    }, DIRECT_CALL_TIMEOUT_MS);

    pendingDirectCalls.set(requestId, request);

    socket.emit("direct-call-ringing", {
      requestId,
      roomId,
      mode: normalizedMode,
      targetUserId: normalizedTargetUserId,
    });

    onlineTargetSocketIds.forEach((targetSocketId) => {
      io.to(targetSocketId).emit("direct-call-incoming", {
        requestId,
        roomId,
        mode: normalizedMode,
        caller,
      });
    });
  };

  const respondDirectCall = ({ requestId, accepted } = {}) => {
    const normalizedRequestId = normalizeId(requestId);
    if (!normalizedRequestId) return;

    const request = pendingDirectCalls.get(normalizedRequestId);
    if (!request) return;

    const responderUserId = normalizeId(socket.data?.authUserId);
    if (!responderUserId || responderUserId !== request.targetUserId) {
      return;
    }

    const callerSocket = io.sockets.sockets.get(request.callerSocketId);
    const onlineTargetSocketIds = ensureOnlineSocketIds(
      io,
      presenceStore.getSocketIdsForUser(request.targetUserId)
    );

    pendingDirectCalls.delete(normalizedRequestId);
    if (request.timeoutId) {
      clearTimeout(request.timeoutId);
    }

    if (!accepted) {
      if (callerSocket) {
        callerSocket.emit("direct-call-rejected", {
          requestId: normalizedRequestId,
          roomId: request.roomId,
          mode: request.mode,
          targetUserId: request.targetUserId,
          reason: "rejected",
        });
      }

      onlineTargetSocketIds.forEach((targetSocketId) => {
        if (targetSocketId === socket.id) return;
        io.to(targetSocketId).emit("direct-call-cancelled", {
          requestId: normalizedRequestId,
          roomId: request.roomId,
          mode: request.mode,
          callerUserId: request.callerUserId,
          reason: "rejected-on-other-device",
        });
      });
      return;
    }

    if (callerSocket) {
      callerSocket.emit("direct-call-accepted", {
        requestId: normalizedRequestId,
        roomId: request.roomId,
        mode: request.mode,
        targetUserId: request.targetUserId,
      });
    }

    onlineTargetSocketIds.forEach((targetSocketId) => {
      if (targetSocketId === socket.id) return;
      io.to(targetSocketId).emit("direct-call-cancelled", {
        requestId: normalizedRequestId,
        roomId: request.roomId,
        mode: request.mode,
        callerUserId: request.callerUserId,
        reason: "answered-on-other-device",
      });
    });
  };

  const cancelDirectCall = ({ requestId } = {}) => {
    const normalizedRequestId = normalizeId(requestId);
    if (!normalizedRequestId) return;
    const request = pendingDirectCalls.get(normalizedRequestId);
    if (!request) return;
    if (request.callerSocketId !== socket.id) return;

    clearPendingDirectCall(normalizedRequestId, {
      notifyTargets: true,
      reason: "cancelled-by-caller",
      targetMessage: "Caller cancelled the request.",
    });
  };

  const onDisconnect = () => {
    const disconnectedSocketUserId = normalizeId(socket.data?.authUserId);
    const activeRequests = Array.from(pendingDirectCalls.values());

    activeRequests.forEach((request) => {
      if (request.callerSocketId === socket.id) {
        clearPendingDirectCall(request.requestId, {
          notifyTargets: true,
          reason: "caller-disconnected",
          targetMessage: "Caller disconnected.",
        });
        return;
      }

      if (!disconnectedSocketUserId || request.targetUserId !== disconnectedSocketUserId) {
        return;
      }

      const onlineTargetSocketIds = ensureOnlineSocketIds(
        io,
        presenceStore.getSocketIdsForUser(request.targetUserId)
      ).filter((socketId) => socketId !== socket.id);
      if (onlineTargetSocketIds.length === 0) {
        clearPendingDirectCall(request.requestId, {
          notifyCaller: true,
          callerEventName: "direct-call-ended",
          callerMessage: "User went offline.",
          reason: "target-offline",
        });
      }
    });
  };

  socket.on("direct-call-request", requestDirectCall);
  socket.on("direct-call-response", respondDirectCall);
  socket.on("direct-call-cancel", cancelDirectCall);
  socket.on("disconnect", onDisconnect);
};

export default createDirectCallHandler;
