import { Router } from "express";
import User from "../../auth/models/User.js";
import { requireAuth } from "../../auth/middleware/requireAuth.js";

const toPublicDirectoryUser = (item, presenceStore) => {
  const id = String(item?._id || "").trim();
  return {
    id,
    email: String(item?.email || "").trim().toLowerCase(),
    displayName: String(item?.displayName || "").trim(),
    online: presenceStore.isUserOnline(id),
  };
};

export const createUserRouter = ({ authRuntime, presenceStore }) => {
  const router = Router();

  router.get("/directory", requireAuth(authRuntime), async (req, res) => {
    const requesterUserId = String(req.auth?.userId || "").trim();
    if (!requesterUserId) {
      res.status(401).json({
        error: "unauthorized",
        message: "Unauthorized request.",
      });
      return;
    }

    try {
      const users = await User.find({ _id: { $ne: requesterUserId } })
        .select("_id email displayName")
        .sort({ displayName: 1, email: 1 })
        .lean();

      res.json({
        users: users.map((item) => toPublicDirectoryUser(item, presenceStore)),
      });
    } catch (error) {
      console.error("[users] directory fetch failed:", error);
      res.status(500).json({
        error: "internal-error",
        message: "Failed to fetch users.",
      });
    }
  });

  return router;
};
