import { fromConfig, renderContext, toCall, versionOf } from "../mongo/bridge.js";
import { cols, getActiveConfig, getConfig } from "../mongo/client.js";
import type { BridgeCall, CallDoc, ConfigVersionDoc, GradeDoc, ImprovementDoc, PlaybookDoc, PlaybookEntry, ToolProposal, ToolProposalDoc } from "../mongo/types.js";
import { geminiJudge, teacherModel, type Judge } from "./judge.js";
import { callerProfileText } from "./profile.js";
import {
  buildPlan, decidePlaybookStatus, decideToolStatus, describeRecipe, LIMITS, mergePlaybookEntry, mergeToolProposal, ownerAnswerLine,
  playbookImprovement, regression, validatePlaybookEntry, verifyToolRecipe, type PlaybookDecision, type ToolDecision,
} from "./plan.js";

export interface TeachResult {
  grade: GradeDoc;
  improvements: ImprovementDoc[];
  newConfig: ConfigVersionDoc | null;
  alreadyGraded: boolean;
  rolledBack: { from: string; to: string; reason: string } | null; // automatic rollback, if one fired
  // Accepted tool proposal (as stored) and what happened to it. null when the call showed no capability gap or it was rejected.
  toolProposal: { proposal: ToolProposal; action: ToolDecision["action"]; status: ToolProposal["status"]; promoted: boolean; threshold: number } | null;
  // Accepted playbook entry (as stored after the write) and what happened. null when the call had none or it was rejected (see improvements).
  playbook: { entry: PlaybookEntry; action: PlaybookDecision["action"]; threshold: number } | null;
}

/**
 * Builds a new config version with the next free number and inserts it in the bridge's shape.
 * The manager can save a version from the dashboard at the same moment, so a taken number is retried.
 * Version numbers never repeat, even after a rollback leaves an older version active.
 */
async function insertVersion<T>(build: (version: number) => T, configOf: (built: T) => ConfigVersionDoc | null): Promise<T> {
  const c = await cols();
  for (let attempt = 0; ; attempt++) {
    const last = await c.configVersions.find().sort({ version: -1 }).limit(1).next();
    const built = build((last?.version ?? 0) + 1);
    const cfg = configOf(built);
    if (!cfg) return built;
    try {
      await c.configVersions.insertOne(fromConfig(cfg));
      return built;
    } catch (e) {
      if ((e as { code?: number }).code !== 11000 || attempt >= 4) throw e;
    }
  }
}

/**
 * THE integration point: `teach(callSid)` once the bridge has saved the finished call.
 * Safe to call twice: a graded call is not graded again.
 */
export async function teach(callId: string, judge: Judge = geminiJudge): Promise<TeachResult> {
  const c = await cols();
  const rec = await c.calls.findOne({ callSid: callId });
  if (!rec) throw new Error(`call ${callId} not found`);
  if (rec.status !== "completed") throw new Error(`call ${callId} has not ended yet`);
  const call = toCall(rec);

  const existing = await c.grades.findOne({ _id: callId });
  if (existing) {
    const improvements = await c.improvements.find({ source_call_ids: callId }).toArray();
    return { grade: existing, improvements, newConfig: null, alreadyGraded: true, rolledBack: null, toolProposal: null, playbook: null };
  }

  // Changes are always built on the ACTIVE config, so two calls never overwrite each other's rules.
  const cfg = await getActiveConfig();
  // Judge the call against the config it actually ran with (the active one may be newer, or even renamed), and show
  // the judge the caller profile the receptionist was given, otherwise correct behaviour looks like an error.
  const ranWith = rec.configVersion != null ? await getConfig(rec.configVersion) : null;
  const profile = await callerProfileText(c, rec.from);
  const out = await judge(call, ranWith ?? cfg, { profile });
  const now = new Date();
  // Owner questions already open or answered (a repeat is rejected), and the async self-check of a proposed recipe.
  const existingQuestions = (await c.improvements.find({ type: "context", status: { $in: ["proposed", "applied"] } }).toArray())
    .map((i) => i.payload.question ?? "").filter(Boolean);
  const recipeCheck = out.tool_proposal ? await verifyToolRecipe(out.tool_proposal) : undefined;
  const extra = { existingQuestions, recipeCheck };
  const { grade } = buildPlan(out, call, cfg, teacherModel(), now, undefined, extra);
  await c.grades.insertOne(grade);

  // If the active version has regressed, go back to its parent first and build this call's
  // changes on the parent instead, so the rolled-back rules are not carried forward.
  const rolledBack = call.config_version_id === cfg._id ? await autoRollback(cfg) : null;
  const base = rolledBack?.parent ?? cfg;

  const plan = await insertVersion(
    (version) => buildPlan(out, call, base, teacherModel(), now, version, extra), (p) => p.nextConfig);
  const toolProposal = plan.toolProposal ? await saveToolProposal(plan.toolProposal, grade.overall, plan.improvements) : null;
  const playbook = out.playbook_entry ? await savePlaybookEntry(out.playbook_entry, call, base, grade.overall, plan.improvements, now) : null;
  if (plan.improvements.length) await c.improvements.insertMany(plan.improvements);
  if (plan.nextConfig) await setActive(plan.nextConfig.version);
  return {
    grade, improvements: plan.improvements, newConfig: plan.nextConfig, alreadyGraded: false, toolProposal, playbook,
    rolledBack: rolledBack && { from: rolledBack.from, to: rolledBack.to, reason: rolledBack.reason },
  };
}

/**
 * Writes an accepted tool proposal to `tool_proposals` and records the outcome on its `improvements` document
 * (mutated in place before it is inserted). The owner's decision wins: "disabled" and "declined" are never touched.
 */
async function saveToolProposal(incoming: ToolProposal, overall: number, improvements: ImprovementDoc[]): Promise<TeachResult["toolProposal"]> {
  const c = await cols();
  const imp = improvements.find((i) => i.type === "tool" && i.payload.tool_name === incoming.name && i.status === "proposed");
  const now = new Date();
  let existing = await c.toolProposals.findOne({ _id: incoming.name });
  let d = decideToolStatus(overall, existing?.status ?? null, process.env);
  if (d.action === "create") {
    const doc: ToolProposalDoc = { ...incoming, _id: incoming.name, status: d.status };
    if (d.promote) { doc.enabledAt = now.toISOString(); doc.enabledBy = "teacher"; }
    try { await c.toolProposals.insertOne(doc); existing = doc; }
    catch (e) { // another call created it at the same moment: treat as a repeat request
      if ((e as { code?: number }).code !== 11000) throw e;
      existing = await c.toolProposals.findOne({ _id: incoming.name });
      d = decideToolStatus(overall, existing?.status ?? null, process.env);
    }
  }
  if (d.action !== "create" && existing) {
    if (d.action === "bump") {
      const m = mergeToolProposal(existing, incoming, now);
      const set: Partial<ToolProposalDoc> = { requestCount: m.requestCount, sourceCallSids: m.sourceCallSids, evidence: m.evidence, updatedAt: m.updatedAt };
      if (d.promote) { set.status = "enabled"; set.enabledAt = now.toISOString(); set.enabledBy = "teacher"; }
      await c.toolProposals.updateOne({ _id: incoming.name, status: existing.status }, { $set: set });
    }
  }
  if (imp) {
    if (d.action === "skip") {
      imp.status = "rejected";
      imp.rejected_reason = `tool proposal: the owner already ${existing?.status ?? "declined"} ${incoming.name}; not reopened`;
    } else if (d.status === "enabled" && (d.promote || d.action === "bump")) {
      imp.reason = d.promote
        ? `${imp.reason} (Tool auto-enabled by the teacher because the call scored ${overall} (< ${d.threshold}).)`
        : `${imp.reason} (Repeat request for the already enabled tool ${incoming.name}.)`;
    } else {
      imp.reason = `${imp.reason} (Waiting for the owner to enable it; the call scored ${overall}, threshold ${d.threshold}.)`;
    }
  }
  return d.action === "skip" ? null : { proposal: incoming, action: d.action, status: d.status, promoted: d.promote, threshold: d.threshold };
}

/**
 * Validates and writes the call's playbook entry, and appends the mirroring `improvements` document to `improvements`
 * (type "prompt" with payload.playbook_id: no config version, no rule change). The status of an existing entry is never changed.
 */
async function savePlaybookEntry(
  raw: NonNullable<Awaited<ReturnType<Judge>>["playbook_entry"]>, call: CallDoc, cfg: ConfigVersionDoc,
  overall: number, improvements: ImprovementDoc[], now: Date,
): Promise<TeachResult["playbook"]> {
  const c = await cols();
  const n = () => improvements.length + 1;
  for (let attempt = 0; ; attempt++) {
    const existing = await c.playbook.find().toArray();
    const v = validatePlaybookEntry(raw, call, cfg, { now, existingIds: existing.map((e) => e.id) });
    if (!v.ok) {
      improvements.push(playbookImprovement(call._id, n(), { id: "", when: raw.when, handling: raw.handling }, [], "rejected",
        `Playbook entry "${raw.title}" rejected.`, now, `playbook entry: ${v.reason}`));
      return null;
    }
    const entry = v.entry, turns = [...new Set(entry.evidence.map((e) => e.turn))];
    const d = decidePlaybookStatus(overall, existing, process.env, { title: entry.title, when: entry.when, callSid: call._id });
    if (d.action === "bump" && d.match) {
      const m = mergePlaybookEntry(d.match, entry, now);
      await c.playbook.updateOne({ _id: d.match.id },
        { $set: { timesSeen: m.timesSeen, sourceCallSids: m.sourceCallSids, evidence: m.evidence, updatedAt: m.updatedAt } });
      const note = `Seen again (timesSeen ${m.timesSeen}); entry ${m.id} is ${m.status}.`;
      improvements.push(d.match.status === "active"
        ? playbookImprovement(call._id, n(), m, turns, "applied", note, now)
        : playbookImprovement(call._id, n(), m, turns, "rejected", note, now, `playbook entry ${m.id} already exists (${m.status}); counted, status not changed`));
      return { entry: m, action: "bump", threshold: d.threshold };
    }
    const status = d.action === "create-active" ? "active" : "proposed";
    const doc: PlaybookDoc = { ...entry, _id: entry.id, status };
    try { await c.playbook.insertOne(doc); }
    catch (e) { // same id taken at the same moment: draw another and re-read
      if ((e as { code?: number }).code !== 11000 || attempt >= 4) throw e;
      continue;
    }
    improvements.push(playbookImprovement(call._id, n(), entry, turns, status === "active" ? "applied" : "proposed",
      status === "active"
        ? `Playbook entry ${entry.id} activated by the teacher because the call scored ${overall} (< ${d.threshold}).`
        : `Playbook entry ${entry.id} waiting for the owner; the call scored ${overall}, threshold ${d.threshold}.`, now));
    return { entry: doc, action: d.action, threshold: d.threshold };
  }
}

/** For `npm run playbook`: every entry, most seen first. */
export async function listPlaybook() {
  return (await cols()).playbook.find().sort({ timesSeen: -1, updatedAt: -1 }).toArray();
}

/** For `npm run tools`: every proposal, most requested first. */
export async function listToolProposals() {
  return (await cols()).toolProposals.find().sort({ requestCount: -1, updatedAt: -1 }).toArray();
}

async function setActive(version: number) {
  await (await cols()).configState.updateOne({ _id: "active" }, { $set: { version } }, { upsert: true });
}

/**
 * Rolls back a teacher-made version whose last calls score below its parent's average.
 * Versions saved by the manager are never rolled back automatically.
 */
async function autoRollback(cfg: ConfigVersionDoc) {
  if (cfg.created_by !== "teacher" || !cfg.parent_id) return null;
  const c = await cols();
  const overalls = async (configId: string) =>
    (await c.grades.find({ config_version_id: configId }).sort({ created_at: 1 }).toArray()).map((g) => g.overall);
  const r = regression(await overalls(cfg._id), await overalls(cfg.parent_id));
  if (!r) return null;
  const parent = await getConfig(versionOf(cfg.parent_id));
  if (!parent) return null;
  const reason = `auto: last ${LIMITS.rollbackWindow} calls on v${cfg.version} averaged ${r.avg.toFixed(2)}, ` +
    `below the v${parent.version} average of ${r.parentAvg.toFixed(2)}`;
  if (!(await rollbackFrom(cfg, reason))) return null;
  return { from: cfg._id, to: parent._id, reason, parent };
}

/** Moves the pointer from `cfg` to its parent, only if `cfg` is still active. Records the reason. */
async function rollbackFrom(cfg: ConfigVersionDoc, reason: string): Promise<boolean> {
  const c = await cols();
  const res = await c.configState.updateOne(
    { _id: "active", version: cfg.version }, { $set: { version: versionOf(cfg.parent_id!) } });
  if (!res.modifiedCount) return false;
  await c.improvements.updateMany({ applied_in_config_id: cfg._id },
    { $set: { status: "rolled_back", rolled_back_reason: reason } });
  return true;
}

/** Owner answers a "context" question. Only this path can add to the company text. */
export async function answerOwnerQuestion(improvementId: string, answer: string) {
  const c = await cols();
  const imp = await c.improvements.findOne({ _id: improvementId });
  if (!imp || imp.type !== "context" || imp.status !== "proposed")
    throw new Error(`${improvementId} is not an open owner question`);
  const cfg = await getActiveConfig();
  const question = imp.payload.question ?? "";
  const next = await insertVersion<ConfigVersionDoc>((version) => ({
    ...cfg, _id: `v${version}`, version,
    context: `${cfg.context}\n${ownerAnswerLine(question, answer)}`.trim(),
    parent_id: cfg._id, created_by: "manager", source_call_id: imp.source_call_ids[0] ?? null,
    note: `Owner answered: ${question}`.slice(0, 300), created_at: new Date(),
  }), (n) => n);
  await setActive(next.version);
  await c.improvements.updateOne({ _id: improvementId },
    { $set: { status: "applied", "payload.answer": answer, applied_in_config_id: next._id } });
  return next;
}

/** One pointer change back to the parent version. History is kept. */
export async function rollback() {
  const cfg = await getActiveConfig();
  if (!cfg.parent_id)
    throw new Error(`${cfg._id} has no recorded parent (it was not made by the teacher); activate another version from the dashboard`);
  await rollbackFrom(cfg, "manual rollback");
  return cfg.parent_id;
}

/** For the dashboard timeline: one point per call, oldest first. */
export async function scoreTrend() {
  const c = await cols();
  const grades = await c.grades.find().sort({ created_at: 1 }).toArray();
  return grades.map((g) => ({
    call_id: g.call_id, config_version_id: g.config_version_id, outcome: g.outcome,
    overall: g.overall, frustration: g.frustration, at: g.created_at,
  }));
}

/**
 * Runs next to the bridge: teaches every finished call that has no grade yet.
 * Needs no change on the bridge side. A call that fails 3 times is skipped until restart.
 */
/** Which calls watch() may grade: finished, with a real caller turn (a dropped call has none), and ended after `since`. */
export function watchFilter(since: string, failedIds: string[]) {
  return {
    status: "completed",
    "transcript.role": "caller",
    ...(since ? { endedAt: { $gte: since } } : {}),
    callSid: { $nin: failedIds },
  };
}

export async function watch(intervalMs = 3000, judge: Judge = geminiJudge) {
  const c = await cols();
  const failures = new Map<string, number>();
  // Only calls that END after the teacher starts are graded. Older calls (earlier tests, before a rename or a new
  // feature) would teach it lessons about a system that no longer exists. TEACHER_GRADE_BACKLOG=1 grades them too.
  const since = process.env.TEACHER_GRADE_BACKLOG === "1" ? "" : new Date().toISOString();
  console.log(since ? "teacher watching for calls that finish from now on (TEACHER_GRADE_BACKLOG=1 grades older ones)..." : "teacher watching for finished calls (including older ones)...");
  for (;;) {
    const [next] = await c.calls.aggregate<BridgeCall>([
      { $match: watchFilter(since, [...failures].filter(([, n]) => n >= 3).map(([id]) => id)) },
      { $lookup: { from: "grades", localField: "callSid", foreignField: "_id", as: "grade" } },
      { $match: { grade: { $size: 0 } } },
      { $sort: { startedAt: 1 } }, { $limit: 1 },
    ]).toArray();
    if (!next) { await sleep(intervalMs); continue; }
    try { printResult(await teach(next.callSid, judge)); }
    catch (e) {
      console.error(`teach(${next.callSid}) failed:`, e);
      failures.set(next.callSid, (failures.get(next.callSid) ?? 0) + 1);
      await sleep(intervalMs);
    }
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function printResult(r: TeachResult) {
  const g = r.grade;
  console.log(`\n=== ${g.call_id} (${g.outcome}) overall ${g.overall}/10, frustration ${g.frustration}/10 ===`);
  console.log(Object.entries(g.scores).map(([k, v]) => `${k} ${v}`).join(" | "));
  console.log(g.rationale);
  if (r.rolledBack) console.log(`  ROLLED BACK ${r.rolledBack.from} -> ${r.rolledBack.to} (${r.rolledBack.reason})`);
  for (const i of g.issues) console.log(`  issue [turn ${i.turn}] ${i.type}: "${i.quote}"`);
  for (const m of r.improvements) {
    const what = m.type === "tool" && m.payload.tool_name ? `${m.payload.tool_name}: ${m.payload.text}` : m.payload.question ?? `${m.payload.op ?? ""} ${m.payload.rule_id ?? ""} ${m.payload.text ?? ""}`;
    console.log(`  ${m.status.toUpperCase()} ${m.type}: ${what.trim()}${m.rejected_reason ? ` (${m.rejected_reason})` : ""}`);
  }
  if (r.toolProposal) {
    const t = r.toolProposal, p = t.proposal;
    const head = t.status === "enabled"
      ? (t.promoted ? `TOOL CREATED (auto-enabled, grade ${g.overall} < ${t.threshold})` : "TOOL REQUESTED AGAIN (already enabled)")
      : `TOOL PROPOSED (waiting for owner, grade ${g.overall})`;
    console.log(`  ${head}: ${p.name} [${p.write ? "write" : "read"}] ${p.description}`);
    console.log(`    recipe: ${p.recipe ? `yes, verified: ${p.recipeVerified ? "yes" : "no"}` : "no (plain save/look-up tool)"}`);
    if (p.recipe) for (const line of describeRecipe(p.recipe)) console.log(`      - ${line}`);
    console.log(`    params: ${p.params.map((q) => `${q.name}:${q.type}${q.required ? "*" : ""}`).join(", ") || "(none)"}`);
    for (const d of p.mockup.sampleDialogue) console.log(`    ${d.role.padEnd(6)} ${d.text}`);
    console.log(`    example args ${JSON.stringify(p.mockup.exampleArgs)} -> ${JSON.stringify(p.mockup.exampleResult)}`);
  }
  if (r.playbook) {
    const { entry: e, action, threshold } = r.playbook;
    const head = action === "bump" ? `PLAYBOOK ENTRY SEEN AGAIN (timesSeen ${e.timesSeen})`
      : action === "create-active" ? `PLAYBOOK ENTRY ADDED (active, grade ${g.overall})` : "PLAYBOOK ENTRY PROPOSED (waiting for owner)";
    console.log(`  ${head}: ${e.id} ${e.title}`);
    console.log(`    when:     ${e.when}\n    handling: ${e.handling}`);
    if (action === "bump" && e.status !== "active") console.log(`    (entry is ${e.status}; status not changed)`);
    else if (action === "create-proposed") console.log(`    (grade ${g.overall} is not below ${threshold}, or auto-activate is off)`);
  }
  if (r.newConfig) console.log(`  -> new active config: ${r.newConfig._id} (${r.newConfig.rules.length} rules)`);
}

/** What the bridge will put under "ABOUT THE BUSINESS" in the receptionist's system prompt. */
export async function activeContext(): Promise<string> {
  const cfg = await getActiveConfig();
  return `COMPANY: ${cfg.company_name} (config ${cfg._id})\n\n${renderContext(cfg)}`;
}
