import { Router, Request, Response, NextFunction } from "express";
import { config } from "../config";
import { getStore } from "../services/gemini/liveSession";
import { getActiveCalls } from "../services/calls/recorder";
import type { CallRecord } from "../services/data/store";

export const apiRouter = Router();

const CLOSED_STAGES = new Set(["picked up", "complete", "completed", "delivered"]);
const allowedOrigins = (config.ALLOWED_ORIGINS ?? "*")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (allowedOrigins.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-dashboard-token, ngrok-skip-browser-warning");
  res.setHeader("Access-Control-Max-Age", "600");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

function auth(req: Request, res: Response, next: NextFunction): void {
  const token = config.DASHBOARD_TOKEN;
  if (!token || req.method === "OPTIONS" || req.path === "/health") {
    next();
    return;
  }
  if (req.headers["x-dashboard-token"] !== token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

apiRouter.use(cors, auth);

// Stored calls overlaid with the live in-memory copy of active calls
async function allCalls(limit: number): Promise<CallRecord[]> {
  const store = await getStore();
  const stored = await store.listCalls(limit);
  const live = new Map(getActiveCalls().map((c) => [c.callSid, c]));
  const merged = stored.map((c) => live.get(c.callSid) ?? c);
  for (const [sid, c] of live) if (!stored.some((s) => s.callSid === sid)) merged.push(c);
  return merged.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
}

function wrap(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

apiRouter.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

apiRouter.get(
  "/stats",
  wrap(async (_req, res) => {
    const store = await getStore();
    const [calls, orders, messages] = await Promise.all([
      allCalls(100000),
      store.listOrders(),
      store.listMessages(),
    ]);
    res.json({
      calls: calls.length,
      activeCalls: calls.filter((c) => c.status === "active").length,
      orders: orders.length,
      openOrders: orders.filter((o) => !CLOSED_STAGES.has(o.stage.trim().toLowerCase())).length,
      messages: messages.length,
    });
  })
);

apiRouter.get(
  "/calls",
  wrap(async (req, res) => {
    const raw = Number.parseInt(String(req.query.limit ?? "50"), 10);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 500) : 50;
    res.json(await allCalls(limit));
  })
);

apiRouter.get(
  "/calls/:callSid",
  wrap(async (req, res) => {
    const call = (await allCalls(100000)).find((c) => c.callSid === req.params.callSid);
    if (!call) {
      res.status(404).json({ error: "call not found" });
      return;
    }
    res.json(call);
  })
);

apiRouter.get(
  "/orders",
  wrap(async (_req, res) => {
    res.json(await (await getStore()).listOrders());
  })
);

apiRouter.get(
  "/messages",
  wrap(async (_req, res) => {
    res.json(await (await getStore()).listMessages());
  })
);

apiRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[api] error:", err);
  res.status(500).json({ error: "internal error" });
});
