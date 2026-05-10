import express from "express";
import { config } from "./config.js";

const app = express();

app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ service: "home-systems", status: "ok" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime_s: Math.round(process.uptime()) });
});

app.listen(config.PORT, () => {
  console.log(`home-systems listening on :${config.PORT} (${config.NODE_ENV})`);
});
