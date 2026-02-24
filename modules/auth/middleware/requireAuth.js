import { verifyAccessToken } from "../utils/tokenUtils.js";

const readBearerToken = (authorizationHeader) => {
  const raw = String(authorizationHeader || "").trim();
  if (!raw) return "";
  const [scheme, token] = raw.split(/\s+/, 2);
  if (!scheme || !token) return "";
  if (scheme.toLowerCase() !== "bearer") return "";
  return token;
};

export const requireAuth = (authRuntime) => (req, res, next) => {
  if (!authRuntime?.enabled) {
    res.status(503).json({
      error: "auth-unavailable",
      message: "Authentication is not enabled on this server.",
      reason: authRuntime?.disableReason || "auth-disabled",
    });
    return;
  }

  const token = readBearerToken(req.headers?.authorization);
  if (!token) {
    res.status(401).json({
      error: "unauthorized",
      message: "Missing bearer token.",
    });
    return;
  }

  try {
    const decoded = verifyAccessToken({
      token,
      secret: authRuntime.jwtSecret,
    });
    req.auth = {
      userId: String(decoded?.sub || "").trim(),
      email: String(decoded?.email || "").trim().toLowerCase(),
    };
    next();
  } catch {
    res.status(401).json({
      error: "unauthorized",
      message: "Invalid or expired token.",
    });
  }
};
