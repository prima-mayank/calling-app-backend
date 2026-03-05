import cors from "cors";
import express from "express";
import { createCorsOptions } from "./corsPolicy.js";
import { registerHttpRoutes } from "./routes.js";

export const createApp = ({ authRuntime = null, presenceStore = null } = {}) => {
  const app = express();

  app.use(cors(createCorsOptions()));
  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    if (process.env.NODE_ENV !== "test") {
      console.log(`[http] ${req.method} ${req.originalUrl}`);
    }
    next();
  });

  registerHttpRoutes(app, { authRuntime, presenceStore });
  return app;
};
