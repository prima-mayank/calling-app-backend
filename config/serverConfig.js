import dotenv from "dotenv";

dotenv.config();

const parsedPort = Number(process.env.PORT);

const parseAllowedOrigins = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return ["http://localhost:5173", "http://127.0.0.1:5173"];
  }

  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return origins.length > 0 ? origins : ["http://localhost:5173", "http://127.0.0.1:5173"];
};

export default {
  PORT: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 5000,
  ALLOWED_ORIGINS: parseAllowedOrigins(process.env.CORS_ORIGINS),
  REMOTE_CONTROL_TOKEN: String(process.env.REMOTE_CONTROL_TOKEN || "").trim(),
};
