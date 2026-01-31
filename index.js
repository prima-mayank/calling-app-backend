import express from "express";
import ServerConfig from "./config/serverConfig.js";
import { Server } from "socket.io";
import http from "http";
import cors from "cors";
import roomHandler from  "./handlers/roomHandler.js"


const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (req,res)=>{
  res.send("OK");
});

const server = http.createServer(app);

const io = new Server(server, {
  path: "/socket.io",
  cors: {
    origin: "*",
    methods: ["GET","POST"]
  }
});

io.on("connection", (socket) => {
  console.log("New user connected:", socket.id);

  roomHandler(socket);

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

process.on("uncaughtException", err => {
  console.error("Uncaught:", err);
});

server.listen(ServerConfig.PORT, () => {
  console.log(`Server running on ${ServerConfig.PORT}`);
});
