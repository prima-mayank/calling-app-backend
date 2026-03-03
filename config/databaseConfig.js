import { parseBoolean, parsePositiveInteger } from "./envParsers.js";

export default {
  MONGODB_URI: String(process.env.MONGODB_URI || "").trim(),
  MONGODB_AUTO_INDEX: parseBoolean(process.env.MONGODB_AUTO_INDEX, false),
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: parsePositiveInteger(
    process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
    5000
  ),
  MONGODB_MAX_POOL_SIZE: parsePositiveInteger(process.env.MONGODB_MAX_POOL_SIZE, 10),
};
