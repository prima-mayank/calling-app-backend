const createEmptySet = () => new Set();

export const createAuthPresenceStore = () => {
  const userToSockets = new Map();
  const socketToUser = new Map();

  const normalizeUserId = (value) => String(value || "").trim();
  const normalizeSocketId = (value) => String(value || "").trim();

  const register = ({ userId, socketId }) => {
    const normalizedUserId = normalizeUserId(userId);
    const normalizedSocketId = normalizeSocketId(socketId);
    if (!normalizedUserId || !normalizedSocketId) return false;

    const existingUserId = socketToUser.get(normalizedSocketId);
    if (existingUserId && existingUserId !== normalizedUserId) {
      const existingSockets = userToSockets.get(existingUserId);
      if (existingSockets) {
        existingSockets.delete(normalizedSocketId);
        if (existingSockets.size === 0) {
          userToSockets.delete(existingUserId);
        }
      }
    }

    const socketIds = userToSockets.get(normalizedUserId) || createEmptySet();
    socketIds.add(normalizedSocketId);
    userToSockets.set(normalizedUserId, socketIds);
    socketToUser.set(normalizedSocketId, normalizedUserId);
    return true;
  };

  const unregisterSocket = (socketId) => {
    const normalizedSocketId = normalizeSocketId(socketId);
    if (!normalizedSocketId) return "";

    const userId = socketToUser.get(normalizedSocketId);
    if (!userId) return "";

    socketToUser.delete(normalizedSocketId);
    const socketIds = userToSockets.get(userId);
    if (socketIds) {
      socketIds.delete(normalizedSocketId);
      if (socketIds.size === 0) {
        userToSockets.delete(userId);
      } else {
        userToSockets.set(userId, socketIds);
      }
    }
    return userId;
  };

  const getSocketIdsForUser = (userId) => {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) return [];
    const socketIds = userToSockets.get(normalizedUserId);
    if (!socketIds) return [];
    return Array.from(socketIds);
  };

  const isUserOnline = (userId) => getSocketIdsForUser(userId).length > 0;

  const getOnlineUserIds = () => Array.from(userToSockets.keys());

  const getUserIdForSocket = (socketId) => {
    const normalizedSocketId = normalizeSocketId(socketId);
    if (!normalizedSocketId) return "";
    return socketToUser.get(normalizedSocketId) || "";
  };

  return {
    register,
    unregisterSocket,
    getSocketIdsForUser,
    getOnlineUserIds,
    isUserOnline,
    getUserIdForSocket,
  };
};
