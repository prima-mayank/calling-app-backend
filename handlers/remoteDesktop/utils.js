import { v4 as UUIDv4 } from "uuid";
import { hosts, sessions } from "./state.js";

export const sanitizeString = (value, maxLength = 128) => {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
};

// helper used across remote-desktop handling to produce a human‑friendly label
// for any socket (host or participant).  falls back to hostId when nothing else
// is available.  this mirrors the logic previously embedded in the handler.
export const resolveParticipantLabel = (targetSocket, fallbackId = "") => {
  const displayName = sanitizeString(targetSocket?.data?.authDisplayName, 128);
  if (displayName) return displayName;
  const email = sanitizeString(targetSocket?.data?.authEmail, 128);
  if (email) return email;
  const peerId = sanitizeString(targetSocket?.data?.peerId, 64);
  if (peerId) return peerId;
  return sanitizeString(fallbackId, 64) || "participant";
};

export const buildSuggestedHostId = (peerId) => {
  const normalizedPeerId = sanitizeString(peerId, 64).replace(/[^a-zA-Z0-9_-]/g, "");
  const suffix = normalizedPeerId.slice(0, 20) || UUIDv4().slice(0, 8);
  return `host-${suffix}`;
};

export const getSocketNetworkId = (socket) => {
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

export const isLikelyPrivateOrLocalNetworkId = (networkId) => {
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

export const sanitizeRemoteEvent = (event) => {
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

export const resolveSessionForSocket = (socket, requestedSessionId) => {
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
