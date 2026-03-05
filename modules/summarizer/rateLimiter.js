const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 30;
const FORWARDED_HEADER = "x-forwarded-for";

const normalizeIp = (req) => {
  if (!req || typeof req !== "object") return "unknown";

  const forwarded = String(req.headers?.[FORWARDED_HEADER] || "")
    .split(",")[0]
    .trim();
  if (forwarded) return forwarded;

  const direct = String(req.ip || req.socket?.remoteAddress || "").trim();
  return direct || "unknown";
};

export const createSummarizeRateLimiter = (config = {}) => {
  const windowMs = Number(config.windowMs) > 0 ? Number(config.windowMs) : DEFAULT_WINDOW_MS;
  const maxRequests =
    Number(config.maxRequests) > 0 ? Number(config.maxRequests) : DEFAULT_MAX_REQUESTS;
  const buckets = new Map();

  const cleanupExpiredBuckets = (now) => {
    for (const [key, bucket] of buckets.entries()) {
      if (!bucket || now >= Number(bucket.resetAt || 0)) {
        buckets.delete(key);
      }
    }
  };

  return (req, res, next) => {
    const now = Date.now();
    cleanupExpiredBuckets(now);

    const ip = normalizeIp(req);
    const existingBucket = buckets.get(ip);
    const resetAt =
      existingBucket && now < existingBucket.resetAt ? existingBucket.resetAt : now + windowMs;
    const count =
      existingBucket && now < existingBucket.resetAt ? existingBucket.count + 1 : 1;

    buckets.set(ip, { count, resetAt });

    if (count > maxRequests) {
      const retryAfterSeconds = Math.ceil((resetAt - now) / 1000);
      res.set("Retry-After", String(Math.max(1, retryAfterSeconds)));
      res.status(429).json({ error: "rate_limited" });
      return;
    }

    next();
  };
};
