import { verifyAccessToken } from "../modules/auth/utils/tokenUtils.js";

const normalizeToken = (value) => String(value || "").trim();

export const resolveSocketAuthenticatedUser = ({ socket, authRuntime }) => {
  if (!authRuntime?.enabled || !authRuntime?.jwtSecret) {
    return { userId: "", email: "" };
  }

  const accessToken = normalizeToken(socket.handshake?.auth?.accessToken);
  if (!accessToken) {
    return { userId: "", email: "" };
  }

  try {
    const decoded = verifyAccessToken({
      token: accessToken,
      secret: authRuntime.jwtSecret,
    });
    return {
      userId: String(decoded?.sub || "").trim(),
      email: String(decoded?.email || "").trim().toLowerCase(),
    };
  } catch {
    return { userId: "", email: "" };
  }
};
