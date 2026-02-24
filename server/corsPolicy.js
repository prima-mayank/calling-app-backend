import ServerConfig from "../config/serverConfig.js";

const normalizeOrigin = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    parsed.search = "";
    return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, "");
  } catch {
    return raw.replace(/\/+$/, "");
  }
};

const normalizedAllowedOrigins = new Set(
  ServerConfig.ALLOWED_ORIGINS.map((origin) => normalizeOrigin(origin)).filter(Boolean)
);

export const isOriginAllowed = (origin) => {
  if (!origin) return true;
  if (ServerConfig.ALLOWED_ORIGINS.includes("*")) return true;
  const normalizedOrigin = normalizeOrigin(origin);
  return (
    normalizedAllowedOrigins.has(normalizedOrigin) ||
    normalizedAllowedOrigins.has(String(origin || "").trim())
  );
};

export const createCorsOptions = () => ({
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("CORS origin blocked"));
  },
  methods: ["GET", "POST"],
});
