import fs from "fs";
import ServerConfig from "../config/serverConfig.js";

export const registerHttpRoutes = (app) => {
  app.get("/health", (req, res) => {
    res.send("OK");
  });

  app.get("/downloads/host-app-win.zip", (req, res) => {
    const zipPath = String(ServerConfig.HOST_APP_LOCAL_ZIP_PATH || "").trim();
    if (!zipPath) {
      res.status(404).json({
        error: "local-host-app-unconfigured",
        message: "Local host app zip path is not configured on backend.",
      });
      return;
    }

    if (!fs.existsSync(zipPath)) {
      res.status(404).json({
        error: "local-host-app-missing",
        message: "Configured local host app zip file was not found on backend.",
      });
      return;
    }

    res.download(zipPath, "host-app-win.zip");
  });
};
