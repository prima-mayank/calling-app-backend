export const registerServerLifecycle = ({ server, port }) => {
  let shutdownStarted = false;

  const shutdown = (reason, exitCode) => {
    if (shutdownStarted) return;
    shutdownStarted = true;

    const normalizedReason = String(reason || "shutdown").trim() || "shutdown";
    console.log(`[server] shutting down (${normalizedReason})`);

    const forceTimer = setTimeout(() => {
      console.error("[server] forced shutdown after timeout");
      process.exit(exitCode);
    }, 8_000);

    try {
      server.close((err) => {
        clearTimeout(forceTimer);
        if (err) {
          console.error("[server] shutdown close error:", err);
          process.exit(1);
          return;
        }
        process.exit(exitCode);
      });
    } catch (err) {
      clearTimeout(forceTimer);
      console.error("[server] shutdown failed:", err);
      process.exit(1);
    }
  };

  server.on("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Stop the existing process and retry.`);
      process.exit(1);
      return;
    }
    console.error("Server startup error:", err);
    process.exit(1);
  });

  process.on("uncaughtException", (err) => {
    console.error("Uncaught Exception:", err);
    shutdown("uncaughtException", 1);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled Rejection:", reason);
    shutdown("unhandledRejection", 1);
  });

  process.on("SIGINT", () => {
    shutdown("SIGINT", 0);
  });

  process.on("SIGTERM", () => {
    shutdown("SIGTERM", 0);
  });

  return { shutdown };
};
