// Pure conversion between the bridge's documents and the teacher's view. No database.
//
// The bridge's config has one free-text `context` field and no place for rules, so the teacher
// keeps its rules in a marked block at the end of that text. The bridge already injects `context`
// into the system prompt and shows it in the dashboard editor, so rules reach the receptionist
// and stay visible to the manager without any change on the bridge side.

import type {
  BridgeCall, BridgeConfig, CallDoc, ConfigVersionDoc, Outcome, Rule, ToolCall,
} from "./types.js";

const RULES_START = "LEARNED RULES (added by the teaching agent after reviewing calls; follow every one):";
const RULES_END = "END OF LEARNED RULES";
const RULE_LINE = /^- \((r\d+), (guardrail|behavior)(, locked)?\) (.+)$/;

export const configId = (version: number) => `v${version}`;
export const versionOf = (id: string) => Number(id.slice(1));

/** Splits the bridge's context text into the company's own text and the teacher's rules. */
export function splitContext(text: string): { context: string; rules: Rule[] } {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim().startsWith("LEARNED RULES"));
  if (start < 0) return { context: text.trim(), rules: [] };
  let end = lines.findIndex((l, i) => i > start && l.trim().startsWith(RULES_END));
  if (end < 0) end = lines.length;
  const rules: Rule[] = [];
  const stray: string[] = []; // lines a person typed inside the block: keep them as company text
  for (const line of lines.slice(start + 1, end)) {
    const m = RULE_LINE.exec(line.trim());
    if (m) rules.push({ id: m[1]!, kind: m[2] as Rule["kind"], text: m[4]!, ...(m[3] ? { locked: true } : {}) });
    else if (line.trim()) stray.push(line);
  }
  return { context: [...lines.slice(0, start), ...stray, ...lines.slice(end + 1)].join("\n").trim(), rules };
}

/** The context text exactly as the bridge will put it in the receptionist's system prompt. */
export function renderContext(cfg: Pick<ConfigVersionDoc, "context" | "rules">): string {
  if (!cfg.rules.length) return cfg.context;
  const lines = cfg.rules.map((r) => `- (${r.id}, ${r.kind}${r.locked ? ", locked" : ""}) ${r.text}`);
  return `${cfg.context}\n\n${RULES_START}\n${lines.join("\n")}\n${RULES_END}`.trim();
}

export function toConfig(doc: BridgeConfig): ConfigVersionDoc {
  return {
    _id: configId(doc.version), version: doc.version, company_name: doc.companyName, greeting: doc.greeting,
    ...splitContext(doc.context),
    parent_id: doc.parentVersion ? configId(doc.parentVersion) : null,
    created_by: doc.author, source_call_id: doc.sourceCallSid ?? null,
    ...(doc.note ? { note: doc.note } : {}), created_at: new Date(doc.createdAt),
  };
}

export function fromConfig(cfg: ConfigVersionDoc): BridgeConfig {
  return {
    version: cfg.version, companyName: cfg.company_name, greeting: cfg.greeting, context: renderContext(cfg),
    author: cfg.created_by, ...(cfg.note ? { note: cfg.note } : {}), createdAt: cfg.created_at.toISOString(),
    ...(cfg.parent_id ? { parentVersion: versionOf(cfg.parent_id) } : {}),
    ...(cfg.source_call_id ? { sourceCallSid: cfg.source_call_id } : {}),
  };
}

/**
 * The bridge does not label outcomes, so the label comes from tool results only:
 * a saved message, else a tool error, else "answered" (which only means neither happened).
 */
export function deriveOutcome(tools: ToolCall[]): Outcome {
  const res = (t: ToolCall) => (t.result && typeof t.result === "object" ? t.result : {}) as Record<string, unknown>;
  if (tools.some((t) => t.name === "take_message" && res(t).saved === true)) return "message_taken";
  if (tools.some((t) => res(t).error !== undefined)) return "failed";
  return "answered";
}

export function toCall(rec: BridgeCall): CallDoc {
  const tool_trace = rec.toolCalls.map(({ name, args, result }) => ({ name, args, result }));
  return {
    _id: rec.callSid,
    config_version_id: rec.configVersion ? configId(rec.configVersion) : null,
    transcript: rec.transcript.map((t, i) => ({ turn: i + 1, role: t.role, text: t.text })),
    tool_trace, outcome: deriveOutcome(tool_trace),
    ...(rec.durationSec !== undefined ? { duration_sec: rec.durationSec } : {}),
    created_at: new Date(rec.startedAt),
  };
}
