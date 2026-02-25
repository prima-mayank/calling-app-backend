import {
  HOST_SETUP_ASSIGNMENT_TIMEOUT_MS,
  hostClaims,
  hostSetupAssignments,
  hosts,
  pendingHostSetupRequests,
  pendingRequests,
  sessions,
} from "./state.js";
import { sanitizeString, resolveParticipantLabel } from "./utils.js";

export const createRemoteDesktopRuntime = ({
  io,
  socket,
  logRemote,
  remoteDebugEnabled,
}) => {
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
      const hostSocket = io.sockets.sockets.get(host.socketId);
      const ownership = resolveHostOwnershipForSocket(hostId, targetSocketId, targetRoomId);
      // compute a friendly label for the host based on any authenticated user data
      // stored on the socket; fallback to hostId.
      const label = resolveParticipantLabel(hostSocket, hostId);
      result.push({
        hostId,
        busy: !!host.activeSessionId,
        ownership,
        label,
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

  return {
    markSessionTraffic,
    emitHostsListToSocket,
    broadcastHostsList,
    emitSessionError,
    emitToSocket,
    clearPendingRequest,
    clearHostSetupRequest,
    clearHostSetupAssignment,
    setHostSetupAssignment,
    resolveActiveHostSetupAssignment,
    clearHostSetupAssignmentsForSocket,
    clearClaimsForSocket,
    resolveClaimedApproverSocketId,
    tryAutoClaimHostOwner,
    hasPendingRequestForHost,
    endSession,
    resolveRoomParticipantSockets,
  };
};
