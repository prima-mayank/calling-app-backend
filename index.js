import dotenv from "dotenv";
import http from "http";
import { ExpressPeerServer } from "peer";
import ServerConfig from "./config/serverConfig.js";
import { registerServerLifecycle } from "./server/lifecycle.js";
import { createSocketServer } from "./server/socketServer.js";
import { connectDatabase, getDatabaseState } from "./database/connectDatabase.js";
import { createAuthRuntime } from "./modules/auth/runtime/createAuthRuntime.js";
import { createAuthPresenceStore } from "./realtime/authPresenceStore.js";
import { createApp } from "./server/createApp.js";

dotenv.config();

const startServer = async () => {
  await connectDatabase();
  const presenceStore = createAuthPresenceStore();
  const authRuntime = createAuthRuntime({
    dbState: getDatabaseState(),
  });
  const app = createApp({ authRuntime, presenceStore });

  const server = http.createServer(app);
  createSocketServer(server, { authRuntime, presenceStore });

  const peerServer = ExpressPeerServer(server, {
    path: "/myapp",
  });
  app.use("/peerjs", peerServer);
  registerServerLifecycle({ server, port: ServerConfig.PORT });

  server.listen(ServerConfig.PORT, "0.0.0.0", () => {
    const authStatus = authRuntime.enabled
      ? "enabled"
      : `disabled (${authRuntime.disableReason || "unknown"})`;
    console.log(`[server] listening on 0.0.0.0:${ServerConfig.PORT}`);
    console.log(`[auth] ${authStatus}`);
  });
};

void startServer();
