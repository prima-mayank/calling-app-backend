import dotenv from "dotenv";

dotenv.config();

const DEFAULT_PORT = 5000;
const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

const parsePort = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return DEFAULT_PORT;
  }
  return parsed;
};

const normalizeOriginConfigValue = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw === "*") return "*";

  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    parsed.search = "";
    return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, "");
  } catch {
    return raw.replace(/\/+$/, "");
  }
};

const parseAllowedOrigins = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return [...DEFAULT_ALLOWED_ORIGINS];
  }

  const origins = value
    .split(",")
    .map((origin) => normalizeOriginConfigValue(origin))
    .filter(Boolean);

  if (origins.length === 0) {
    return [...DEFAULT_ALLOWED_ORIGINS];
  }

  return [...new Set(origins)];
};

export default {
  PORT: parsePort(process.env.PORT),
  ALLOWED_ORIGINS: parseAllowedOrigins(process.env.CORS_ORIGINS),
  REMOTE_CONTROL_TOKEN: String(process.env.REMOTE_CONTROL_TOKEN || "").trim(),
  HOST_APP_LOCAL_ZIP_PATH: String(process.env.HOST_APP_LOCAL_ZIP_PATH || "").trim(),
};
