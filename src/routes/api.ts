import { z } from "zod";
import { Router, Request, Response, NextFunction } from "express";
import { config } from "../config";
import { getStore } from "../services/gemini/liveSession";
import { getActiveCalls } from "../services/calls/recorder";
import { BUILTIN_TOOL_NAMES } from "../services/gemini/tools";
import type { CallRecord } from "../services/data/store";
import { toUiGrade, toUiImprovement, type UiContext } from "./uiShape";

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
  res.json({ status: "ok" });
});

apiRouter.get(
  "/stats",
  wrap(async (_req, res) => {
    const store = await getStore();
    const [calls, orders, messages, activePlaybook] = await Promise.all([
      allCalls(100000),
      store.listOrders(),
      store.listMessages(),
      store.listPlaybook().then((l) => l.filter((e) => e.status === "active").length),
    ]);
    res.json({
      calls: calls.length,
      activeCalls: calls.filter((c) => c.status === "active").length,
      orders: orders.length,
      openOrders: orders.filter((o) => !CLOSED_STAGES.has(o.stage.trim().toLowerCase())).length,
      messages: messages.length,
      playbook: activePlaybook,
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

const customerSchema = z.object({
  name: z.string().trim().max(80).optional(),
  email: z.string().trim().max(120).optional(),
  preferences: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(1000).optional(),
  vip: z.boolean().optional(),
});

// Owner edit. An empty string clears a field.
apiRouter.put(
  "/customers/:phone",
  wrap(async (req, res) => {
    const parsed = customerSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, parsed.error);
    const saved = await (await getStore()).editCustomer(String(req.params.phone), parsed.data);
    if (!saved) {
      res.status(404).json({ error: "customer not found" });
      return;
    }
    res.json(saved);
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

const playbookSchema = z.object({
  title: z.string().trim().min(1).max(80),
  when: z.string().trim().min(1).max(200),
  handling: z.string().trim().min(1).max(300),
});

apiRouter.get(
  "/playbook",
  wrap(async (_req, res) => {
    res.json(await (await getStore()).listPlaybook());
  })
);

apiRouter.post(
  "/playbook",
  wrap(async (req, res) => {
    const parsed = playbookSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, parsed.error);
    res.status(201).json(await (await getStore()).addOwnerPlaybookEntry(parsed.data));
  })
);

for (const [action, status] of [
  ["enable", "active"],
  ["disable", "disabled"],
] as const) {
  apiRouter.post(
    `/playbook/:id/${action}`,
    wrap(async (req, res) => {
      const updated = await (await getStore()).setPlaybookStatus(String(req.params.id), status);
      if (!updated) {
        res.status(404).json({ error: "playbook entry not found" });
        return;
      }
      res.json(updated);
    })
  );
}

apiRouter.post(
  "/playbook/:id/delete",
  wrap(async (req, res) => {
    const ok = await (await getStore()).deletePlaybookEntry(String(req.params.id));
    if (!ok) {
      res.status(404).json({ error: "playbook entry not found" });
      return;
    }
    res.json({ ok: true });
  })
);

apiRouter.get(
  "/records",
  wrap(async (req, res) => {
    const raw = Number.parseInt(String(req.query.limit ?? "100"), 10);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 500) : 100;
    const tool = typeof req.query.tool === "string" && req.query.tool ? req.query.tool : undefined;
    res.json(await (await getStore()).listCustomRecords({ tool, limit }));
  })
);

apiRouter.get(
  "/grades",
  wrap(async (req, res) => {
    const store = await getStore();
    const grades = await store.listGrades();
    if (req.query.shape === "ui") {
      const ctx = await uiContext(store);
      res.json(grades.map((g) => toUiGrade(g as Record<string, unknown>, ctx)));
      return;
    }
    res.json(grades);
  })
);

apiRouter.get(
  "/improvements",
  wrap(async (req, res) => {
    const store = await getStore();
    const improvements = await store.listImprovements();
    res.json(req.query.shape === "ui" ? await uiImprovements(store, improvements) : improvements);
  })
);

// The Donna dashboard (web/donna) approves or dismisses a change with { action }.
apiRouter.post(
  "/improvements/:id",
  wrap(async (req, res) => {
    const store = await getStore();
    const id = String(req.params.id);
    const action = String(req.body?.action ?? "");
    const all = await store.listImprovements();
    const imp = all.find((i) => String((i as Record<string, unknown>)._id) === id) as Record<string, any> | undefined;
    if (!imp) {
      res.status(404).json({ error: "improvement not found" });
      return;
    }
    const payload = imp.payload ?? {};
    if (action === "rolled_back") {
      // The dashboard re-activates the previous version itself; nothing else to change here
    } else if (action === "approve" || action === "dismiss") {
      const on = action === "approve";
      if (imp.type === "tool" && payload.tool_name) {
        const t = await store.setToolStatus(payload.tool_name, on ? "enabled" : "declined");
        if (!t) {
          res.status(404).json({ error: "tool not found" });
          return;
        }
      } else if (payload.playbook_id) {
        const e = await store.setPlaybookStatus(payload.playbook_id, on ? "active" : "disabled");
        if (!e) {
          res.status(404).json({ error: "playbook entry not found" });
          return;
        }
      } else if (imp.type === "context") {
        res.status(400).json({ error: "This is a question for you. Answer it on the Ops page (the Improvements tab) so the answer is saved." });
        return;
      } else {
        res.status(400).json({ error: "This change was already applied by the teacher. To undo it, restore the previous Knowledge version." });
        return;
      }
    } else {
      res.status(400).json({ error: "action must be approve, dismiss or rolled_back" });
      return;
    }
    const fresh = (await store.listImprovements()).find((i) => String((i as Record<string, unknown>)._id) === id);
    res.json((await uiImprovements(store, [fresh as Record<string, unknown>]))[0]);
  })
);

const answerSchema = z.object({ answer: z.string().trim().min(1).max(600) });

apiRouter.post(
  "/improvements/:id/answer",
  wrap(async (req, res) => {
    const parsed = answerSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, parsed.error);
    const id = String(req.params.id);
    const store = await getStore();
    const result = await store.answerImprovement(id, parsed.data.answer);
    if (!result.ok) {
      const missing = /not found/i.test(result.error);
      res.status(missing || result.error === "needs MongoDB" ? 404 : 400).json({ error: result.error });
      return;
    }
    res.json(result);
  })
);

const configSchema = z.object({
  companyName: z.string().trim().min(1).max(80),
  greeting: z.string().trim().min(1).max(300),
  context: z.string().trim().max(8000),
  note: z.string().trim().max(300).optional(),
});
const activateSchema = z.object({ version: z.number().int().positive() });

async function uiContext(store: Awaited<ReturnType<typeof getStore>>): Promise<UiContext> {
  const [calls, versions, tools, playbook] = await Promise.all([
    store.listCalls(500),
    store.listConfigVersions(),
    store.listToolProposals(),
    store.listPlaybook(),
  ]);
  return {
    calls: new Map(calls.map((c) => [c.callSid, c])),
    versions,
    tools: new Map(tools.map((t) => [t.name, t])),
    playbook: new Map(playbook.map((e) => [e.id, e])),
  };
}

async function uiImprovements(store: Awaited<ReturnType<typeof getStore>>, rows: unknown[]) {
  const ctx = await uiContext(store);
  return rows.map((r) => toUiImprovement(r as Record<string, unknown>, ctx));
}

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
