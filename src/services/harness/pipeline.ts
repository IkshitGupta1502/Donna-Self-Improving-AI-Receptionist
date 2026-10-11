import { randomUUID } from "crypto";
import type { CallRecord, DataStore } from "../data/store";
import { getStore } from "../gemini/liveSession";
import { TOOLS } from "../gemini/tools";
import { buildSystemPrompt } from "../gemini/systemPrompt";
import { applyConfigPayload } from "./config";
import { classifyOutcome } from "./outcome";
import { hardViolation, softHold } from "./policy";
import { getHarnessStore, type HarnessStore } from "./store";
import { getTeacher } from "./teacher";
import {
  ProposedImprovementSchema,
  TeacherReportSchema,
  SCORE_DIMENSIONS,
  type AgentConfig,
  type ConfigPayload,
  type DataPayloadT,
  type GradeRecord,
  type Improvement,
} from "./types";

// All config / data mutations go through one queue so version numbers and pointers never race.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

const isConfigPayload = (p: Improvement["payload"]): p is ConfigPayload => p.type === "prompt" || p.type === "context";
const isDataPayload = (p: Improvement["payload"]): p is DataPayloadT => p.type === "data";

const fingerprint = (p: Improvement["payload"]): string => JSON.stringify(p).toLowerCase().replace(/\s+/g, " ");

async function applyDataPayload(ds: DataStore, p: DataPayloadT): Promise<DataPayloadT> {
  if (p.op === "upsert_price") {
    const prev = await ds.getPrice(p.row.item);
    await ds.upsertPrice(p.row);
    return prev ? { type: "data", op: "upsert_price", row: prev } : { type: "data", op: "remove_price", item: p.row.item };
  }
  const prev = await ds.removePrice(p.item);
  if (!prev) throw new Error(`no price row ${p.item}`);
  return { type: "data", op: "upsert_price", row: prev };
}

/** Writes a new immutable config version from `cfg` plus one payload and points the agent at it. */
async function commitConfig(
  hs: HarnessStore,
  payload: ConfigPayload,
  improvementId: string,
  createdBy: AgentConfig["createdBy"],
  note: string
): Promise<{ versionId: string; undo: ConfigPayload }> {
  const cfg = await hs.getActiveConfig();
  const applied = applyConfigPayload(cfg, payload, improvementId);
  const versions = await hs.listVersions();
  const next: AgentConfig = {
    versionId: `v${versions.length + 1}`,
    parentId: cfg.versionId,
    createdAt: new Date().toISOString(),
    createdBy,
    improvementId,
    note,
    rules: applied.rules,
    docs: applied.docs,
  };
  await hs.saveVersion(next);
  await hs.setActive(next.versionId);
  return { versionId: next.versionId, undo: applied.undo };
}

async function applyNow(imp: Improvement, by: "policy" | "human"): Promise<Improvement> {
  const hs = await getHarnessStore();
  const cfg = await hs.getActiveConfig();
  const violation = hardViolation(imp.payload, cfg);
  if (violation) throw new Error(`blocked by guardrail: ${violation}`);

  if (isConfigPayload(imp.payload)) {
    const { versionId, undo } = await commitConfig(hs, imp.payload, imp.id, by === "policy" ? "teacher" : "human", imp.title);
    imp.versionId = versionId;
    imp.undo = undo;
  } else if (isDataPayload(imp.payload)) {
    imp.undo = await applyDataPayload(await getStore(), imp.payload);
  } else {
    throw new Error(`${imp.payload.type} changes cannot be applied automatically`);
  }
  imp.status = "applied";
  imp.decidedBy = by;
  imp.appliedAt = new Date().toISOString();
  imp.reason = undefined;
  await hs.saveImprovement(imp);
  console.log(`[harness] applied ${imp.id} (${imp.payload.type}) by ${by}${imp.versionId ? ` -> ${imp.versionId}` : ""}: ${imp.title}`);
  return imp;
}

async function route(imp: Improvement, hs: HarnessStore): Promise<Improvement> {
  const all = await hs.listImprovements();
  const key = fingerprint(imp.payload);
  const dup = all.find((o) => o.id !== imp.id && (o.status === "applied" || o.status === "proposed") && fingerprint(o.payload) === key);
  if (dup) {
    imp.status = "rejected";
    imp.decidedBy = "policy";
    imp.reason = `duplicate of ${dup.id}`;
    await hs.saveImprovement(imp);
    return imp;
  }

  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const appliedToday = all.filter((o) => o.status === "applied" && o.decidedBy === "policy" && Date.parse(o.appliedAt ?? "") > dayAgo).length;
  const existingPrice = imp.payload.type === "data" && imp.payload.op === "upsert_price" ? await (await getStore()).getPrice(imp.payload.row.item) : null;
  const hold = softHold(imp, { appliedToday, existingPrice }) ?? hardViolation(imp.payload, await hs.getActiveConfig());
  if (hold) {
    imp.reason = hold;
    await hs.saveImprovement(imp);
    return imp;
  }
  try {
    return await applyNow(imp, "policy");
  } catch (err) {
    imp.reason = err instanceof Error ? err.message : String(err);
    await hs.saveImprovement(imp);
    return imp;
  }
}

/** Entry point: called when a call ends. Never throws. */
export async function processCall(call: CallRecord): Promise<GradeRecord | null> {
  try {
    return await serial(() => processCallInner(call));
  } catch (err) {
    console.error(`[harness] processing ${call.callSid} failed:`, err);
    return null;
  }
}

async function processCallInner(call: CallRecord): Promise<GradeRecord> {
  const hs = await getHarnessStore();
  const outcome = classifyOutcome(call);
  const ds = await getStore();
  await ds.saveCall({ ...call, outcome: { label: outcome.label, success: outcome.success } });

  const config = (call.configVersionId && (await hs.getVersion(call.configVersionId))) || (await hs.getActiveConfig());
  const teacher = getTeacher();
  const grade: GradeRecord = {
    callSid: call.callSid,
    gradedAt: new Date().toISOString(),
    startedAt: call.startedAt,
    configVersionId: call.configVersionId,
    outcome,
    mode: outcome.success ? "full" : "failure_analysis",
    teacher: teacher?.name ?? null,
    improvementIds: [],
    dropped: [],
  };

  if (!teacher) {
    await hs.saveGrade(grade);
    return grade;
  }

  try {
    const recent = (await hs.listImprovements()).slice(0, 30);
    const raw = await teacher.grade({
      call,
      outcome,
      mode: grade.mode,
      config,
      basePrompt: buildSystemPrompt("(today)", undefined),
      tools: TOOLS.map((t) => ({ name: t.name ?? "", description: t.description })),
      recentImprovements: recent.map(({ id, title, status, payload }) => ({ id, title, status, payload })),
    });
    const report = TeacherReportSchema.safeParse(raw);
    if (!report.success) {
      grade.error = `invalid teacher report: ${report.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
    } else {
      const r = report.data;
      grade.summary = r.summary;
      grade.scores = r.scores;
      grade.overall = SCORE_DIMENSIONS.reduce((s, d) => s + r.scores[d], 0) / SCORE_DIMENSIONS.length;
      grade.frustration = r.frustration;
      for (const item of r.improvements) {
        const parsed = ProposedImprovementSchema.safeParse(item);
        if (!parsed.success) {
          grade.dropped.push({ reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), raw: item });
          continue;
        }
        const imp: Improvement = {
          id: `imp-${randomUUID().slice(0, 8)}`,
          createdAt: new Date().toISOString(),
          sourceCallSids: [call.callSid],
          status: "proposed",
          ...parsed.data,
        };
        // Harness owns ids: a teacher cannot choose the rule id it creates.
        if (imp.payload.type === "prompt" && imp.payload.op === "add_rule") imp.payload.ruleId = undefined;
        await hs.saveImprovement(imp);
        const routed = await route(imp, hs);
        grade.improvementIds.push(routed.id);
      }
    }
  } catch (err) {
    grade.error = err instanceof Error ? err.message : String(err);
    console.error(`[harness] teacher failed for ${call.callSid}:`, err);
  }
  await hs.saveGrade(grade);
  return grade;
}

// --- Human actions (dashboard) ---------------------------------------------

async function load(id: string): Promise<Improvement> {
  const imp = await (await getHarnessStore()).getImprovement(id);
  if (!imp) throw new Error(`no improvement ${id}`);
  return imp;
}

export function approveImprovement(id: string): Promise<Improvement> {
  return serial(async () => {
    const imp = await load(id);
    if (imp.status !== "proposed") throw new Error(`improvement is ${imp.status}, not proposed`);
    return applyNow(imp, "human");
  });
}

export function rejectImprovement(id: string, reason = "rejected by reviewer"): Promise<Improvement> {
  return serial(async () => {
    const imp = await load(id);
    if (imp.status !== "proposed") throw new Error(`improvement is ${imp.status}, not proposed`);
    imp.status = "rejected";
    imp.decidedBy = "human";
    imp.reason = reason;
    await (await getHarnessStore()).saveImprovement(imp);
    return imp;
  });
}

/** Undo one applied improvement. Config changes become a new "rollback" version; data changes are reverted in place. */
export function rollbackImprovement(id: string): Promise<Improvement> {
  return serial(async () => {
    const hs = await getHarnessStore();
    const imp = await load(id);
    if (imp.status !== "applied" || !imp.undo) throw new Error(`improvement is ${imp.status}, cannot roll back`);
    if (imp.undo.type === "prompt" || imp.undo.type === "context") {
      await commitConfig(hs, imp.undo, imp.id, "rollback", `Rollback of ${imp.id}: ${imp.title}`);
    } else {
      await applyDataPayload(await getStore(), imp.undo);
    }
    imp.status = "rolled_back";
    imp.rolledBackAt = new Date().toISOString();
    await hs.saveImprovement(imp);
    console.log(`[harness] rolled back ${imp.id}`);
    return imp;
  });
}

/** Pointer-only rollback: make an earlier config version active again. */
export function activateVersion(versionId: string): Promise<AgentConfig> {
  return serial(async () => {
    const hs = await getHarnessStore();
    await hs.setActive(versionId);
    return hs.getActiveConfig();
  });
}
