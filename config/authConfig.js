import { parseBoolean, parsePositiveInteger } from "./envParsers.js";

export default {
  AUTH_ENABLED: parseBoolean(process.env.AUTH_ENABLED, false),
  AUTH_JWT_SECRET: String(process.env.AUTH_JWT_SECRET || "").trim(),
  AUTH_JWT_EXPIRES_IN: String(process.env.AUTH_JWT_EXPIRES_IN || "7d").trim() || "7d",
  AUTH_BCRYPT_ROUNDS: parsePositiveInteger(process.env.AUTH_BCRYPT_ROUNDS, 12),
  AUTH_RELAXED_VALIDATION: parseBoolean(process.env.AUTH_RELAXED_VALIDATION, false),
};
