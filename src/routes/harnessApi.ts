import { Router, Request, Response, NextFunction } from "express";
import { getHarnessStore } from "../services/harness/store";
import { getStore } from "../services/gemini/liveSession";
import {
  activateVersion,
  approveImprovement,
  processCall,
  rejectImprovement,
  rollbackImprovement,
} from "../services/harness/pipeline";
import type { ImprovementStatus } from "../services/harness/types";

// Mounted under /api/harness, after the API's CORS + token auth.
export const harnessRouter = Router();

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).then((body) => body !== undefined && res.json(body)).catch((err: Error) => {
    // Domain errors (guardrail, wrong status, unknown id) are the caller's problem, not a 500.
    res.status(/^(no |unknown|improvement is|blocked|.* cannot)/.test(err.message) ? 409 : 500).json({ error: err.message });
    if (!/^(no |unknown|improvement is|blocked|.* cannot)/.test(err.message)) next(err);
  });
};

harnessRouter.get("/state", h(async () => {
  const hs = await getHarnessStore();
  const [active, improvements, grades] = await Promise.all([hs.getActiveConfig(), hs.listImprovements(), hs.listGrades(1000)]);
  const count = (s: ImprovementStatus) => improvements.filter((i) => i.status === s).length;
  return {
    activeConfig: active,
    improvements: { proposed: count("proposed"), applied: count("applied"), rejected: count("rejected"), rolled_back: count("rolled_back") },
    gradedCalls: grades.length,
  };
}));

harnessRouter.get("/versions", h(async () => (await getHarnessStore()).listVersions()));

harnessRouter.get("/grades", h(async (req) => {
  const raw = Number.parseInt(String(req.query.limit ?? "100"), 10);
  return (await getHarnessStore()).listGrades(Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 500) : 100);
}));

harnessRouter.get("/improvements", h(async (req) => {
  const status = req.query.status as ImprovementStatus | undefined;
  return (await getHarnessStore()).listImprovements(status);
}));

harnessRouter.post("/improvements/:id/approve", h((req) => approveImprovement(String(req.params.id))));
harnessRouter.post("/improvements/:id/reject", h((req) => rejectImprovement(String(req.params.id), typeof req.body?.reason === "string" ? req.body.reason : undefined)));
harnessRouter.post("/improvements/:id/rollback", h((req) => rollbackImprovement(String(req.params.id))));
harnessRouter.post("/versions/:id/activate", h((req) => activateVersion(String(req.params.id))));

// Re-run grading for a stored call (useful after swapping the teacher).
harnessRouter.post("/calls/:callSid/regrade", h(async (req) => {
  const call = (await (await getStore()).listCalls(1000)).find((c) => c.callSid === String(req.params.callSid));
  if (!call) throw new Error(`no call ${String(req.params.callSid)}`);
  return processCall(call);
}));
