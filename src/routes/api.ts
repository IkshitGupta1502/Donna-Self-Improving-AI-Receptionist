import { z } from "zod";
import { Router, Request, Response, NextFunction } from "express";
import { config } from "../config";
import { getStore } from "../services/gemini/liveSession";
import { getActiveCalls } from "../services/calls/recorder";
import { BUILTIN_TOOL_NAMES } from "../services/gemini/tools";
import { stripeConfigured } from "../services/payments/stripe";
import { smsConfigured } from "../services/sms/twilio";
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
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
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
  res.json({ status: "ok", payments: { stripe: stripeConfigured(), sms: smsConfigured() } });
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
  "/appointments",
  wrap(async (_req, res) => {
    res.json(await (await getStore()).listAppointments());
  })
);

apiRouter.get(
  "/customers",
  wrap(async (_req, res) => {
    res.json(await (await getStore()).listCustomers());
  })
);

apiRouter.get(
  "/messages",
  wrap(async (_req, res) => {
    res.json(await (await getStore()).listMessages());
  })
);

apiRouter.get(
  "/tools",
  wrap(async (_req, res) => {
    res.json(await (await getStore()).listToolProposals());
  })
);

for (const [action, status] of [
  ["enable", "enabled"],
  ["disable", "disabled"],
  ["decline", "declined"],
] as const) {
  apiRouter.post(
    `/tools/:name/${action}`,
    wrap(async (req, res) => {
      const name = String(req.params.name);
      if (status === "enabled" && BUILTIN_TOOL_NAMES.has(name)) {
        res.status(400).json({ error: `"${name}" collides with a built-in tool` });
        return;
      }
      const updated = await (await getStore()).setToolStatus(name, status);
      if (!updated) {
        res.status(404).json({ error: "tool not found" });
        return;
      }
      res.json(updated);
    })
  );
}

apiRouter.get(
  "/records",
  wrap(async (req, res) => {
    const raw = Number.parseInt(String(req.query.limit ?? "100"), 10);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 500) : 100;
    const tool = typeof req.query.tool === "string" && req.query.tool ? req.query.tool : undefined;
    res.json(await (await getStore()).listCustomRecords({ tool, limit }));
  })
);

// The teacher writes grades/improvements in its own Mongo shape (snake_case,
// 0-10 scales, config ids like "v3"); these map them to what the dashboard renders.
function versionFromConfigId(id: unknown): number | null {
  const m = typeof id === "string" ? /^v(\d+)$/.exec(id) : null;
  return m ? Number(m[1]) : null;
}

function toFivePoint(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(5, Math.round(v / 2))) : 0;
}

function mapGrade(doc: Record<string, unknown>) {
  const scores = (doc.scores as Record<string, unknown>) || {};
  const overall = Number(doc.overall);
  const frustration = Number(doc.frustration);
  return {
    callSid: (doc.call_id as string) || (doc._id as string),
    configVersion: versionFromConfigId(doc.config_version_id),
    outcome: doc.outcome,
    score: Number.isFinite(overall) ? Math.round(overall * 10) : null,
    frustration: Number.isFinite(frustration) ? frustration / 10 : null,
    dims: {
      accuracy: toFivePoint(scores.accuracy),
      tools: toFivePoint(scores.tool_use),
      completion: toFivePoint(scores.task_completion),
      tone: toFivePoint(scores.tone),
      brevity: toFivePoint(scores.brevity),
    },
    summary: (doc.rationale as string) || "",
    createdAt: doc.created_at,
  };
}

const IMPROVEMENT_TITLE: Record<string, (payload: Record<string, unknown>) => string> = {
  tool: (p) => `New tool: ${(p.tool_name as string) || "unnamed"}`,
  context: (p) => (p.question as string) || "Knowledge gap noticed",
  prompt: (p) =>
    (p.op === "remove" ? "Removed a rule" : p.op === "modify" ? "Changed a rule" : "Added a rule") +
    (p.rule_kind ? ` (${p.rule_kind as string})` : ""),
  schema: () => "Schema change proposed",
};

function mapImprovement(doc: Record<string, unknown>, calls: CallRecord[]) {
  const payload = (doc.payload as Record<string, unknown>) || {};
  const type = String(doc.type || "context");
  const sourceSid = ((doc.source_call_ids as string[]) || [])[0];
  const call = calls.find((c) => c.callSid === sourceSid);
  const evidence = ((doc.evidence_turns as number[]) || [])
    .map((turn) => {
      const msg = call?.transcript?.[turn - 1];
      return msg ? { callSid: sourceSid, quote: msg.text } : null;
    })
    .filter((e): e is { callSid: string; quote: string } => !!e);
  return {
    id: doc._id,
    type,
    status: doc.status === "rejected" ? "dismissed" : (doc.status as string),
    title: (IMPROVEMENT_TITLE[type] || IMPROVEMENT_TITLE.schema)(payload),
    rationale: (doc.reason as string) || (doc.rejected_reason as string) || "",
    change: type === "prompt" ? (payload.text as string) : undefined,
    evidence,
    fromVersion: null,
    toVersion: versionFromConfigId(doc.applied_in_config_id),
    createdAt: doc.created_at,
  };
}

apiRouter.get(
  "/grades",
  wrap(async (_req, res) => {
    const grades = await (await getStore()).listGrades();
    res.json(grades.map(mapGrade));
  })
);

apiRouter.get(
  "/improvements",
  wrap(async (_req, res) => {
    const [improvements, calls] = await Promise.all([(await getStore()).listImprovements(), allCalls(100000)]);
    res.json(improvements.map((d) => mapImprovement(d, calls)));
  })
);

const configSchema = z.object({
  companyName: z.string().trim().min(1).max(80),
  greeting: z.string().trim().min(1).max(300),
  context: z.string().trim().max(8000),
  note: z.string().trim().max(300).optional(),
});
const activateSchema = z.object({ version: z.number().int().positive() });

function badRequest(res: Response, err: z.ZodError): void {
  const msg = err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
  res.status(400).json({ error: msg });
}

apiRouter.get(
  "/config",
  wrap(async (_req, res) => {
    const store = await getStore();
    const [active, versions] = await Promise.all([store.getActiveConfig(), store.listConfigVersions()]);
    res.json({ active, versions });
  })
);

apiRouter.put(
  "/config",
  wrap(async (req, res) => {
    const parsed = configSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, parsed.error);
    const { note, ...rest } = parsed.data;
    const saved = await (await getStore()).saveConfigVersion({
      ...rest,
      author: "manager",
      ...(note ? { note } : {}),
    });
    res.status(201).json(saved);
  })
);

apiRouter.post(
  "/config/activate",
  wrap(async (req, res) => {
    const parsed = activateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, parsed.error);
    const activated = await (await getStore()).activateConfigVersion(parsed.data.version);
    if (!activated) {
      res.status(404).json({ error: "version not found" });
      return;
    }
    res.json(activated);
  })
);

apiRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[api] error:", err);
  res.status(500).json({ error: "internal error" });
});
