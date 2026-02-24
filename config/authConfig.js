const parseBoolean = (value, fallback = false) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  return fallback;
};

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
};

export default {
  AUTH_ENABLED: parseBoolean(process.env.AUTH_ENABLED, false),
  AUTH_JWT_SECRET: String(process.env.AUTH_JWT_SECRET || "").trim(),
  AUTH_JWT_EXPIRES_IN: String(process.env.AUTH_JWT_EXPIRES_IN || "7d").trim() || "7d",
  AUTH_BCRYPT_ROUNDS: parsePositiveInteger(process.env.AUTH_BCRYPT_ROUNDS, 12),
  AUTH_RELAXED_VALIDATION: parseBoolean(process.env.AUTH_RELAXED_VALIDATION, false),
};
