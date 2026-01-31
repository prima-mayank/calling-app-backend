import { v4 as UUIDv4 } from "uuid";

// In-memory room store
// { roomId: [peerId1, peerId2] }
const rooms = {};

const roomHandler = (socket) => {

  const createRoom = () => {
    const roomId = UUIDv4();

    socket.join(roomId);
    rooms[roomId] = [];

    socket.emit("room-created", { roomId });
    // console.log("Room created with id", roomId);
  };

  const joinedRoom = ({ roomId, peerId }) => {
    // console.log("joined room called", rooms, roomId, peerId);

    if (!rooms[roomId]) {
      socket.emit("room-not-found");
      return;
    }

    // console.log("New user joined room", roomId, "peerId:", peerId);

    rooms[roomId].push(peerId);
    socket.join(roomId);

    // notify others when frontend sends ready
    socket.on("ready", () => {
      socket.to(roomId).emit("user-joined", { peerId });
    });

    socket.emit("get-users", {
      roomId,
      participants: rooms[roomId]
    });
  };

  socket.on("create-room", createRoom);
  socket.on("joined-room", joinedRoom);

};

export default roomHandler;
