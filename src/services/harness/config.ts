import type { AgentConfig, ConfigPayload, LearnedRule } from "./types";

export const BASE_CONFIG: AgentConfig = {
  versionId: "v1",
  parentId: null,
  createdAt: new Date(0).toISOString(),
  createdBy: "seed",
  note: "Initial configuration (base prompt only)",
  rules: [],
  docs: [],
};

export interface Applied {
  rules: LearnedRule[];
  docs: AgentConfig["docs"];
  /** Inverse of the change, so it can be rolled back. */
  undo: ConfigPayload;
}

/** Pure: apply one config payload to a config's rules/docs. Throws on an invalid reference. */
export function applyConfigPayload(cfg: AgentConfig, p: ConfigPayload, improvementId: string): Applied {
  const rules = cfg.rules.map((r) => ({ ...r }));
  const docs = cfg.docs.map((d) => ({ ...d }));

  if (p.type === "prompt") {
    if (p.op === "add_rule") {
      const id = p.ruleId ?? `rule-${improvementId}`;
      if (rules.some((r) => r.id === id)) throw new Error(`rule ${id} already exists`);
      rules.push({ id, text: p.text.replace(/\s+/g, " ").trim() });
      return { rules, docs, undo: { type: "prompt", op: "remove_rule", ruleId: id } };
    }
    const idx = rules.findIndex((r) => r.id === p.ruleId);
    if (idx < 0) throw new Error(`no rule ${p.ruleId}`);
    const [removed] = rules.splice(idx, 1);
    return { rules, docs, undo: { type: "prompt", op: "add_rule", text: removed.text, ruleId: removed.id } };
  }

  if (p.op === "upsert_doc") {
    const next = { docId: p.docId, title: p.title.trim(), content: p.content.trim() };
    const idx = docs.findIndex((d) => d.docId === p.docId);
    if (idx < 0) {
      docs.push(next);
      return { rules, docs, undo: { type: "context", op: "remove_doc", docId: p.docId } };
    }
    const prev = docs[idx];
    docs[idx] = next;
    return { rules, docs, undo: { type: "context", op: "upsert_doc", docId: prev.docId, title: prev.title, content: prev.content } };
  }
  const idx = docs.findIndex((d) => d.docId === p.docId);
  if (idx < 0) throw new Error(`no doc ${p.docId}`);
  const [removed] = docs.splice(idx, 1);
  return { rules, docs, undo: { type: "context", op: "upsert_doc", docId: removed.docId, title: removed.title, content: removed.content } };
}

/** Text appended to the base system prompt for a given config version. */
export function renderConfigSections(cfg: AgentConfig): string {
  const parts: string[] = [];
  if (cfg.docs.length) {
    parts.push(
      "SHOP KNOWLEDGE (facts maintained by the shop; tool results still win if they disagree):\n" +
        cfg.docs.map((d) => `[${d.title}] ${d.content.replace(/\s+/g, " ")}`).join("\n")
    );
  }
  if (cfg.rules.length) {
    parts.push("LEARNED RULES (added from past calls; follow them):\n" + cfg.rules.map((r) => `- ${r.text}`).join("\n"));
  }
  return parts.join("\n\n");
}
