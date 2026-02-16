import { v4 as UUIDv4 } from "uuid";

// hostId => { socketId, activeSessionId }
const hosts = new Map();
// sessionId => { hostId, hostSocketId, controllerSocketId }
const sessions = new Map();
// requestId => { requestId, hostId, hostSocketId, controllerSocketId, requesterId, roomId, approverSocketId, timeoutId }
const pendingRequests = new Map();
const REMOTE_REQUEST_TIMEOUT_MS = 45_000;

const sanitizeString = (value, maxLength = 128) => {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
};

const pointerTypes = new Set(["move", "click", "mouse-down", "mouse-up", "wheel"]);
const keyTypes = new Set(["key-down", "key-up"]);

const sanitizeRemoteEvent = (event) => {
  if (!event || typeof event !== "object") return null;

  const type = sanitizeString(event.type, 24);
  if (!pointerTypes.has(type) && !keyTypes.has(type)) return null;

  const sanitized = { type };

  if (pointerTypes.has(type)) {
    const x = Number(event.x);
    const y = Number(event.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    sanitized.x = Math.min(1, Math.max(0, x));
    sanitized.y = Math.min(1, Math.max(0, y));
  }

  if (type === "click" || type === "mouse-down" || type === "mouse-up") {
    sanitized.button =
      event.button === "right" || event.button === "middle" ? event.button : "left";
  }

  if (type === "wheel") {
    const deltaX = Number(event.deltaX);
    const deltaY = Number(event.deltaY);
    sanitized.deltaX = Number.isFinite(deltaX) ? deltaX : 0;
    sanitized.deltaY = Number.isFinite(deltaY) ? deltaY : 0;
  }

  if (keyTypes.has(type)) {
    const key = sanitizeString(event.key, 64);
    const code = sanitizeString(event.code, 64);
    if (!key && !code) return null;

    sanitized.key = key;
    sanitized.code = code;
    sanitized.repeat = !!event.repeat;
  }

  return sanitized;
};

const resolveSessionForSocket = (socket, requestedSessionId) => {
  const sessionId = sanitizeString(requestedSessionId, 64);
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return { sessionId: "", session: null };
    return { sessionId, session };
  }

  const hostId = socket.data?.remoteHostId;
  if (hostId) {
    const host = hosts.get(hostId);
    if (host?.activeSessionId) {
      const activeSession = sessions.get(host.activeSessionId);
      return { sessionId: host.activeSessionId, session: activeSession || null };
    }
  }

  const controllerSessionId = socket.data?.controllerSessionId;
  if (controllerSessionId) {
    const controllerSession = sessions.get(controllerSessionId);
    return {
      sessionId: controllerSessionId,
      session: controllerSession || null,
    };
  }

  return { sessionId: "", session: null };
};

const remoteDesktopHandler = (io, socket) => {
  const emitSessionError = (message, code = "bad-request") => {
    socket.emit("remote-session-error", { message, code });
  };

  const emitToSocket = (socketId, eventName, payload) => {
    if (!socketId) return;
    io.to(socketId).emit(eventName, payload);
  };

  const clearPendingRequest = (requestId, options = {}) => {
    const request = pendingRequests.get(requestId);
    if (!request) return null;

    if (request.timeoutId) {
      clearTimeout(request.timeoutId);
    }

    pendingRequests.delete(requestId);

    const controllerSocket = io.sockets.sockets.get(request.controllerSocketId);
    if (controllerSocket?.data?.pendingRemoteRequestId === requestId) {
      delete controllerSocket.data.pendingRemoteRequestId;
    }

    const hostSocket = io.sockets.sockets.get(request.hostSocketId);
    if (hostSocket?.data?.pendingRemoteRequestId === requestId) {
      delete hostSocket.data.pendingRemoteRequestId;
    }

    if (options.notifyController) {
      emitToSocket(request.controllerSocketId, "remote-session-error", {
        message: options.controllerMessage || "Remote request was cancelled.",
        code: options.controllerCode || "request-cancelled",
      });
    }

    if (options.notifyHost) {
      emitToSocket(request.hostSocketId, "remote-session-error", {
        message: options.hostMessage || "Remote request was cancelled.",
        code: options.hostCode || "request-cancelled",
      });
    }

    return request;
  };

  const hasPendingRequestForHost = (hostId) => {
    for (const request of pendingRequests.values()) {
      if (request.hostId === hostId) return true;
    }
    return false;
  };

  const endSession = (sessionId, endedBy) => {
    const session = sessions.get(sessionId);
    if (!session) return;

    sessions.delete(sessionId);

    const host = hosts.get(session.hostId);
    if (host && host.activeSessionId === sessionId) {
      host.activeSessionId = "";
      hosts.set(session.hostId, host);
    }

    const payload = {
      sessionId,
      hostId: session.hostId,
      endedBy: sanitizeString(endedBy, 64),
    };

    io.to(session.hostSocketId).emit("remote-session-ended", payload);
    io.to(session.controllerSocketId).emit("remote-session-ended", payload);

    const hostSocket = io.sockets.sockets.get(session.hostSocketId);
    if (hostSocket?.data) {
      delete hostSocket.data.hostSessionId;
    }

    const controllerSocket = io.sockets.sockets.get(session.controllerSocketId);
    if (controllerSocket?.data) {
      delete controllerSocket.data.controllerSessionId;
    }
  };

  const registerRemoteHost = ({ hostId }) => {
    const sanitizedHostId = sanitizeString(hostId, 64);
    if (!sanitizedHostId) {
      emitSessionError("hostId is required.", "host-register-invalid");
      return;
    }

    const existing = hosts.get(sanitizedHostId);
    if (existing && existing.socketId && existing.socketId !== socket.id) {
      io.to(existing.socketId).emit("remote-session-error", {
        message: "Host replaced by a new agent connection.",
        code: "host-replaced",
      });
      const existingSocket = io.sockets.sockets.get(existing.socketId);
      if (existingSocket?.data) {
        delete existingSocket.data.remoteHostId;
      }
      if (existing.activeSessionId) {
        endSession(existing.activeSessionId, "host-replaced");
      }
      for (const request of pendingRequests.values()) {
        if (request.hostId === sanitizedHostId) {
          clearPendingRequest(request.requestId, {
            notifyController: true,
            controllerMessage: "Host was replaced by a new agent connection.",
            controllerCode: "host-replaced",
          });
        }
      }
    }

    hosts.set(sanitizedHostId, {
      socketId: socket.id,
      activeSessionId: "",
    });

    socket.data.remoteHostId = sanitizedHostId;
    socket.emit("remote-host-registered", { hostId: sanitizedHostId });
  };

  const getSingleAvailableHostId = () => {
    if (hosts.size !== 1) return "";
    const first = hosts.keys().next();
    return first.done ? "" : first.value;
  };

  const requestSession = ({ hostId } = {}) => {
    const sanitizedHostId = sanitizeString(hostId, 64);
    const resolvedHostId = sanitizedHostId || getSingleAvailableHostId();
    if (!resolvedHostId) {
      emitSessionError(
        "No unique host available. Start a host agent first.",
        "host-not-resolved"
      );
      return;
    }

    const host = hosts.get(resolvedHostId);
    if (!host) {
      emitSessionError("Host not found.", "host-not-found");
      return;
    }

    if (!host.socketId || !io.sockets.sockets.get(host.socketId)) {
      hosts.delete(resolvedHostId);
      emitSessionError("Host is offline.", "host-offline");
      return;
    }

    if (host.activeSessionId) {
      emitSessionError("Host is already in an active session.", "host-busy");
      return;
    }

    if (hasPendingRequestForHost(resolvedHostId)) {
      emitSessionError("Host already has a pending request.", "host-pending");
      return;
    }

    const existingControllerSession = socket.data?.controllerSessionId;
    if (existingControllerSession && sessions.get(existingControllerSession)) {
      emitSessionError(
        "Controller is already connected to another session.",
        "controller-busy"
      );
      return;
    }

    const existingPendingRequest = socket.data?.pendingRemoteRequestId;
    if (existingPendingRequest && pendingRequests.get(existingPendingRequest)) {
      emitSessionError(
        "Controller already has a pending request.",
        "controller-pending"
      );
      return;
    }

    const roomId = sanitizeString(socket.data?.roomId, 128);
    if (!roomId) {
      emitSessionError(
        "Join a room before requesting remote control.",
        "room-required"
      );
      return;
    }

    const roomSocketIds = io.sockets.adapter.rooms.get(roomId);
    const approverSocketId = roomSocketIds
      ? [...roomSocketIds].find((socketId) => socketId !== socket.id)
      : "";
    if (!approverSocketId) {
      emitSessionError(
        "No participant available to approve remote request.",
        "approver-not-found"
      );
      return;
    }

    const requestId = UUIDv4();
    const request = {
      requestId,
      hostId: resolvedHostId,
      hostSocketId: host.socketId,
      controllerSocketId: socket.id,
      requesterId: sanitizeString(socket.data?.peerId || socket.id, 64),
      roomId,
      approverSocketId,
      timeoutId: null,
    };

    request.timeoutId = setTimeout(() => {
      clearPendingRequest(requestId, {
        notifyController: true,
        controllerMessage: "Remote request timed out. No one accepted.",
        controllerCode: "request-timeout",
      });
    }, REMOTE_REQUEST_TIMEOUT_MS);

    pendingRequests.set(requestId, request);
    socket.data.pendingRemoteRequestId = requestId;

    socket.emit("remote-session-pending", {
      requestId,
      hostId: resolvedHostId,
    });

    emitToSocket(approverSocketId, "remote-session-requested-ui", {
      requestId,
      hostId: resolvedHostId,
      requesterId: request.requesterId,
    });
  };

  const decideSession = ({ requestId, accepted, reason }) => {
    const sanitizedRequestId = sanitizeString(requestId, 64);
    if (!sanitizedRequestId) return;

    const request = pendingRequests.get(sanitizedRequestId);
    if (!request) return;
    const decisionByHostAgent = request.hostSocketId === socket.id;
    const decisionByRoomParticipant = request.approverSocketId === socket.id;

    if (!decisionByHostAgent && !decisionByRoomParticipant) return;

    clearPendingRequest(sanitizedRequestId);

    if (!accepted) {
      emitToSocket(request.controllerSocketId, "remote-session-error", {
        message:
          sanitizeString(reason, 256) ||
          "Remote control request was rejected by host.",
        code: "request-rejected",
      });
      return;
    }

    const host = hosts.get(request.hostId);
    if (!host || host.socketId !== request.hostSocketId) {
      emitToSocket(request.controllerSocketId, "remote-session-error", {
        message: "Host is offline.",
        code: "host-offline",
      });
      return;
    }

    if (host.activeSessionId) {
      emitToSocket(request.controllerSocketId, "remote-session-error", {
        message: "Host is already in an active session.",
        code: "host-busy",
      });
      return;
    }

    const controllerSocket = io.sockets.sockets.get(request.controllerSocketId);
    if (!controllerSocket) {
      return;
    }

    const existingControllerSession = controllerSocket.data?.controllerSessionId;
    if (existingControllerSession && sessions.get(existingControllerSession)) {
      emitToSocket(request.hostSocketId, "remote-session-error", {
        message: "Controller is already connected to another session.",
        code: "controller-busy",
      });
      return;
    }

    const sessionId = UUIDv4();
    const session = {
      sessionId,
      hostId: request.hostId,
      hostSocketId: request.hostSocketId,
      controllerSocketId: request.controllerSocketId,
    };

    sessions.set(sessionId, session);
    hosts.set(request.hostId, { ...host, activeSessionId: sessionId });
    controllerSocket.data.controllerSessionId = sessionId;

    const hostSocket = io.sockets.sockets.get(request.hostSocketId);
    if (hostSocket?.data) {
      hostSocket.data.hostSessionId = sessionId;
    }

    const payload = { sessionId, hostId: request.hostId };
    emitToSocket(request.hostSocketId, "remote-session-started", payload);
    emitToSocket(request.controllerSocketId, "remote-session-started", payload);
  };

  const stopSession = ({ sessionId } = {}) => {
    const { sessionId: resolvedSessionId, session } = resolveSessionForSocket(
      socket,
      sessionId
    );
    if (!resolvedSessionId || !session) {
      const pendingRequestId = socket.data?.pendingRemoteRequestId;
      if (pendingRequestId) {
        const request = pendingRequests.get(pendingRequestId);
        if (request && request.controllerSocketId === socket.id) {
          clearPendingRequest(pendingRequestId, {
            notifyHost: true,
            hostMessage: "Controller cancelled the remote request.",
            hostCode: "request-cancelled",
          });
        }
      }
      return;
    }

    const isHost = session.hostSocketId === socket.id;
    const isController = session.controllerSocketId === socket.id;
    if (!isHost && !isController) return;

    endSession(resolvedSessionId, isHost ? "host" : "controller");
  };

  const receiveHostFrame = ({ sessionId, image, width, height, timestamp }) => {
    const sanitizedSessionId = sanitizeString(sessionId, 64);
    if (!sanitizedSessionId) return;

    const session = sessions.get(sanitizedSessionId);
    if (!session) return;
    if (session.hostSocketId !== socket.id) return;

    if (typeof image !== "string" || image.length === 0) return;
    if (image.length > 6_000_000) return;

    const normalizedWidth = Number.isFinite(Number(width)) ? Number(width) : null;
    const normalizedHeight = Number.isFinite(Number(height)) ? Number(height) : null;

    io.to(session.controllerSocketId).emit("remote-frame", {
      sessionId: sanitizedSessionId,
      image,
      width: normalizedWidth,
      height: normalizedHeight,
      timestamp: Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now(),
    });
  };

  const receiveControllerInput = ({ sessionId, event }) => {
    const sanitizedSessionId = sanitizeString(sessionId, 64);
    if (!sanitizedSessionId) return;

    const session = sessions.get(sanitizedSessionId);
    if (!session) return;
    if (session.controllerSocketId !== socket.id) return;

    const sanitizedEvent = sanitizeRemoteEvent(event);
    if (!sanitizedEvent) return;

    io.to(session.hostSocketId).emit("remote-input", {
      sessionId: sanitizedSessionId,
      event: sanitizedEvent,
    });
  };

  const handleDisconnect = () => {
    const hostId = socket.data?.remoteHostId;
    if (hostId) {
      const host = hosts.get(hostId);
      if (host?.activeSessionId) {
        endSession(host.activeSessionId, "host-disconnected");
      }
      for (const request of pendingRequests.values()) {
        if (request.hostSocketId === socket.id) {
          clearPendingRequest(request.requestId, {
            notifyController: true,
            controllerMessage: "Host disconnected before approving request.",
            controllerCode: "host-disconnected",
          });
        }
      }
      hosts.delete(hostId);
    }

    const pendingRequestId = socket.data?.pendingRemoteRequestId;
    if (pendingRequestId && pendingRequests.get(pendingRequestId)) {
      clearPendingRequest(pendingRequestId, {
        notifyHost: true,
        hostMessage: "Controller disconnected before request completion.",
        hostCode: "controller-disconnected",
      });
    }

    for (const request of pendingRequests.values()) {
      if (request.approverSocketId === socket.id) {
        clearPendingRequest(request.requestId, {
          notifyController: true,
          controllerMessage: "Approver disconnected before deciding request.",
          controllerCode: "approver-disconnected",
        });
      }
    }

    const controllerSessionId = socket.data?.controllerSessionId;
    if (controllerSessionId && sessions.get(controllerSessionId)) {
      endSession(controllerSessionId, "controller-disconnected");
    }
  };

  socket.on("remote-host-register", registerRemoteHost);
  socket.on("remote-session-request", requestSession);
  socket.on("remote-session-decision", decideSession);
  socket.on("remote-session-ui-decision", decideSession);
  socket.on("remote-session-stop", stopSession);
  socket.on("remote-host-frame", receiveHostFrame);
  socket.on("remote-input", receiveControllerInput);
  socket.on("disconnect", handleDisconnect);
};

export default remoteDesktopHandler;
