import mongoose from "mongoose";
import DatabaseConfig from "../config/databaseConfig.js";

let cachedState = {
  connected: false,
  reason: "not-initialized",
};

export const getDatabaseState = () => ({
  ...cachedState,
});

export const connectDatabase = async () => {
  const mongoUri = DatabaseConfig.MONGODB_URI;
  if (!mongoUri) {
    cachedState = {
      connected: false,
      reason: "missing-uri",
    };
    console.log("[db] MONGODB_URI not set. Continuing without database connection.");
    return getDatabaseState();
  }

  try {
    await mongoose.connect(mongoUri, {
      autoIndex: DatabaseConfig.MONGODB_AUTO_INDEX,
      serverSelectionTimeoutMS: DatabaseConfig.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
      maxPoolSize: DatabaseConfig.MONGODB_MAX_POOL_SIZE,
    });

    cachedState = {
      connected: true,
      reason: "connected",
    };
    console.log("[db] connected");
    return getDatabaseState();
  } catch (error) {
    cachedState = {
      connected: false,
      reason: "connect-failed",
    };
    console.error("[db] connection failed:", error?.message || error);
    return getDatabaseState();
  }
};
