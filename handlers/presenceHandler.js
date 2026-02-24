const buildPresencePayload = (presenceStore) => ({
  onlineUserIds: presenceStore.getOnlineUserIds(),
  timestamp: Date.now(),
});

export const createPresenceHandler = ({ io, socket, presenceStore }) => {
  const emitPresenceSnapshot = () => {
    const authUserId = String(socket.data?.authUserId || "").trim();
    if (!authUserId) return;
    socket.emit("presence-snapshot", buildPresencePayload(presenceStore));
  };

  const broadcastPresence = () => {
    io.emit("presence-updated", buildPresencePayload(presenceStore));
  };

  const subscribePresence = () => {
    emitPresenceSnapshot();
  };

  const handleAuthenticatedConnect = () => {
    const authUserId = String(socket.data?.authUserId || "").trim();
    if (!authUserId) return;
    emitPresenceSnapshot();
    broadcastPresence();
  };

  const handleDisconnect = () => {
    const removedUserId = presenceStore.unregisterSocket(socket.id);
    if (!removedUserId) return;
    broadcastPresence();
  };

  socket.on("presence-subscribe", subscribePresence);

  return {
    handleAuthenticatedConnect,
    handleDisconnect,
  };
};
