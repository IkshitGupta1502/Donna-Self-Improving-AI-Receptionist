import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { TOOL_NAMES, type CallDoc, type ConfigVersionDoc } from "../mongo/types.js";

const score = z.coerce.number().min(0).max(10);

export const JudgeOutput = z.object({
  scores: z.object({
    accuracy: score, tool_use: score, task_completion: score, tone: score, brevity: score,
  }),
  frustration: score,
  rationale: z.string(),
  issues: z.array(z.object({
    type: z.string(),
    turn: z.coerce.number().int(),
    quote: z.string(),
    explanation: z.string(),
  })).default([]),
  improvements: z.array(z.object({
    type: z.enum(["prompt", "context", "tool", "schema"]),
    op: z.enum(["add", "modify", "remove"]).optional(),
    rule_id: z.string().optional(),
    rule_kind: z.enum(["guardrail", "behavior"]).optional(),
    text: z.string().optional(),
    question: z.string().optional(),
    // Permission change for a calendar tool. Kept as free strings here; plan.ts checks the values.
    tool: z.string().optional(),
    permission: z.string().optional(),
    evidence_turns: z.array(z.coerce.number().int()).default([]),
    reason: z.string().default(""),
  })).default([]),
});
export type JudgeOutput = z.infer<typeof JudgeOutput>;

export type Judge = (call: CallDoc, cfg: ConfigVersionDoc) => Promise<JudgeOutput>;

// The rubric is fixed in code. The teacher can never edit it.
const SYSTEM = `You are the TEACHER for an AI phone receptionist that serves a small business.
You review one finished call and (1) grade it, (2) propose small changes to the receptionist's harness.

RUBRIC, each 0-10:
- accuracy: every factual statement by the agent is supported by BUSINESS KNOWLEDGE or by a tool result in TOOL TRACE. Any invented price, time, policy or availability caps this at 3.
- tool_use: right tool, right arguments, at the right moment; tool results relayed correctly. 10 if no tool was needed and none was called.
  A booking (book_appointment) made before the caller clearly confirmed the date and time in the transcript, or with a date or time different from what the caller said, caps this at 3.
- task_completion: the caller got what they needed, or a clear next step (message taken, escalation).
- tone: natural, polite, sounds like a person on the phone.
- brevity: short spoken turns, no rambling, no repeated questions.
Also: frustration 0-10 = how frustrated the caller sounded (repeated questions, "this isn't working", asking for a human). Estimate from the text only.

ISSUES: each needs the turn number and an EXACT quote copied from that turn. No quote, no issue.

IMPROVEMENTS (at most 3, fewer is better, zero is fine for a good call):
- type "prompt": change a RULE. op "add" (give rule_kind + text), "modify" (rule_id + new text), or "remove" (rule_id).
  rule_id must be the id of a rule listed in CURRENT RULES, for example "r2". Locked rules cannot be modified or removed.
  Rules describe BEHAVIOR and must generalize beyond this one call. A rule must NEVER contain a business fact (price, hour, address, policy).
- type "context": the agent lacked a fact. Do NOT guess the fact. Put the question the OWNER must answer in "question".
- type "tool" / "schema": a missing tool or data field. Describe it in "text". These are proposals only.
- type "tool" with "tool" and "permission": change what the agent may do with a calendar tool listed in TOOL PERMISSIONS.
  permission is "disabled", "requires_approval" (owner confirms each use) or "auto". Lower it after a wrong date or time, a double booking,
  a booking the caller did not confirm, or a tool error. Raise it by one level only when this call used the tool correctly.
Every improvement needs evidence_turns (turn numbers) and a one-sentence reason. Do not add a rule that duplicates an existing one; modify it instead.
When the agent got something wrong, propose the rule that would have prevented it, saying exactly what to do in that situation. Do this even if a broader rule already exists, because it was not enough: modify that rule if it is not locked, otherwise add a more specific one. Do not propose rules for things the agent did well.

Reply with ONLY a JSON object:
{"scores":{"accuracy":0,"tool_use":0,"task_completion":0,"tone":0,"brevity":0},"frustration":0,"rationale":"2-3 sentences",
 "issues":[{"type":"invented_fact|missed_question|rule_violation|tool_error|tone|verbosity|other","turn":0,"quote":"","explanation":""}],
 "improvements":[{"type":"prompt","op":"add","rule_kind":"guardrail","text":"","evidence_turns":[0],"reason":""},
                 {"type":"prompt","op":"modify","rule_id":"r0","text":"","evidence_turns":[0],"reason":""},
                 {"type":"context","question":"","evidence_turns":[0],"reason":""},
                 {"type":"tool","tool":"book_appointment","permission":"requires_approval","evidence_turns":[0],"reason":""}]}`;

export function buildJudgeInput(call: CallDoc, cfg: ConfigVersionDoc): string {
  const rules = cfg.rules.map((r) => `${r.id} [${r.kind}${r.locked ? ", locked" : ""}]: ${r.text}`).join("\n");
  const transcript = call.transcript.map((t) => `[${t.turn}] ${t.role}: ${t.text}`).join("\n");
  const tools = call.tool_trace.length ? JSON.stringify(call.tool_trace, null, 1) : "(no tool calls)";
  return `CURRENT RULES (config v${cfg.version}):
${rules || "(none)"}

TOOL PERMISSIONS:
${TOOL_NAMES.map((t) => `${t}: ${cfg.tools[t]}`).join("\n")}

BUSINESS KNOWLEDGE (${cfg.company_name}):
${cfg.context || "(none)"}

OUTCOME LABEL: ${call.outcome}
(from tool results only: "booked" = an appointment was created, "message_taken" = a message was saved, "failed" = a tool returned an error, "answered" = none of these, which does not mean the caller was satisfied)

TOOL TRACE:
${tools}

TRANSCRIPT:
${transcript}`;
}

export function teacherModel() {
  return process.env.GEMINI_TEACHER_MODEL ?? "gemini-3.8-flash";
}

/**
 * Real judge: one Gemini call, JSON out, validated with zod.
 * A bad reply gets one retry. An overloaded model (503) is retried up to 3 more times with a growing wait.
 * A quota error (429) is never retried, because every attempt uses up more of the daily allowance.
 */
export const geminiJudge: Judge = async (call, cfg) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set (set it in .env, see README)");
  const ai = new GoogleGenAI({ apiKey });
  let lastErr: unknown;
  let badReplies = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await ai.models.generateContent({
        model: teacherModel(),
        contents: buildJudgeInput(call, cfg),
        config: { systemInstruction: SYSTEM, temperature: 0.1, responseMimeType: "application/json" },
      });
      const raw = (res.text ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
      return JudgeOutput.parse(JSON.parse(raw));
    } catch (e) {
      lastErr = e;
      const status = (e as { status?: number }).status;
      if (status === 429)
        throw new Error(`teacher judge: Gemini quota exceeded for ${teacherModel()} (free tier allows 20 requests per day per model). ` +
          `Enable billing for the key or set GEMINI_TEACHER_MODEL to another model. ${String(e).slice(0, 300)}`);
      if (status === 503) await new Promise((r) => setTimeout(r, 4000 * (attempt + 1))); // overloaded: wait longer each time
      else if (++badReplies > 1) break; // anything else: one retry, then give up
      else await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error(`teacher judge failed: ${String(lastErr)}`);
};
