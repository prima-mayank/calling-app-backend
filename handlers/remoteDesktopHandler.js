import { v4 as UUIDv4 } from "uuid";

// hostId => { socketId, activeSessionId }
const hosts = new Map();
// sessionId => { hostId, hostSocketId, controllerSocketId }
const sessions = new Map();
// requestId => { requestId, hostId, hostSocketId, controllerSocketId, requesterId, roomId, approverSocketId, timeoutId }
const pendingRequests = new Map();
// requestId => { requestId, requesterSocketId, requesterPeerId, targetSocketId, targetPeerId, roomId, suggestedHostId, timeoutId }
const pendingHostSetupRequests = new Map();
// hostId => { hostId, targetSocketId, roomId, timeoutId }
const hostSetupAssignments = new Map();
// hostId => { socketId, roomId }
const hostClaims = new Map();
const REMOTE_REQUEST_TIMEOUT_MS = 45_000;
const HOST_SETUP_REQUEST_TIMEOUT_MS = 45_000;
const HOST_SETUP_ASSIGNMENT_TIMEOUT_MS = 15 * 60_000;

const sanitizeString = (value, maxLength = 128) => {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
};

const buildSuggestedHostId = (peerId) => {
  const normalizedPeerId = sanitizeString(peerId, 64).replace(/[^a-zA-Z0-9_-]/g, "");
  const suffix = normalizedPeerId.slice(0, 20) || UUIDv4().slice(0, 8);
  return `host-${suffix}`;
};

const getSocketNetworkId = (socket) => {
  const forwardedForRaw = String(socket?.handshake?.headers?.["x-forwarded-for"] || "").trim();
  const forwardedFor = forwardedForRaw.split(",")[0]?.trim() || "";
  const address = String(socket?.handshake?.address || "").trim();
  const candidate = forwardedFor || address;
  if (!candidate) return "";
  const normalized = candidate.toLowerCase();
  if (
    normalized === "::1" ||
    normalized === "127.0.0.1" ||
    normalized === "::ffff:127.0.0.1"
  ) {
    return "loopback-local";
  }
  return normalized;
};

const isLikelyPrivateOrLocalNetworkId = (networkId) => {
  const id = String(networkId || "").toLowerCase().trim();
  if (!id) return false;
  if (id === "loopback-local") return true;

  const plain = id.startsWith("::ffff:") ? id.slice(7) : id;
  if (/^10\./.test(plain)) return true;
  if (/^192\.168\./.test(plain)) return true;
  if (/^169\.254\./.test(plain)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(plain)) return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(plain)) return true;
  return false;
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
  const allowSameMachineRemote =
    String(process.env.ALLOW_SAME_MACHINE_REMOTE || "").trim() === "1";
  const remoteDebugEnabled = String(process.env.REMOTE_DEBUG || "").trim() === "1";
  const logRemote = (eventName, payload = {}) => {
    if (!remoteDebugEnabled) return;
    const normalizedEventName = sanitizeString(eventName, 64) || "event";
    console.log(`[remote] ${normalizedEventName}`, {
      socketId: socket.id,
      roomId: sanitizeString(socket.data?.roomId, 128) || "",
      ...payload,
    });
  };
  const remoteTrafficStats = new Map();
  const resolveHostOwnershipForSocket = (hostId, targetSocketId, targetRoomId) => {
    const claim = hostClaims.get(hostId);
    if (!claim?.socketId) return "unclaimed";

    const claimSocket = io.sockets.sockets.get(claim.socketId);
    if (!claimSocket) {
      hostClaims.delete(hostId);
      return "unclaimed";
    }

    const normalizedClaimRoomId = sanitizeString(claim.roomId, 128);
    if (!normalizedClaimRoomId || !targetRoomId || normalizedClaimRoomId !== targetRoomId) {
      return "unclaimed";
    }

    return claim.socketId === targetSocketId ? "you" : "other";
  };
  const markSessionTraffic = (sessionId, bucket) => {
    if (!remoteDebugEnabled || !sessionId || !bucket) return;
    const now = Date.now();
    const stats = remoteTrafficStats.get(sessionId) || {
      framesForwarded: 0,
      inputsForwarded: 0,
      lastLoggedAt: 0,
    };

    if (bucket === "frame") stats.framesForwarded += 1;
    if (bucket === "input") stats.inputsForwarded += 1;

    if (now - stats.lastLoggedAt >= 2_000) {
      logRemote("session-traffic", {
        sessionId,
        framesForwarded: stats.framesForwarded,
        inputsForwarded: stats.inputsForwarded,
      });
      stats.lastLoggedAt = now;
    }

    remoteTrafficStats.set(sessionId, stats);
  };

  const getAvailableHosts = (targetSocketId) => {
    const targetSocket = targetSocketId ? io.sockets.sockets.get(targetSocketId) : null;
    const targetRoomId = sanitizeString(targetSocket?.data?.roomId, 128);
    const result = [];
    for (const [hostId, host] of hosts.entries()) {
      if (!host?.socketId || !io.sockets.sockets.get(host.socketId)) {
        continue;
      }
      const ownership = resolveHostOwnershipForSocket(hostId, targetSocketId, targetRoomId);
      result.push({
        hostId,
        busy: !!host.activeSessionId,
        ownership,
      });
    }
    return result.sort((a, b) => a.hostId.localeCompare(b.hostId));
  };

  const emitHostsListToSocket = (targetSocketId) => {
    if (!targetSocketId) return;
    const hostsList = getAvailableHosts(targetSocketId);
    logRemote("emit-hosts-list-to-socket", {
      targetSocketId,
      count: hostsList.length,
      hosts: hostsList,
    });
    io.to(targetSocketId).emit("remote-hosts-list", {
      hosts: hostsList,
      timestamp: Date.now(),
    });
  };

  const broadcastHostsList = () => {
    const targetSocketIds = Array.from(io.sockets.sockets.keys());
    logRemote("broadcast-hosts-list", { count: targetSocketIds.length });
    targetSocketIds.forEach((targetSocketId) => emitHostsListToSocket(targetSocketId));
  };

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
    logRemote("clear-pending-request", {
      requestId,
      hostId: request.hostId,
      controllerSocketId: request.controllerSocketId,
      approverSocketId: request.approverSocketId,
      options,
    });

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

  const clearHostSetupRequest = (requestId, options = {}) => {
    const request = pendingHostSetupRequests.get(requestId);
    if (!request) return null;

    if (request.timeoutId) {
      clearTimeout(request.timeoutId);
    }

    pendingHostSetupRequests.delete(requestId);

    const requesterSocket = io.sockets.sockets.get(request.requesterSocketId);
    if (requesterSocket?.data?.pendingHostSetupRequestId === requestId) {
      delete requesterSocket.data.pendingHostSetupRequestId;
    }

    const targetSocket = io.sockets.sockets.get(request.targetSocketId);
    if (targetSocket?.data?.incomingHostSetupRequestId === requestId) {
      delete targetSocket.data.incomingHostSetupRequestId;
    }

    if (options.notifyRequester) {
      emitToSocket(request.requesterSocketId, "remote-host-setup-result", {
        requestId,
        status: sanitizeString(options.status, 24) || "failed",
        targetPeerId: request.targetPeerId,
        suggestedHostId: request.suggestedHostId,
        message:
          sanitizeString(options.message, 256) ||
          "Host setup request was cancelled.",
      });
    }

    return request;
  };

  const clearHostSetupAssignment = (hostId) => {
    const normalizedHostId = sanitizeString(hostId, 64);
    if (!normalizedHostId) return null;

    const assignment = hostSetupAssignments.get(normalizedHostId);
    if (!assignment) return null;

    if (assignment.timeoutId) {
      clearTimeout(assignment.timeoutId);
    }

    hostSetupAssignments.delete(normalizedHostId);
    return assignment;
  };

  const setHostSetupAssignment = ({ hostId, targetSocketId, roomId }) => {
    const normalizedHostId = sanitizeString(hostId, 64);
    const normalizedRoomId = sanitizeString(roomId, 128);
    if (!normalizedHostId || !targetSocketId || !normalizedRoomId) {
      return null;
    }

    clearHostSetupAssignment(normalizedHostId);

    const assignment = {
      hostId: normalizedHostId,
      targetSocketId,
      roomId: normalizedRoomId,
      timeoutId: null,
    };

    assignment.timeoutId = setTimeout(() => {
      const activeAssignment = hostSetupAssignments.get(normalizedHostId);
      if (!activeAssignment || activeAssignment.targetSocketId !== targetSocketId) {
        return;
      }
      clearHostSetupAssignment(normalizedHostId);
      logRemote("host-setup-assignment-expired", {
        hostId: normalizedHostId,
        roomId: normalizedRoomId,
        targetSocketId,
      });
    }, HOST_SETUP_ASSIGNMENT_TIMEOUT_MS);

    hostSetupAssignments.set(normalizedHostId, assignment);
    logRemote("host-setup-assignment-set", {
      hostId: normalizedHostId,
      roomId: normalizedRoomId,
      targetSocketId,
    });
    return assignment;
  };

  const resolveActiveHostSetupAssignment = (hostId, roomId = "") => {
    const normalizedHostId = sanitizeString(hostId, 64);
    if (!normalizedHostId) return null;

    const assignment = hostSetupAssignments.get(normalizedHostId);
    if (!assignment) return null;

    const requestedRoomId = sanitizeString(roomId, 128);
    if (requestedRoomId && assignment.roomId !== requestedRoomId) {
      return null;
    }

    const targetSocket = io.sockets.sockets.get(assignment.targetSocketId);
    if (!targetSocket) {
      clearHostSetupAssignment(normalizedHostId);
      logRemote("host-setup-assignment-cleared-offline-target", {
        hostId: normalizedHostId,
      });
      return null;
    }

    const targetSocketRoomId = sanitizeString(targetSocket.data?.roomId, 128);
    if (!targetSocketRoomId || targetSocketRoomId !== assignment.roomId) {
      clearHostSetupAssignment(normalizedHostId);
      logRemote("host-setup-assignment-cleared-room-mismatch", {
        hostId: normalizedHostId,
        assignmentRoomId: assignment.roomId,
        targetSocketRoomId,
      });
      return null;
    }

    return assignment;
  };

  const clearHostSetupAssignmentsForSocket = (socketId) => {
    let clearedCount = 0;
    for (const [hostId, assignment] of hostSetupAssignments.entries()) {
      if (assignment?.targetSocketId === socketId) {
        clearHostSetupAssignment(hostId);
        clearedCount += 1;
      }
    }
    return clearedCount;
  };

  const clearClaimsForSocket = (socketId) => {
    let clearedClaimsCount = 0;
    for (const [hostId, claim] of hostClaims.entries()) {
      if (claim?.socketId === socketId) {
        logRemote("clear-host-claim", { hostId, claimSocketId: socketId });
        hostClaims.delete(hostId);
        clearedClaimsCount += 1;
      }
    }
    return clearedClaimsCount;
  };

  const resolveClaimedApproverSocketId = (hostId, roomId) => {
    const claim = hostClaims.get(hostId);
    if (!claim) return "";

    if (claim.roomId !== roomId) {
      hostClaims.delete(hostId);
      logRemote("resolve-approver-claim-room-mismatch", {
        hostId,
        requestedRoomId: roomId,
        claimRoomId: claim.roomId,
      });
      return "";
    }

    const claimedSocket = io.sockets.sockets.get(claim.socketId);
    if (!claimedSocket) {
      hostClaims.delete(hostId);
      logRemote("resolve-approver-claim-socket-offline", { hostId });
      return "";
    }

    if (sanitizeString(claimedSocket.data?.roomId, 128) !== roomId) {
      hostClaims.delete(hostId);
      logRemote("resolve-approver-claim-socket-room-mismatch", {
        hostId,
        requestedRoomId: roomId,
        socketRoomId: sanitizeString(claimedSocket.data?.roomId, 128) || "",
      });
      return "";
    }

    return claim.socketId;
  };

  const tryAutoClaimHostOwner = ({ hostId }) => {
    const normalizedHostId = sanitizeString(hostId, 64);
    if (!normalizedHostId) return false;

    const assignment = resolveActiveHostSetupAssignment(normalizedHostId);
    if (!assignment) {
      logRemote("auto-claim-host-skipped", {
        hostId: normalizedHostId,
        reason: "no-active-assignment",
      });
      return false;
    }

    hostClaims.set(normalizedHostId, {
      socketId: assignment.targetSocketId,
      roomId: assignment.roomId,
    });
    emitToSocket(assignment.targetSocketId, "remote-host-claimed", {
      hostId: normalizedHostId,
      roomId: assignment.roomId,
      auto: true,
    });
    clearHostSetupAssignment(normalizedHostId);
    logRemote("auto-claim-host-success", {
      hostId: normalizedHostId,
      ownerSocketId: assignment.targetSocketId,
      roomId: assignment.roomId,
      source: "host-setup-assignment",
    });
    return true;
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
    logRemote("end-session", { sessionId, endedBy, hostId: session.hostId });

    sessions.delete(sessionId);
    remoteTrafficStats.delete(sessionId);

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

    broadcastHostsList();
  };

  const registerRemoteHost = ({ hostId }) => {
    const sanitizedHostId = sanitizeString(hostId, 64);
    logRemote("register-host-attempt", { hostId: sanitizedHostId });
    if (!sanitizedHostId) {
      emitSessionError("hostId is required.", "host-register-invalid");
      return;
    }

    const existing = hosts.get(sanitizedHostId);
    if (existing && existing.socketId && existing.socketId !== socket.id) {
      const existingSocketOnline = !!io.sockets.sockets.get(existing.socketId);
      if (existingSocketOnline) {
        logRemote("register-host-duplicate-blocked", {
          hostId: sanitizedHostId,
          existingSocketId: existing.socketId,
        });
        emitSessionError(
          `Host ID '${sanitizedHostId}' is already in use by another connected agent. Use a unique REMOTE_HOST_ID.`,
          "host-id-in-use"
        );
        return;
      }

      // Cleanup stale mapping and allow registration.
      hosts.delete(sanitizedHostId);
    }

    hosts.set(sanitizedHostId, {
      socketId: socket.id,
      activeSessionId: "",
      networkId: getSocketNetworkId(socket),
    });

    tryAutoClaimHostOwner({ hostId: sanitizedHostId });

    socket.data.remoteHostId = sanitizedHostId;
    socket.emit("remote-host-registered", { hostId: sanitizedHostId });
    logRemote("register-host-success", { hostId: sanitizedHostId });
    broadcastHostsList();
  };

  const claimRemoteHost = ({ hostId }) => {
    const sanitizedHostId = sanitizeString(hostId, 64);
    logRemote("claim-host-attempt", { hostId: sanitizedHostId });
    if (!sanitizedHostId) {
      emitSessionError("Select a valid host to claim.", "host-claim-invalid");
      return;
    }

    const roomId = sanitizeString(socket.data?.roomId, 128);
    if (!roomId) {
      emitSessionError("Join a room before claiming a host.", "room-required");
      return;
    }

    const activeHostSetupAssignment = resolveActiveHostSetupAssignment(sanitizedHostId);
    if (
      activeHostSetupAssignment &&
      (activeHostSetupAssignment.roomId !== roomId ||
        activeHostSetupAssignment.targetSocketId !== socket.id)
    ) {
      logRemote("claim-host-blocked-assigned-to-other", {
        hostId: sanitizedHostId,
        roomId,
        claimerSocketId: socket.id,
        assignmentRoomId: activeHostSetupAssignment.roomId,
        assignedSocketId: activeHostSetupAssignment.targetSocketId,
      });
      emitSessionError(
        "This host is assigned to another participant.",
        "host-claim-assigned-other"
      );
      return;
    }

    const host = hosts.get(sanitizedHostId);
    if (!host || !host.socketId || !io.sockets.sockets.get(host.socketId)) {
      if (hosts.has(sanitizedHostId)) {
        hosts.delete(sanitizedHostId);
        broadcastHostsList();
      }
      emitSessionError("Host is offline or unavailable.", "host-offline");
      return;
    }

    const hostSocket = io.sockets.sockets.get(host.socketId);
    if (!hostSocket) {
      hosts.delete(sanitizedHostId);
      broadcastHostsList();
      emitSessionError("Host is offline or unavailable.", "host-offline");
      return;
    }

    const claimerNetworkId = getSocketNetworkId(socket);
    const hostNetworkId = getSocketNetworkId(hostSocket);
    if (claimerNetworkId && hostNetworkId && claimerNetworkId !== hostNetworkId) {
      logRemote("claim-host-owner-mismatch", {
        hostId: sanitizedHostId,
        claimerNetworkId,
        hostNetworkId,
      });
      emitSessionError(
        "You can only claim a host running on your own device/network session.",
        "host-claim-owner-mismatch"
      );
      return;
    }

    const existingClaim = hostClaims.get(sanitizedHostId);
    if (existingClaim && existingClaim.socketId && existingClaim.socketId !== socket.id) {
      const existingClaimSocket = io.sockets.sockets.get(existingClaim.socketId);
      if (
        existingClaimSocket &&
        sanitizeString(existingClaimSocket.data?.roomId, 128) === roomId
      ) {
        logRemote("claim-host-blocked-already-claimed", {
          hostId: sanitizedHostId,
          existingClaimSocketId: existingClaim.socketId,
        });
        emitSessionError(
          "This host is already claimed by another participant in this room.",
          "host-claimed-by-other"
        );
        return;
      }
      hostClaims.delete(sanitizedHostId);
    }

    hostClaims.set(sanitizedHostId, {
      socketId: socket.id,
      roomId,
    });
    if (
      activeHostSetupAssignment &&
      activeHostSetupAssignment.targetSocketId === socket.id
    ) {
      clearHostSetupAssignment(sanitizedHostId);
    }
    logRemote("claim-host-success", { hostId: sanitizedHostId, roomId });

    socket.emit("remote-host-claimed", { hostId: sanitizedHostId, roomId });
    broadcastHostsList();
  };

  const resolveRoomParticipantSockets = (roomId) => {
    if (!roomId) return [];
    const roomSockets = io.sockets.adapter.rooms.get(roomId);
    if (!roomSockets || roomSockets.size === 0) return [];

    const participants = [];
    for (const socketId of roomSockets) {
      const roomSocket = io.sockets.sockets.get(socketId);
      if (!roomSocket) continue;
      const peerId = sanitizeString(roomSocket.data?.peerId, 64);
      if (!peerId) continue;
      participants.push({ socket: roomSocket, peerId });
    }
    return participants;
  };

  const requestHostSetup = ({ targetPeerId } = {}) => {
    const roomId = sanitizeString(socket.data?.roomId, 128);
    const requesterPeerId = sanitizeString(socket.data?.peerId || socket.id, 64);
    const normalizedTargetPeerId = sanitizeString(targetPeerId, 64);

    logRemote("host-setup-request-attempt", {
      roomId,
      requesterPeerId,
      targetPeerId: normalizedTargetPeerId,
    });

    if (!roomId) {
      emitSessionError("Join a room before requesting host setup.", "room-required");
      return;
    }

    const existingPending = socket.data?.pendingHostSetupRequestId;
    if (existingPending && pendingHostSetupRequests.get(existingPending)) {
      emitSessionError(
        "A host setup request is already pending.",
        "host-setup-pending"
      );
      return;
    }

    const participants = resolveRoomParticipantSockets(roomId).filter(
      (participant) => participant.peerId !== requesterPeerId
    );

    if (participants.length === 0) {
      emitSessionError(
        "No other participant is available for host setup.",
        "participant-not-found"
      );
      return;
    }

    let selectedParticipant = null;
    if (normalizedTargetPeerId) {
      selectedParticipant =
        participants.find((participant) => participant.peerId === normalizedTargetPeerId) ||
        null;
      if (!selectedParticipant) {
        emitSessionError("Selected participant is not available.", "participant-not-found");
        return;
      }
    } else if (participants.length === 1) {
      selectedParticipant = participants[0];
    } else {
      emitSessionError(
        "Select a participant before requesting host setup.",
        "participant-required"
      );
      return;
    }

    if (!selectedParticipant?.socket || selectedParticipant.socket.id === socket.id) {
      emitSessionError("Invalid host setup target.", "participant-invalid");
      return;
    }

    const requestId = UUIDv4();
    const suggestedHostId = buildSuggestedHostId(selectedParticipant.peerId);
    const request = {
      requestId,
      requesterSocketId: socket.id,
      requesterPeerId,
      targetSocketId: selectedParticipant.socket.id,
      targetPeerId: selectedParticipant.peerId,
      roomId,
      suggestedHostId,
      timeoutId: null,
    };

    request.timeoutId = setTimeout(() => {
      clearHostSetupRequest(requestId, {
        notifyRequester: true,
        status: "timeout",
        message: "Host setup request timed out.",
      });
    }, HOST_SETUP_REQUEST_TIMEOUT_MS);

    pendingHostSetupRequests.set(requestId, request);
    socket.data.pendingHostSetupRequestId = requestId;
    selectedParticipant.socket.data.incomingHostSetupRequestId = requestId;

    emitToSocket(socket.id, "remote-host-setup-pending", {
      requestId,
      targetPeerId: request.targetPeerId,
      suggestedHostId,
    });

    emitToSocket(selectedParticipant.socket.id, "remote-host-setup-requested", {
      requestId,
      requesterId: requesterPeerId,
      targetPeerId: request.targetPeerId,
      suggestedHostId,
    });

    logRemote("host-setup-request-pending", {
      requestId,
      targetPeerId: request.targetPeerId,
      suggestedHostId,
    });
  };

  const decideHostSetup = ({ requestId, accepted }) => {
    const normalizedRequestId = sanitizeString(requestId, 64);
    if (!normalizedRequestId) return;

    const request = pendingHostSetupRequests.get(normalizedRequestId);
    if (!request) return;
    if (request.targetSocketId !== socket.id) return;

    clearHostSetupRequest(normalizedRequestId);

    if (!accepted) {
      emitToSocket(request.requesterSocketId, "remote-host-setup-result", {
        requestId: normalizedRequestId,
        status: "rejected",
        targetPeerId: request.targetPeerId,
        suggestedHostId: request.suggestedHostId,
        message: "Participant rejected host setup request.",
      });
      logRemote("host-setup-request-rejected", {
        requestId: normalizedRequestId,
        targetPeerId: request.targetPeerId,
      });
      return;
    }

    const normalizedSuggestedHostId = sanitizeString(request.suggestedHostId, 64);
    if (normalizedSuggestedHostId) {
      setHostSetupAssignment({
        hostId: normalizedSuggestedHostId,
        targetSocketId: request.targetSocketId,
        roomId: request.roomId,
      });
      if (tryAutoClaimHostOwner({ hostId: normalizedSuggestedHostId })) {
        broadcastHostsList();
      }
    }

    emitToSocket(request.requesterSocketId, "remote-host-setup-result", {
      requestId: normalizedRequestId,
      status: "accepted",
      targetPeerId: request.targetPeerId,
      suggestedHostId: request.suggestedHostId,
      message: `Participant accepted. Waiting for host '${request.suggestedHostId}' to come online.`,
    });

    logRemote("host-setup-request-accepted", {
      requestId: normalizedRequestId,
      targetPeerId: request.targetPeerId,
      suggestedHostId: request.suggestedHostId,
    });
  };

  const requestSession = ({ hostId } = {}) => {
    const sanitizedHostId = sanitizeString(hostId, 64);
    logRemote("request-session-attempt", { hostId: sanitizedHostId });
    if (!sanitizedHostId) {
      emitSessionError("Select a host before requesting remote control.", "host-required");
      return;
    }

    const host = hosts.get(sanitizedHostId);
    if (!host) {
      emitSessionError("Host not found.", "host-not-found");
      return;
    }

    if (!host.socketId || !io.sockets.sockets.get(host.socketId)) {
      hosts.delete(sanitizedHostId);
      broadcastHostsList();
      emitSessionError("Host is offline.", "host-offline");
      return;
    }

    const requesterNetworkId = getSocketNetworkId(socket);
    const hostNetworkId = sanitizeString(host.networkId, 128);
    if (
      !allowSameMachineRemote &&
      requesterNetworkId &&
      hostNetworkId &&
      requesterNetworkId === hostNetworkId &&
      isLikelyPrivateOrLocalNetworkId(requesterNetworkId)
    ) {
      logRemote("request-session-self-machine-blocked", {
        hostId: sanitizedHostId,
        requesterNetworkId,
        hostNetworkId,
      });
      emitSessionError(
        "Selected host appears to be on the same local machine/session as requester. Use the other device's host agent.",
        "self-host-machine-blocked"
      );
      return;
    }

    if (host.activeSessionId) {
      emitSessionError("Host is already in an active session.", "host-busy");
      return;
    }

    if (hasPendingRequestForHost(sanitizedHostId)) {
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
      emitSessionError("Join a room before requesting remote control.", "room-required");
      return;
    }

    const resolvedApproverSocketId = resolveClaimedApproverSocketId(
      sanitizedHostId,
      roomId
    );
    logRemote("request-session-resolved-approver", {
      hostId: sanitizedHostId,
      roomId,
      approverSocketId: resolvedApproverSocketId,
    });
    if (!resolvedApproverSocketId) {
      emitSessionError(
        "Host owner has not claimed this host in the room yet. Ask the host-side participant to click 'Claim As My Host', then retry.",
        "host-owner-unclaimed"
      );
      return;
    }

    if (resolvedApproverSocketId === socket.id) {
      logRemote("request-session-self-blocked", {
        hostId: sanitizedHostId,
        roomId,
      });
      emitSessionError(
        "You cannot request remote control for a host claimed by yourself.",
        "self-host-request-blocked"
      );
      return;
    }

    const requestId = UUIDv4();
    const request = {
      requestId,
      hostId: sanitizedHostId,
      hostSocketId: host.socketId,
      controllerSocketId: socket.id,
      requesterId: sanitizeString(socket.data?.peerId || socket.id, 64),
      roomId,
      approverSocketId: resolvedApproverSocketId,
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
    logRemote("request-session-pending-created", {
      requestId,
      hostId: sanitizedHostId,
      approverSocketId: resolvedApproverSocketId,
      controllerSocketId: socket.id,
    });

    socket.emit("remote-session-pending", {
      requestId,
      hostId: sanitizedHostId,
    });

    emitToSocket(resolvedApproverSocketId, "remote-session-requested-ui", {
      requestId,
      hostId: sanitizedHostId,
      requesterId: request.requesterId,
    });
  };

  const decideSession = ({ requestId, accepted, reason }) => {
    const sanitizedRequestId = sanitizeString(requestId, 64);
    if (!sanitizedRequestId) return;

    const request = pendingRequests.get(sanitizedRequestId);
    if (!request) return;
    logRemote("decide-session-attempt", {
      requestId: sanitizedRequestId,
      accepted: !!accepted,
      reason: sanitizeString(reason, 256),
      hostId: request.hostId,
      requestApproverSocketId: request.approverSocketId,
      requestHostSocketId: request.hostSocketId,
    });

    const decisionByHostAgent = request.hostSocketId === socket.id;
    const decisionByRoomParticipant = request.approverSocketId === socket.id;
    if (!decisionByHostAgent && !decisionByRoomParticipant) return;

    clearPendingRequest(sanitizedRequestId);

    if (!accepted) {
      logRemote("decide-session-rejected", { requestId: sanitizedRequestId });
      emitToSocket(request.controllerSocketId, "remote-session-error", {
        message:
          sanitizeString(reason, 256) || "Remote control request was rejected by host.",
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
    if (!controllerSocket) return;

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
    logRemote("decide-session-started", {
      sessionId,
      hostId: request.hostId,
      controllerSocketId: request.controllerSocketId,
      hostSocketId: request.hostSocketId,
    });
    broadcastHostsList();
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
    logRemote("stop-session-attempt", {
      resolvedSessionId,
      requestedSessionId: sanitizeString(sessionId, 64),
      hostSocketId: session.hostSocketId,
      controllerSocketId: session.controllerSocketId,
    });

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
    markSessionTraffic(sanitizedSessionId, "frame");
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
    markSessionTraffic(sanitizedSessionId, "input");
  };

  const handleDisconnect = () => {
    logRemote("socket-disconnect");
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
      broadcastHostsList();
    }

    if (clearClaimsForSocket(socket.id) > 0) {
      broadcastHostsList();
    }
    clearHostSetupAssignmentsForSocket(socket.id);

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

    const pendingHostSetupRequestId = socket.data?.pendingHostSetupRequestId;
    if (
      pendingHostSetupRequestId &&
      pendingHostSetupRequests.get(pendingHostSetupRequestId)
    ) {
      clearHostSetupRequest(pendingHostSetupRequestId);
    }

    for (const setupRequest of Array.from(pendingHostSetupRequests.values())) {
      if (setupRequest.targetSocketId === socket.id) {
        clearHostSetupRequest(setupRequest.requestId, {
          notifyRequester: true,
          status: "target-disconnected",
          message: "Participant disconnected before host setup decision.",
        });
      }
      if (setupRequest.requesterSocketId === socket.id) {
        clearHostSetupRequest(setupRequest.requestId);
      }
    }

    const controllerSessionId = socket.data?.controllerSessionId;
    if (controllerSessionId && sessions.get(controllerSessionId)) {
      endSession(controllerSessionId, "controller-disconnected");
    }
  };

  socket.on("remote-host-register", registerRemoteHost);
  socket.on("remote-host-claim", claimRemoteHost);
  socket.on("remote-hosts-request", () => emitHostsListToSocket(socket.id));
  socket.on("remote-host-setup-request", requestHostSetup);
  socket.on("remote-host-setup-decision", decideHostSetup);
  socket.on("remote-session-request", requestSession);
  socket.on("remote-session-decision", decideSession);
  socket.on("remote-session-ui-decision", decideSession);
  socket.on("remote-session-stop", stopSession);
  socket.on("remote-host-frame", receiveHostFrame);
  socket.on("remote-input", receiveControllerInput);
  socket.on("leave-room", () => {
    if (clearClaimsForSocket(socket.id) > 0) {
      broadcastHostsList();
    }
    clearHostSetupAssignmentsForSocket(socket.id);

    const pendingHostSetupRequestId = socket.data?.pendingHostSetupRequestId;
    if (
      pendingHostSetupRequestId &&
      pendingHostSetupRequests.get(pendingHostSetupRequestId)
    ) {
      clearHostSetupRequest(pendingHostSetupRequestId);
    }

    for (const setupRequest of Array.from(pendingHostSetupRequests.values())) {
      if (setupRequest.targetSocketId === socket.id) {
        clearHostSetupRequest(setupRequest.requestId, {
          notifyRequester: true,
          status: "target-left-room",
          message: "Participant left the room before host setup decision.",
        });
      }
      if (setupRequest.requesterSocketId === socket.id) {
        clearHostSetupRequest(setupRequest.requestId);
      }
    }
  });
  socket.on("disconnect", handleDisconnect);
};

export default remoteDesktopHandler;
