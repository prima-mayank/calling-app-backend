import { v4 as UUIDv4 } from "uuid";

// In-memory room store
// roomId => {
//   participants: string[],
//   peerToSocket: Record<string, string>,
//   socketToPeer: Record<string, string>
// }
const rooms = {};

const roomHandler = (socket) => {
  const createRoomState = () => ({
    participants: [],
    peerToSocket: {},
    socketToPeer: {},
  });

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

    socket.to(roomId).emit("user-left", { peerId });

    if (room.participants.length === 0) {
      delete rooms[roomId];
    }
  };

  const leaveCurrentRoom = () => {
    const { roomId, peerId } = getSocketIdentity();
    if (!roomId || !peerId) return;

    removePeerFromRoom({ roomId, peerId, socketId: socket.id });
    socket.leave(roomId);
    delete socket.data.roomId;
    delete socket.data.peerId;
  };

  const createRoom = () => {
    const roomId = UUIDv4();

    if (!rooms[roomId]) {
      rooms[roomId] = createRoomState();
    }

    socket.join(roomId);
    socket.emit("room-created", { roomId });
  };

  const joinedRoom = ({ roomId, peerId }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("room-not-found");
      return;
    }
    if (!peerId) return;

    const previousRoomId = socket.data?.roomId;
    const previousPeerId = socket.data?.peerId;
    if (previousRoomId && previousPeerId && previousRoomId !== roomId) {
      removePeerFromRoom({
        roomId: previousRoomId,
        peerId: previousPeerId,
        socketId: socket.id,
      });
    }

    if (!room.participants.includes(peerId)) {
      room.participants.push(peerId);
    }

    room.peerToSocket[peerId] = socket.id;
    room.socketToPeer[socket.id] = peerId;

    socket.data.roomId = roomId;
    socket.data.peerId = peerId;

    socket.join(roomId);
    socket.emit("get-users", {
      roomId,
      participants: room.participants,
    });
  };

  const ready = () => {
    const { roomId, peerId } = getSocketIdentity();
    if (!roomId || !peerId) return;
    if (!rooms[roomId]) return;

    socket.to(roomId).emit("user-joined", { peerId });
  };

  socket.on("create-room", createRoom);
  socket.on("joined-room", joinedRoom);
  socket.on("ready", ready);
  socket.on("leave-room", leaveCurrentRoom);
  socket.on("disconnect", leaveCurrentRoom);
};

export default roomHandler;
