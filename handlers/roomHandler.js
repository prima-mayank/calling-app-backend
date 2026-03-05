import { v4 as UUIDv4 } from "uuid";

// In-memory room store
// roomId => {
//   participants: string[],
//   peerToSocket: Record<string, string>,
//   socketToPeer: Record<string, string>,
//   peerProfiles: Record<string, { displayName: string, email: string, label: string }>
// }
const rooms = {};

// Server-wide setting — read once at module load, not per socket connection.
const autoCreateOnJoin =
  String(process.env.ROOM_AUTO_CREATE_ON_JOIN || "").trim() !== "0";

const roomHandler = (socket) => {

  const isUuidLike = (value) => {
    if (typeof value !== "string") return false;
    const v = value.trim();
    if (!v) return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      v
    );
  };

  const createRoomState = () => ({
    participants: [],
    peerToSocket: {},
    socketToPeer: {},
    peerProfiles: {},
  });

  const normalizeProfileText = (value, limit = 128) =>
    String(value || "")
      .trim()
      .slice(0, limit);

  const buildPeerProfileFromSocket = (targetSocket, peerId) => {
    const displayName = normalizeProfileText(targetSocket?.data?.authDisplayName, 128);
    const email = normalizeProfileText(targetSocket?.data?.authEmail, 128);
    const fallbackPeerId = normalizeProfileText(peerId, 64);
    const label = displayName || email || fallbackPeerId;
    return {
      displayName,
      email,
      label,
    };
  };

  const buildParticipantProfilesPayload = (room) => {
    if (!room) return {};

    const payload = {};
    room.participants.forEach((peerId) => {
      const normalizedPeerId = String(peerId || "").trim();
      if (!normalizedPeerId) return;
      const profile = room.peerProfiles?.[normalizedPeerId] || {};
      const displayName = normalizeProfileText(profile.displayName, 128);
      const email = normalizeProfileText(profile.email, 128);
      payload[normalizedPeerId] = {
        displayName,
        email,
        label: normalizeProfileText(profile.label, 128) || displayName || email || normalizedPeerId,
      };
    });
    return payload;
  };

  const isSocketActive = (socketId) =>
    !!socketId && socket.nsp?.sockets?.has(socketId);

  const pruneRoomState = (roomId) => {
    const room = rooms[roomId];
    if (!room) return;

    Object.entries(room.peerToSocket).forEach(([peerId, socketId]) => {
      if (!isSocketActive(socketId) || room.socketToPeer[socketId] !== peerId) {
        delete room.peerToSocket[peerId];
      }
    });

    Object.entries(room.socketToPeer).forEach(([socketId, peerId]) => {
      if (!isSocketActive(socketId) || room.peerToSocket[peerId] !== socketId) {
        delete room.socketToPeer[socketId];
      }
    });

    room.participants = [...new Set(room.participants)].filter((peerId) => {
      const peerSocketId = room.peerToSocket[peerId];
      return !!peerSocketId && isSocketActive(peerSocketId);
    });
    const activeParticipantSet = new Set(room.participants);
    Object.keys(room.peerProfiles || {}).forEach((peerId) => {
      if (!activeParticipantSet.has(peerId)) {
        delete room.peerProfiles[peerId];
      }
    });

    // Only delete the room if it's truly empty (no participants AND no sockets currently joined).
    // A brand new room starts with 0 participants until the creator emits `joined-room`.
    const roomSocketIds = socket.nsp?.adapter?.rooms?.get(roomId);
    const hasSocketsInRoom = !!roomSocketIds && roomSocketIds.size > 0;
    if (room.participants.length === 0 && !hasSocketsInRoom) {
      delete rooms[roomId];
    }
  };

  const getSocketIdentity = () => ({
    roomId: socket.data?.roomId,
    peerId: socket.data?.peerId,
  });

  const removePeerFromRoom = ({ roomId, peerId, socketId }) => {
    const room = rooms[roomId];
    if (!room || !peerId) return;

    room.participants = room.participants.filter((id) => id !== peerId);
    delete room.peerToSocket[peerId];
    delete room.socketToPeer[socketId];
    delete room.peerProfiles[peerId];

    socket.to(roomId).emit("user-left", { peerId });
    // Do not delete the room here. A room can have 0 participants temporarily
    // while sockets are still joined (e.g. creator created room but hasn't emitted
    // `joined-room` yet). Cleanup is handled via `pruneRoomState()` after socket leaves.
  };

  const leaveCurrentRoom = () => {
    const { roomId, peerId } = getSocketIdentity();
    if (!roomId) return;

    if (peerId) {
      removePeerFromRoom({ roomId, peerId, socketId: socket.id });
    }

    // Socket.IO adapters may implement join/leave asynchronously; treat them as async-capable.
    Promise.resolve(socket.leave(roomId))
      .catch(() => {
        // noop: leaving should be best-effort
      })
      .finally(() => {
        pruneRoomState(roomId);
      });

    delete socket.data.roomId;
    delete socket.data.peerId;
  };

  const createRoom = async () => {
    const roomId = UUIDv4();

    if (!rooms[roomId]) {
      rooms[roomId] = createRoomState();
    }

    // Ensure the socket is actually in the adapter room before the client navigates and
    // immediately emits `joined-room` (which can prune empty rooms).
    await socket.join(roomId);
    socket.data.roomId = roomId;
    socket.emit("room-created", { roomId });
  };

  const joinedRoom = async ({ roomId, peerId }) => {
    const normalizedRoomId = typeof roomId === "string" ? roomId.trim() : "";
    if (!normalizedRoomId) return;

    let room = rooms[normalizedRoomId];
    if (!room) {
      if (autoCreateOnJoin && isUuidLike(normalizedRoomId)) {
        rooms[normalizedRoomId] = createRoomState();
        room = rooms[normalizedRoomId];
      } else {
        socket.emit("room-not-found");
        return;
      }
    }
    if (!peerId) return;

    // Join first so pruning logic doesn't delete a just-created (0 participant) room before
    // we have a chance to register the peer.
    await socket.join(normalizedRoomId);
    pruneRoomState(normalizedRoomId);

    const previousRoomId = socket.data?.roomId;
    const previousPeerId = socket.data?.peerId;
    if (
      previousRoomId &&
      previousPeerId &&
      (previousRoomId !== normalizedRoomId || previousPeerId !== peerId)
    ) {
      removePeerFromRoom({
        roomId: previousRoomId,
        peerId: previousPeerId,
        socketId: socket.id,
      });

      if (previousRoomId !== normalizedRoomId) {
        socket.leave(previousRoomId);
      }
    }

    const existingSocketId = room.peerToSocket[peerId];
    if (existingSocketId && existingSocketId !== socket.id) {
      removePeerFromRoom({
        roomId: normalizedRoomId,
        peerId,
        socketId: existingSocketId,
      });

      const existingSocket = socket.nsp?.sockets?.get(existingSocketId);
      if (existingSocket) {
        existingSocket.leave(normalizedRoomId);
        if (existingSocket.data?.roomId === normalizedRoomId) {
          delete existingSocket.data.roomId;
          delete existingSocket.data.peerId;
        }
      }
    }

    if (!room.participants.includes(peerId)) {
      room.participants.push(peerId);
    }

    room.peerToSocket[peerId] = socket.id;
    room.socketToPeer[socket.id] = peerId;
    room.peerProfiles[peerId] = buildPeerProfileFromSocket(socket, peerId);

    socket.data.roomId = normalizedRoomId;
    socket.data.peerId = peerId;

    socket.emit("get-users", {
      roomId: normalizedRoomId,
      participants: room.participants,
      participantProfiles: buildParticipantProfilesPayload(room),
    });
  };

  const ready = () => {
    const { roomId, peerId } = getSocketIdentity();
    if (!roomId || !peerId) return;
    pruneRoomState(roomId);
    if (!rooms[roomId]) return;
    if (rooms[roomId].socketToPeer[socket.id] !== peerId) return;

    socket.to(roomId).emit("user-joined", {
      peerId,
      participantProfile: buildPeerProfileFromSocket(socket, peerId),
    });
  };

  socket.on("create-room", createRoom);
  socket.on("joined-room", joinedRoom);
  socket.on("ready", ready);
  socket.on("leave-room", leaveCurrentRoom);
  socket.on("disconnect", leaveCurrentRoom);
};

export default roomHandler;
