// Pure logic, no database and no model. This is the guardrail layer between
// what the teacher proposes and what is allowed to reach the receptionist.

import { configId } from "../mongo/bridge.js";
import type {
  CallDoc, ConfigVersionDoc, GradeDoc, ImprovementDoc, Issue, Rule, Scores, ToolProposal,
} from "../mongo/types.js";
import type { JudgeOutput } from "./judge.js";

export const LIMITS = { maxPromptChangesPerCall: 3, maxRules: 20, maxRuleLength: 300, rollbackWindow: 2 };

const WEIGHTS: Record<keyof Scores, number> = {
  accuracy: 0.35, task_completion: 0.25, tool_use: 0.15, tone: 0.15, brevity: 0.1,
};

export function overallScore(s: Scores): number {
  const sum = (Object.keys(WEIGHTS) as (keyof Scores)[]).reduce((a, k) => a + s[k] * WEIGHTS[k], 0);
  return Math.round(sum * 10) / 10;
}

const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;

/**
 * Automatic rollback test. Both lists are `overall` scores, oldest first. A version has regressed
 * when its last `rollbackWindow` graded calls average lower than its parent's average.
 */
export function regression(versionOveralls: number[], parentOveralls: number[]): { avg: number; parentAvg: number } | null {
  if (versionOveralls.length < LIMITS.rollbackWindow || !parentOveralls.length) return null;
  const avg = mean(versionOveralls.slice(-LIMITS.rollbackWindow)), parentAvg = mean(parentOveralls);
  return avg < parentAvg ? { avg, parentAvg } : null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

function similar(a: string, b: string): boolean {
  const A = new Set(norm(a).split(" ")), B = new Set(norm(b).split(" "));
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / (A.size + B.size - inter) >= 0.75;
}

/** A rule may not smuggle in a business fact: any number it contains must already exist in the config. */
function inventedNumbers(text: string, cfg: ConfigVersionDoc): string[] {
  const known = [cfg.company_name, cfg.greeting, cfg.context, ...cfg.rules.map((r) => r.text)].join(" ");
  return (text.match(/\d+(?:[.:]\d+)?/g) ?? []).filter((n) => !known.includes(n));
}

export interface Plan {
  toolProposal: ToolProposal | null; // validated proposal (status "proposed"); null if none or rejected
  grade: GradeDoc;
  improvements: ImprovementDoc[]; // every proposal, with final status
  nextConfig: ConfigVersionDoc | null; // null when nothing was applied
}

export function buildPlan(
  out: JudgeOutput, call: CallDoc, cfg: ConfigVersionDoc, model: string, now = new Date(),
  nextVersion = cfg.version + 1, // higher after a rollback, when cfg is not the newest version
): Plan {
  const turns = new Map(call.transcript.map((t) => [t.turn, t]));

  // Issues need a real quote from the transcript, otherwise they are dropped.
  const issues: Issue[] = out.issues.filter((i) => {
    const q = norm(i.quote);
    return q.length > 0 && call.transcript.some((t) => norm(t.text).includes(q));
  });

  const grade: GradeDoc = {
    _id: call._id, call_id: call._id,
    config_version_id: call.config_version_id, outcome: call.outcome,
    scores: out.scores, overall: overallScore(out.scores), frustration: out.frustration,
    rationale: out.rationale, issues, model, created_at: now,
  };

  const nextId = configId(nextVersion);
  let rules: Rule[] = cfg.rules.map((r) => ({ ...r }));
  let applied = 0;

  const improvements: ImprovementDoc[] = out.improvements.map((p, i) => {
    const doc: ImprovementDoc = {
      _id: `${call._id}_imp${i + 1}`, source_call_ids: [call._id],
      type: p.type, status: "proposed",
      payload: { op: p.op, rule_id: p.rule_id, rule_kind: p.rule_kind, text: p.text, question: p.question },
      evidence_turns: p.evidence_turns, reason: p.reason, created_at: now,
    };
    const reject = (why: string) => ({ ...doc, status: "rejected" as const, rejected_reason: why });

    if (!p.evidence_turns.length || !p.evidence_turns.every((t) => turns.has(t)))
      return reject("evidence turns missing or not in transcript");

    // context = a question for the owner; tool/schema = proposal only. Never auto-applied.
    if (p.type === "context") return p.question?.trim() ? doc : reject("context needs a question for the owner");
    if (p.type !== "prompt") return p.text?.trim() ? doc : reject("proposal needs a description");

    if (applied >= LIMITS.maxPromptChangesPerCall) return reject("per-call change cap reached");
    const text = (p.text ?? "").replace(/\s+/g, " ").trim(); // one line: rules are stored as lines of text

    if (p.op === "add" || p.op === "modify") {
      if (!text) return reject("rule text is empty");
      if (text.length > LIMITS.maxRuleLength) return reject("rule too long");
      const bad = inventedNumbers(text, cfg);
      if (bad.length) return reject(`rule contains facts not in the knowledge base: ${bad.join(", ")}`);
    }

    if (p.op === "add") {
      if (rules.some((r) => similar(r.text, text))) return reject("duplicates an existing rule");
      if (rules.length >= LIMITS.maxRules) return reject("rule cap reached; merge or remove first");
      const n = Math.max(0, ...rules.map((r) => Number(r.id.replace(/\D/g, "")) || 0)) + 1;
      rules.push({ id: `r${n}`, kind: p.rule_kind ?? "behavior", text });
      doc.payload.rule_id = `r${n}`;
    } else if (p.op === "modify" || p.op === "remove") {
      const target = rules.find((r) => r.id === p.rule_id);
      if (!target) return reject(p.rule_id ? `rule ${p.rule_id} does not exist` : `${p.op} needs a rule_id`);
      if (target.locked) return reject(`rule ${p.rule_id} is locked`);
      if (p.op === "remove") rules = rules.filter((r) => r.id !== target.id);
      else target.text = text;
    } else return reject("prompt change needs op add, modify or remove");

    applied++;
    return { ...doc, status: "applied" as const, applied_in_config_id: nextId };
  });

  // Capability gap: at most one tool proposal per call, validated in code. Always stored as an improvement of type "tool".
  let toolProposal: ToolProposal | null = null;
  if (out.tool_proposal) {
    const v = validateToolProposal(out.tool_proposal, call, now);
    const tp = out.tool_proposal;
    const doc: ImprovementDoc = {
      _id: `${call._id}_imp${improvements.length + 1}`, source_call_ids: [call._id], type: "tool", status: "proposed",
      payload: { text: tp.description, tool_name: tp.name },
      evidence_turns: v.ok ? v.proposal.evidence.map((e) => e.turn) : [],
      reason: tp.why, created_at: now,
    };
    if (v.ok) { toolProposal = v.proposal; improvements.push(doc); }
    else improvements.push({ ...doc, status: "rejected", rejected_reason: `tool proposal: ${v.reason}` });
  }

  const nextConfig: ConfigVersionDoc | null = applied === 0 ? null : {
    ...cfg, _id: nextId, version: nextVersion, rules, parent_id: cfg._id,
    created_by: "teacher", source_call_id: call._id, created_at: now,
    note: `Teacher: ${applied} rule change${applied === 1 ? "" : "s"} after call ${call._id}`,
  };
  return { grade, improvements, nextConfig, toolProposal };
}

// ---------------------------------------------------------------------------------------------
// Tool proposals (capability gaps). Tools are declarative: the bridge saves the args as a record
// (write) or lists that caller's records (read). This validation is the safety gate.

export const BUILTIN_TOOLS = [
  "get_order", "lookup_price", "list_prices", "add_order_note", "take_message", "update_customer_profile",
  "create_order", "set_order_type", "cancel_order", "schedule_appointment", "quote_turnaround",
];
export const TOOL_LIMITS = { maxParams: 6, minDialogue: 2, maxDialogue: 8, maxDescription: 300, maxParamDescription: 200 };
const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const PARAM_TYPES = ["string", "number", "boolean"];
const DIALOGUE_ROLES = ["caller", "agent", "tool"];
// External systems, credentials, payments: not expressible as "save these fields", so never allowed.
const FORBIDDEN = [
  /https?:/i, /www\./i, /\.(com|net|org|io)\b/i, /\burls?\b/i, /\bwebhooks?\b/i,
  /password/i, /credential/i, /api[ _-]?key/i, /\bsecrets?\b/i, /\btokens?\b/i, /\bssn\b/i, /social security/i,
  /payment/i, /\bpay(s|ing)?\b/i, /credit/i, /debit/i, /card[ _-]?(number|no|num)/i, /\bcvv\b/i, /billing/i, /\bcharge[sd]?\b/i,
];

export type ToolValidation = { ok: true; proposal: ToolProposal } | { ok: false; reason: string };

export function validateToolProposal(
  p: NonNullable<JudgeOutput["tool_proposal"]>, call: CallDoc, now = new Date(),
): ToolValidation {
  const no = (reason: string): ToolValidation => ({ ok: false, reason });
  const name = p.name.trim(), description = p.description.trim(), why = p.why.trim();
  if (!SNAKE.test(name) || name.length < 3 || name.length > 40) return no("name must be snake_case, 3-40 characters");
  if (BUILTIN_TOOLS.includes(name)) return no(`${name} is a built-in tool`);
  if (!description || description.length >= TOOL_LIMITS.maxDescription) return no("description must be non-empty and under 300 characters");
  if (!why) return no("why is empty");
  if (p.params.length > TOOL_LIMITS.maxParams) return no(`more than ${TOOL_LIMITS.maxParams} params`);
  const seen = new Set<string>();
  for (const q of p.params) {
    if (!SNAKE.test(q.name)) return no(`param name "${q.name}" is not snake_case`);
    if (seen.has(q.name)) return no(`duplicate param "${q.name}"`);
    seen.add(q.name);
    if (!PARAM_TYPES.includes(q.type)) return no(`param "${q.name}" has type "${q.type}", allowed: string, number, boolean`);
    const d = q.description.trim();
    if (!d || d.length >= TOOL_LIMITS.maxParamDescription) return no(`param "${q.name}" description must be non-empty and under 200 characters`);
  }
  const m = p.mockup;
  if (!m) return no("mockup is missing");
  if (m.sampleDialogue.length < TOOL_LIMITS.minDialogue || m.sampleDialogue.length > TOOL_LIMITS.maxDialogue)
    return no("sample dialogue must have 2 to 8 turns");
  if (m.sampleDialogue.some((t) => !DIALOGUE_ROLES.includes(t.role) || !t.text.trim()))
    return no("sample dialogue turns need role caller, agent or tool and non-empty text");
  const stray = Object.keys(m.exampleArgs).filter((k) => !seen.has(k));
  if (stray.length) return no(`exampleArgs has keys that are not params: ${stray.join(", ")}`);

  // Evidence: every quote must be in the transcript (same normalization as issues). Turn is corrected to where it is found.
  if (!p.evidence.length) return no("no evidence quote");
  const evidence: ToolProposal["evidence"] = [];
  for (const e of p.evidence) {
    const q = norm(e.quote);
    const hits = call.transcript.filter((t) => q.length > 0 && norm(t.text).includes(q));
    if (!hits.length) return no(`evidence quote not found in transcript: "${e.quote.slice(0, 60)}"`);
    evidence.push({ turn: (hits.find((t) => t.turn === e.turn) ?? hits[0]!).turn, quote: e.quote.trim() });
  }

  const scanned = JSON.stringify([name, description, why, p.params, m]);
  const bad = FORBIDDEN.find((re) => re.test(scanned));
  if (bad) return no(`mentions an external system, credentials or payments (${bad.source}); tools may only save or look up fields`);

  const iso = now.toISOString();
  return { ok: true, proposal: {
    name, description, write: p.write, why,
    params: p.params.map((q) => ({ name: q.name, type: q.type as "string" | "number" | "boolean", description: q.description.trim(), required: q.required })),
    mockup: {
      sampleDialogue: m.sampleDialogue.map((t) => ({ role: t.role as "caller" | "agent" | "tool", text: t.text.trim() })),
      exampleArgs: m.exampleArgs, exampleResult: m.exampleResult,
    },
    status: "proposed", requestCount: 1, sourceCallSids: [call._id], evidence, createdAt: iso, updatedAt: iso,
  } };
}

export const TOOL_DEFAULTS = { gradeThreshold: 7 };

export interface ToolDecision {
  action: "create" | "bump" | "skip"; // create = insert new; bump = existing, only count/sources/updatedAt (plus status if promoted); skip = owner decided no
  status: ToolProposal["status"]; // status the stored proposal ends up with
  promote: boolean; // true when status becomes "enabled" now (by the teacher)
  threshold: number;
}

/**
 * Pure decision: what to do with a validated proposal. Auto-enable (declarative tools only; validateToolProposal is the
 * safety gate) when TEACHER_AUTO_ENABLE_TOOLS is not "0" and the call's overall grade is below TOOL_GRADE_THRESHOLD
 * (default 7). A "disabled" or "declined" tool is never touched. An already enabled tool only gets its counters bumped.
 */
export function decideToolStatus(
  overall: number, existing: ToolProposal["status"] | null,
  env: { TEACHER_AUTO_ENABLE_TOOLS?: string; TOOL_GRADE_THRESHOLD?: string } = {},
): ToolDecision {
  const t = Number(env.TOOL_GRADE_THRESHOLD);
  const threshold = env.TOOL_GRADE_THRESHOLD?.trim() && Number.isFinite(t) ? t : TOOL_DEFAULTS.gradeThreshold;
  const auto = env.TEACHER_AUTO_ENABLE_TOOLS !== "0" && overall < threshold;
  if (existing === "disabled" || existing === "declined") return { action: "skip", status: existing, promote: false, threshold };
  if (existing === "enabled") return { action: "bump", status: "enabled", promote: false, threshold };
  if (existing === "proposed") return { action: "bump", status: auto ? "enabled" : "proposed", promote: auto, threshold };
  return { action: "create", status: auto ? "enabled" : "proposed", promote: auto, threshold };
}

/** Merges a repeat request into the stored proposal. Never touches status here; see decideToolStatus. Idempotent per call. */
export function mergeToolProposal(existing: ToolProposal, incoming: ToolProposal, now = new Date()): ToolProposal {
  const already = incoming.sourceCallSids.every((s) => existing.sourceCallSids.includes(s));
  return {
    ...existing,
    requestCount: already ? existing.requestCount : existing.requestCount + 1,
    sourceCallSids: [...new Set([...existing.sourceCallSids, ...incoming.sourceCallSids])],
    evidence: already ? existing.evidence : [...existing.evidence, ...incoming.evidence].slice(0, 6),
    updatedAt: now.toISOString(),
  };
}
