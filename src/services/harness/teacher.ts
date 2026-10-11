import type { CallRecord } from "../data/store";
import type { AgentConfig, Improvement, Outcome } from "./types";

/** Everything the teacher sees for one call. */
export interface TeacherInput {
  call: CallRecord;
  outcome: Outcome;
  /** "full" for successful calls, "failure_analysis" (lighter) for failed ones. */
  mode: "full" | "failure_analysis";
  /** The config version that handled the call (what the teacher is critiquing). */
  config: AgentConfig;
  /** The immutable base prompt, so the teacher does not repeat what it already says. */
  basePrompt: string;
  tools: { name: string; description?: string }[];
  /** Recent improvements, so the teacher does not re-propose them. */
  recentImprovements: Pick<Improvement, "id" | "title" | "status" | "payload">[];
}

/**
 * The grading model implements this. It may return the raw parsed JSON of its
 * response: the harness validates it against TeacherReportSchema (types.ts) and
 * drops invalid improvements individually.
 */
export interface Teacher {
  name: string;
  grade(input: TeacherInput): Promise<unknown>;
}

let current: Teacher | null = null;
export function setTeacher(t: Teacher | null): void {
  current = t;
}
export function getTeacher(): Teacher | null {
  return current;
}
