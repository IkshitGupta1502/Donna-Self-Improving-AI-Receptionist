import { z } from "zod";

// ---------------------------------------------------------------------------
// Teacher output contract
//
// This file is the interface between the grading model and the voice agent.
// The teacher returns a TeacherReport; the harness validates it, routes each
// improvement through the policy, and turns accepted ones into a new
// config version (or a data change) that the next call picks up.
// ---------------------------------------------------------------------------

export const SCORE_DIMENSIONS = ["accuracy", "toolUse", "taskCompletion", "tone", "brevity"] as const;
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

const score = z.number().min(0).max(1);

export const ScoresSchema = z.object({
  accuracy: score,
  toolUse: score,
  taskCompletion: score,
  tone: score,
  brevity: score,
});
export type Scores = z.infer<typeof ScoresSchema>;

export const FrustrationSchema = z.object({
  /** 0 = calm, 1 = very frustrated. An estimate from transcript cues, not a verdict. */
  score: score,
  /** Index into call.transcript where frustration peaked, if any. */
  peakTurn: z.number().int().min(0).optional(),
  cues: z.array(z.string().max(200)).max(10).default([]),
});
export type Frustration = z.infer<typeof FrustrationSchema>;

// --- Improvement payloads: the only things the teacher can ask for ---------

export const PriceRowSchema = z.object({
  category: z.string().min(1).max(60),
  item: z.string().min(1).max(80),
  regularPrice: z.number().nonnegative(),
  expeditedPrice: z.number().nonnegative(),
  notes: z.string().max(200).default(""),
});

/** prompt: edits the "learned rules" list appended to the immutable base prompt. */
export const PromptPayload = z.discriminatedUnion("op", [
  z.object({
    type: z.literal("prompt"),
    op: z.literal("add_rule"),
    text: z.string().min(1),
    /** Set by the harness; teachers should leave it out. */
    ruleId: z.string().optional(),
  }),
  z.object({ type: z.literal("prompt"), op: z.literal("remove_rule"), ruleId: z.string().min(1) }),
]);

/** context: knowledge documents injected into the prompt (FAQs, policies, aliases). */
export const ContextPayload = z.discriminatedUnion("op", [
  z.object({
    type: z.literal("context"),
    op: z.literal("upsert_doc"),
    docId: z.string().min(1).max(60),
    title: z.string().min(1).max(80),
    content: z.string().min(1),
  }),
  z.object({ type: z.literal("context"), op: z.literal("remove_doc"), docId: z.string().min(1) }),
]);

/** data: changes to the shop's records, applied through the DataStore. */
export const DataPayload = z.discriminatedUnion("op", [
  z.object({ type: z.literal("data"), op: z.literal("upsert_price"), row: PriceRowSchema }),
  z.object({ type: z.literal("data"), op: z.literal("remove_price"), item: z.string().min(1) }),
]);

/** tool and schema changes are never applied automatically; they surface as proposals. */
export const ToolPayload = z.object({
  type: z.literal("tool"),
  op: z.enum(["add", "modify"]),
  toolName: z.string().min(1).max(60),
  description: z.string().min(1).max(1000),
  spec: z.record(z.unknown()).optional(),
});
export const SchemaPayload = z.object({
  type: z.literal("schema"),
  collection: z.string().min(1).max(60),
  description: z.string().min(1).max(1000),
  spec: z.record(z.unknown()).optional(),
});

export const PayloadSchema = z.union([
  PromptPayload,
  ContextPayload,
  DataPayload,
  ToolPayload,
  SchemaPayload,
]);
export type Payload = z.infer<typeof PayloadSchema>;
export type ImprovementType = Payload["type"];
export type ConfigPayload = z.infer<typeof PromptPayload> | z.infer<typeof ContextPayload>;
export type DataPayloadT = z.infer<typeof DataPayload>;

export const ProposedImprovementSchema = z.object({
  title: z.string().min(1).max(120),
  rationale: z.string().min(1).max(1000),
  /** Transcript / tool-call indexes that motivated the change. */
  evidenceTurns: z.array(z.number().int().min(0)).max(20).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  payload: PayloadSchema,
});
export type ProposedImprovement = z.infer<typeof ProposedImprovementSchema>;

export const TeacherReportSchema = z.object({
  summary: z.string().max(1500),
  scores: ScoresSchema,
  frustration: FrustrationSchema,
  /** Validated one by one: a bad entry is dropped without losing the report. */
  improvements: z.array(z.unknown()).default([]),
});

// --- Deterministic outcome (computed by the harness, never by the teacher) --

export type OutcomeLabel = "answered" | "message_taken" | "note_added" | "failed" | "no_resolution";

export interface Outcome {
  label: OutcomeLabel;
  success: boolean;
  /** Tool calls that errored or came back empty, by index into call.toolCalls. */
  problems: { toolIndex: number; name: string; reason: string }[];
}

// --- Persisted records ------------------------------------------------------

export interface LearnedRule {
  id: string;
  text: string;
}
export interface ContextDoc {
  docId: string;
  title: string;
  content: string;
}

/** One immutable version of everything the teacher is allowed to change in the voice agent. */
export interface AgentConfig {
  versionId: string;
  parentId: string | null;
  createdAt: string;
  createdBy: "seed" | "teacher" | "human" | "rollback";
  improvementId?: string;
  note: string;
  rules: LearnedRule[];
  docs: ContextDoc[];
}

export type ImprovementStatus = "proposed" | "applied" | "rejected" | "rolled_back";

export interface Improvement {
  id: string;
  createdAt: string;
  sourceCallSids: string[];
  title: string;
  rationale: string;
  evidenceTurns: number[];
  confidence: number;
  payload: Payload;
  status: ImprovementStatus;
  /** Why it is still proposed / was rejected. */
  reason?: string;
  decidedBy?: "policy" | "human";
  appliedAt?: string;
  /** Config version produced by applying this (config types only). */
  versionId?: string;
  /** Inverse operation, used by rollback. */
  undo?: ConfigPayload | DataPayloadT;
  rolledBackAt?: string;
}

export interface GradeRecord {
  callSid: string;
  gradedAt: string;
  startedAt: string;
  configVersionId?: string;
  outcome: Outcome;
  mode: "full" | "failure_analysis";
  teacher: string | null;
  summary?: string;
  scores?: Scores;
  /** Mean of the five dimensions, for the timeline. */
  overall?: number;
  frustration?: Frustration;
  improvementIds: string[];
  dropped: { reason: string; raw: unknown }[];
  error?: string;
}
