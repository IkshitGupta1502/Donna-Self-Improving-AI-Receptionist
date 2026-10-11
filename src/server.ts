import http from "http";
import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";
import { config } from "./config";
import { voiceRouter } from "./routes/voice";
import { apiRouter } from "./routes/api";
import { handleMediaStream } from "./routes/mediaStream";

const app = express();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/voice", voiceRouter);
app.use("/api", apiRouter);

// Last line of defence: a stray error in one call (a database hiccup, a closed socket) is logged, not fatal. Without
// this Node exits, which ends every call and, under `npm run live`, takes ngrok and the teacher down too.
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandled rejection (still running):", reason instanceof Error ? reason.stack ?? reason.message : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[server] uncaught exception (still running):", err.stack ?? err.message);
});

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/media-stream" });
wss.on("connection", handleMediaStream);

server.listen(config.PORT, () => {
  console.log(`Voice agent running on port ${config.PORT}`);
});
