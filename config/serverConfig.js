import dotenv from "dotenv";

dotenv.config();

const parsedPort = Number(process.env.PORT);

export default {
  PORT: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 5000,
};
