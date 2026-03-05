import { Router } from "express";
import { summarizeText } from "../llmProvider.js";
import { createSummarizeRateLimiter } from "../rateLimiter.js";

const normalizeTextInput = (value) => {
  if (typeof value !== "string") return "";
  return value.trim();
};

const toSafeResponse = (result = {}) => ({
  summary: typeof result.summary === "string" ? result.summary : "",
  bullets: Array.isArray(result.bullets)
    ? result.bullets.filter((item) => typeof item === "string")
    : [],
  truncated: !!result.truncated,
});

export const createSummarizeRouter = (options = {}) => {
  const router = Router();
  const rateLimiter = createSummarizeRateLimiter(options.rateLimitConfig || {});

  router.post("/summarize", rateLimiter, async (req, res) => {
    const text = normalizeTextInput(req.body?.text);
    if (!text) {
      res.status(400).json({ error: "text required" });
      return;
    }

    try {
      const result = await summarizeText(text);
      res.status(200).json(toSafeResponse(result));
    } catch (error) {
      if (error?.code === "invalid_input") {
        res.status(400).json({ error: "text required" });
        return;
      }

      console.error("[summarize] provider_error");
      res.status(500).json({ error: "server_error" });
    }
  });

  return router;
};
