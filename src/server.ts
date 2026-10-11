import http from "http";
import express from "express";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";
import { config } from "./config";
import { voiceRouter } from "./routes/voice";
import { smsRouter } from "./routes/sms";
import { apiRouter } from "./routes/api";
import { handleMediaStream } from "./routes/mediaStream";

const app = express();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/voice", voiceRouter);
app.use("/sms", smsRouter);
app.use("/api", apiRouter);

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/media-stream" });
wss.on("connection", handleMediaStream);

server.listen(config.PORT, () => {
  console.log(`Voice agent running on port ${config.PORT}`);
});
