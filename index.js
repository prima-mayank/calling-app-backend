import dotenv from "dotenv";
import express from "express";
import http from "http";
import cors from "cors";
import { ExpressPeerServer } from "peer";
import ServerConfig from "./config/serverConfig.js";
import { createCorsOptions } from "./server/corsPolicy.js";
import { registerServerLifecycle } from "./server/lifecycle.js";
import { registerHttpRoutes } from "./server/routes.js";
import { createSocketServer } from "./server/socketServer.js";

dotenv.config();

const app = express();

app.use(cors(createCorsOptions()));
app.use(express.json());
registerHttpRoutes(app);

const server = http.createServer(app);
createSocketServer(server);

const peerServer = ExpressPeerServer(server, {
  path: "/myapp",
});
app.use("/peerjs", peerServer);
registerServerLifecycle({ server, port: ServerConfig.PORT });

server.listen(ServerConfig.PORT, "0.0.0.0", () => {
  console.log(`[server] listening on 0.0.0.0:${ServerConfig.PORT}`);
});
