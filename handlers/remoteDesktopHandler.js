import { v4 as UUIDv4 } from "uuid";
import {
  HOST_SETUP_REQUEST_TIMEOUT_MS,
  REMOTE_REQUEST_TIMEOUT_MS,
  hostClaims,
  hosts,
  pendingHostSetupRequests,
  pendingRequests,
  sessions,
} from "./remoteDesktop/state.js";
import {
  buildSuggestedHostId,
  getSocketNetworkId,
  isLikelyPrivateOrLocalNetworkId,
  resolveSessionForSocket,
  sanitizeRemoteEvent,
  sanitizeString,
} from "./remoteDesktop/utils.js";
import { createRemoteDesktopRuntime } from "./remoteDesktop/runtime.js";

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
  const {
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
  } = createRemoteDesktopRuntime({
    io,
    socket,
    logRemote,
    remoteDebugEnabled,
  });

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


