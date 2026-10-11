import type { Teacher, TeacherInput } from "./teacher";

const FRUSTRATION_CUES = [/this (isn't|is not) working/i, /\bagain\b/i, /speak to (a |someone|a human|a person)/i, /\b(useless|ridiculous|frustrat)/i, /already (said|told)/i];

/**
 * Deterministic stand-in so the whole loop runs without a model.
 * The real teacher replaces it via setTeacher().
 */
export const mockTeacher: Teacher = {
  name: "mock",
  async grade({ call, outcome }: TeacherInput) {
    const callerTurns = call.transcript.map((t, i) => ({ ...t, i })).filter((t) => t.role === "caller");
    const cues = callerTurns.filter((t) => FRUSTRATION_CUES.some((re) => re.test(t.text)));
    const missed = outcome.problems.filter((p) => p.name === "lookup_price" && p.reason === "not found");

    const improvements: unknown[] = [];
    if (missed.length) {
      improvements.push({
        title: "Fall back to the price list when an item is not found",
        rationale: "lookup_price returned not found and the agent had no recovery step.",
        evidenceTurns: missed.map((m) => m.toolIndex),
        confidence: 0.8,
        payload: {
          type: "prompt",
          op: "add_rule",
          text: "If lookup_price says an item was not found, call list_prices and pick the closest item before telling the caller the price is unavailable.",
        },
      });
    }

    const base = outcome.success ? 0.85 : 0.35;
    return {
      summary: `Mock grade: outcome ${outcome.label}, ${outcome.problems.length} tool problem(s).`,
      scores: { accuracy: base, toolUse: outcome.problems.length ? 0.4 : 0.9, taskCompletion: base, tone: 0.8, brevity: 0.8 },
      frustration: { score: Math.min(1, cues.length * 0.35), peakTurn: cues[0]?.i, cues: cues.map((c) => c.text.slice(0, 120)) },
      improvements,
    };
  },
};
