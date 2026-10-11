import type { CallRecord } from "../data/store";
import type { Outcome } from "./types";

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** Deterministic success check from the tool trace (PLAN §6). The teacher does not decide this. */
export function classifyOutcome(call: CallRecord): Outcome {
  const problems: Outcome["problems"] = [];
  let message = false;
  let note = false;
  let answered = false;

  call.toolCalls.forEach((tc, i) => {
    const r = asObj(tc.result);
    if (typeof r.error === "string") {
      problems.push({ toolIndex: i, name: tc.name, reason: `error: ${r.error}` });
      return;
    }
    switch (tc.name) {
      case "take_message":
        if (r.saved === true) message = true;
        break;
      case "add_order_note":
        if (r.saved === true) note = true;
        else problems.push({ toolIndex: i, name: tc.name, reason: "note not saved" });
        break;
      case "get_order":
      case "lookup_price":
        if (r.found === true) answered = true;
        else problems.push({ toolIndex: i, name: tc.name, reason: "not found" });
        break;
      case "list_prices":
        answered = true;
        break;
    }
  });

  const hardErrors = problems.some((p) => p.reason.startsWith("error:"));
  const label = message ? "message_taken" : note ? "note_added" : answered ? "answered" : call.toolCalls.length ? "failed" : "no_resolution";
  // A "not found" followed by a successful recovery is still a success, but it stays in `problems` as teaching signal.
  return { label, success: label !== "failed" && label !== "no_resolution" && !hardErrors, problems };
}
