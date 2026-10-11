// Adapts the teacher's documents (grades, improvements) to the shape the Snoopy dashboard (web/snoopy) reads.
// Opt-in with ?shape=ui, so the bundled dashboard and any other client keep the raw documents.
import type { CallRecord, ConfigVersion, PlaybookEntry, ToolProposal } from "../services/data/store";

type Doc = Record<string, any>;

export interface UiContext {
  calls: Map<string, CallRecord>;
  versions: ConfigVersion[];
  tools: Map<string, ToolProposal>;
  playbook: Map<string, PlaybookEntry>;
}

const versionNumber = (v: unknown): number | null => {
  const m = /^v?(\d+)$/.exec(String(v ?? ""));
  return m ? Number(m[1]) : null;
};
const iso = (v: unknown): string => {
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
};
const dim = (x: unknown): number => Math.max(1, Math.min(5, Math.round(Number(x) / 2) || 1));

export function toUiGrade(g: Doc, ctx: UiContext) {
  const s = g.scores ?? {};
  const callSid = String(g.call_id ?? g._id);
  const configVersion = versionNumber(g.config_version_id) ?? ctx.calls.get(callSid)?.configVersion ?? null;
  return {
    callSid,
    configVersion,
    outcome: g.outcome,
    score: Math.round(Number(g.overall) * 10),
    frustration: Math.max(0, Math.min(1, Number(g.frustration) / 10)),
    dims: { accuracy: dim(s.accuracy), tools: dim(s.tool_use), completion: dim(s.task_completion), tone: dim(s.tone), brevity: dim(s.brevity) },
    summary: g.rationale ?? "",
    createdAt: iso(g.created_at),
  };
}

export function toUiImprovement(i: Doc, ctx: UiContext) {
  const p = i.payload ?? {};
  const sid: string | undefined = (i.source_call_ids ?? [])[0];
  const turn: number | undefined = (i.evidence_turns ?? [])[0];
  const quote = sid && turn ? ctx.calls.get(sid)?.transcript[turn - 1]?.text ?? "" : "";

  let type: string = i.type;
  let status: string = i.status === "rejected" ? "dismissed" : i.status;
  let title = "";
  let change = p.text ?? p.question ?? "";

  if (i.type === "tool") {
    const t = ctx.tools.get(p.tool_name);
    title = `New tool: ${p.tool_name ?? "tool"}`;
    change = t ? `${t.name}(${t.params.map((x) => x.name).join(", ")}): ${t.description}` : change;
    if (t) status = t.status === "enabled" ? "applied" : t.status === "proposed" ? "proposed" : "dismissed";
  } else if (p.playbook_id) {
    const e = ctx.playbook.get(p.playbook_id);
    title = e ? `Edge case: ${e.title}` : "Edge case";
    if (e) status = e.status === "active" ? "applied" : e.status === "proposed" ? "proposed" : "dismissed";
  } else if (i.type === "context") {
    title = p.question ?? "Question for the owner";
    change = p.answer ? `${p.question} ${p.answer}` : p.question ?? "";
  } else {
    title = String(p.text ?? "Rule").slice(0, 70);
  }

  const toVersion = versionNumber(i.applied_in_config_id);
  const parent = toVersion != null ? (ctx.versions.find((v) => v.version === toVersion) as Doc | undefined)?.parentVersion : undefined;
  return {
    id: String(i._id ?? i.id),
    type,
    status,
    title,
    rationale: i.reason ?? i.rejected_reason ?? "",
    change,
    evidence: sid ? [{ callSid: sid, quote }] : [],
    fromVersion: toVersion != null ? (typeof parent === "number" ? parent : toVersion - 1) : null,
    toVersion,
    createdAt: iso(i.created_at),
  };
}
