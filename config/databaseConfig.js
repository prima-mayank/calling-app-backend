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
  MONGODB_URI: String(process.env.MONGODB_URI || "").trim(),
  MONGODB_AUTO_INDEX: parseBoolean(process.env.MONGODB_AUTO_INDEX, false),
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: parsePositiveInteger(
    process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
    5000
  ),
  MONGODB_MAX_POOL_SIZE: parsePositiveInteger(process.env.MONGODB_MAX_POOL_SIZE, 10),
};
