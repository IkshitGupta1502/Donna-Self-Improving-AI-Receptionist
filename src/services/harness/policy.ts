import type { PriceRow } from "../data/store";
import type { AgentConfig, Improvement, ImprovementType, Payload } from "./types";

/**
 * What the teacher may change and how. The teacher cannot modify this file,
 * the rubric, or the pipeline: only the voice agent's config and data.
 */
export const POLICY = {
  autoApply: { prompt: true, context: true, data: true, tool: false, schema: false } as Record<ImprovementType, boolean>,
  minConfidence: 0.6,
  maxAppliedPerDay: 10,
  limits: { maxRules: 15, ruleChars: 300, maxDocs: 20, docChars: 1500, maxPriceChangePct: 50, maxPrice: 1000 },
  // Caller speech reaches the teacher, so block text that tries to override the base prompt.
  forbidden: [
    /ignore (all |any |the )?(previous|above|prior)/i,
    /disregard/i,
    /system prompt/i,
    /you are now/i,
    /reveal|exfiltrate/i,
    /https?:\/\//i,
    /\b(refund|discount|free of charge|waive)\b/i,
  ],
};

export function globalAutoApply(): boolean {
  return (process.env.HARNESS_AUTO_APPLY ?? "true").toLowerCase() !== "false";
}

export function isProposalOnly(type: ImprovementType): boolean {
  return !POLICY.autoApply[type];
}

function text(p: Payload): string {
  if (p.type === "prompt" && p.op === "add_rule") return p.text;
  if (p.type === "context" && p.op === "upsert_doc") return `${p.title} ${p.content}`;
  return "";
}

/** Rules that hold even when a human approves: size limits and forbidden text. Returns a reason or null. */
export function hardViolation(p: Payload, cfg: AgentConfig): string | null {
  const L = POLICY.limits;
  const t = text(p);
  if (t) {
    const hit = POLICY.forbidden.find((re) => re.test(t));
    if (hit) return `text matches forbidden pattern ${hit}`;
  }
  if (p.type === "prompt" && p.op === "add_rule") {
    if (p.text.length > L.ruleChars) return `rule longer than ${L.ruleChars} chars`;
    if (cfg.rules.length >= L.maxRules) return `already ${L.maxRules} learned rules; remove one first`;
  }
  if (p.type === "context" && p.op === "upsert_doc") {
    if (p.content.length > L.docChars) return `doc longer than ${L.docChars} chars`;
    if (!cfg.docs.some((d) => d.docId === p.docId) && cfg.docs.length >= L.maxDocs) return `already ${L.maxDocs} docs`;
  }
  if (p.type === "data" && p.op === "upsert_price") {
    const { regularPrice, expeditedPrice } = p.row;
    if (regularPrice > L.maxPrice || expeditedPrice > L.maxPrice) return `price above ${L.maxPrice}`;
    if (expeditedPrice < regularPrice) return "expedited price below regular price";
  }
  return null;
}

/** Rules that only gate *automatic* application; a human can override these. */
export function softHold(
  imp: Pick<Improvement, "confidence" | "payload">,
  ctx: { appliedToday: number; existingPrice: PriceRow | null }
): string | null {
  if (!globalAutoApply()) return "auto-apply disabled (HARNESS_AUTO_APPLY=false)";
  if (isProposalOnly(imp.payload.type)) return `${imp.payload.type} changes are proposal-only`;
  if (imp.confidence < POLICY.minConfidence) return `confidence ${imp.confidence} below ${POLICY.minConfidence}`;
  if (ctx.appliedToday >= POLICY.maxAppliedPerDay) return `daily cap of ${POLICY.maxAppliedPerDay} auto-applied changes reached`;
  const p = imp.payload;
  if (p.type === "data" && p.op === "remove_price") return "removing data needs approval";
  if (p.type === "data" && p.op === "upsert_price" && ctx.existingPrice) {
    const old = ctx.existingPrice;
    const pct = (a: number, b: number) => (a === 0 ? (b === 0 ? 0 : 100) : (Math.abs(a - b) / a) * 100);
    const worst = Math.max(pct(old.regularPrice, p.row.regularPrice), pct(old.expeditedPrice, p.row.expeditedPrice));
    if (worst > POLICY.limits.maxPriceChangePct) return `price change of ${Math.round(worst)}% exceeds ${POLICY.limits.maxPriceChangePct}%`;
  }
  return null;
}
