import { Router } from "express";
import { AuthServiceError } from "../AuthServiceError.js";
import { requireAuth } from "../middleware/requireAuth.js";

const parseBody = (body = {}) => ({
  email: String(body.email || "").trim(),
  password: String(body.password || ""),
  displayName: String(body.displayName || "").trim(),
});

const respondAuthUnavailable = (res, authRuntime) => {
  res.status(503).json({
    error: "auth-unavailable",
    message: "Authentication is not enabled on this server.",
    reason: authRuntime?.disableReason || "auth-disabled",
  });
};

const handleAuthError = (res, error) => {
  if (error instanceof AuthServiceError) {
    res.status(error.status).json({
      error: error.code,
      message: error.message,
    });
    return;
  }

  console.error("[auth] unexpected error:", error);
  res.status(500).json({
    error: "internal-error",
    message: "Unexpected server error.",
  });
};

export const createAuthRouter = (authRuntime) => {
  const router = Router();

  router.get("/status", (req, res) => {
    res.json({
      enabled: !!authRuntime?.enabled,
      reason: authRuntime?.enabled ? "ready" : authRuntime?.disableReason || "auth-disabled",
    });
  });

  router.post("/signup", async (req, res) => {
    if (!authRuntime?.enabled) {
      respondAuthUnavailable(res, authRuntime);
      return;
    }

    try {
      const payload = parseBody(req.body);
      const result = await authRuntime.signup(payload);
      res.status(201).json(result);
    } catch (error) {
      handleAuthError(res, error);
    }
  });

  router.post("/login", async (req, res) => {
    if (!authRuntime?.enabled) {
      respondAuthUnavailable(res, authRuntime);
      return;
    }

    try {
      const payload = parseBody(req.body);
      const result = await authRuntime.login(payload);
      res.status(200).json(result);
    } catch (error) {
      handleAuthError(res, error);
    }
  });

  router.get("/me", requireAuth(authRuntime), async (req, res) => {
    try {
      const user = await authRuntime.getUserById(req.auth.userId);
      if (!user) {
        res.status(404).json({
          error: "user-not-found",
          message: "User no longer exists.",
        });
        return;
      }

      res.json({ user });
    } catch (error) {
      handleAuthError(res, error);
    }
  });

  return router;
};
