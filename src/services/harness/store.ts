import { MongoClient } from "mongodb";
import { BASE_CONFIG } from "./config";
import type { AgentConfig, GradeRecord, Improvement, ImprovementStatus } from "./types";

export interface HarnessStore {
  getActiveConfig(): Promise<AgentConfig>;
  setActive(versionId: string): Promise<void>;
  getVersion(versionId: string): Promise<AgentConfig | null>;
  saveVersion(cfg: AgentConfig): Promise<void>;
  listVersions(): Promise<AgentConfig[]>;
  saveGrade(g: GradeRecord): Promise<void>;
  getGrade(callSid: string): Promise<GradeRecord | null>;
  listGrades(limit: number): Promise<GradeRecord[]>;
  saveImprovement(i: Improvement): Promise<void>;
  getImprovement(id: string): Promise<Improvement | null>;
  listImprovements(status?: ImprovementStatus): Promise<Improvement[]>;
}

export function createMemoryHarnessStore(): HarnessStore {
  const versions = new Map<string, AgentConfig>([[BASE_CONFIG.versionId, structuredClone(BASE_CONFIG)]]);
  const grades = new Map<string, GradeRecord>();
  const improvements = new Map<string, Improvement>();
  let active = BASE_CONFIG.versionId;
  return {
    async getActiveConfig() {
      return structuredClone(versions.get(active)!);
    },
    async setActive(id) {
      if (!versions.has(id)) throw new Error(`unknown version ${id}`);
      active = id;
    },
    async getVersion(id) {
      const v = versions.get(id);
      return v ? structuredClone(v) : null;
    },
    async saveVersion(cfg) {
      versions.set(cfg.versionId, structuredClone(cfg));
    },
    async listVersions() {
      return [...versions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((v) => structuredClone(v));
    },
    async saveGrade(g) {
      grades.set(g.callSid, structuredClone(g));
    },
    async getGrade(sid) {
      const g = grades.get(sid);
      return g ? structuredClone(g) : null;
    },
    async listGrades(limit) {
      return [...grades.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit).map((g) => structuredClone(g));
    },
    async saveImprovement(i) {
      improvements.set(i.id, structuredClone(i));
    },
    async getImprovement(id) {
      const i = improvements.get(id);
      return i ? structuredClone(i) : null;
    },
    async listImprovements(status) {
      return [...improvements.values()]
        .filter((i) => !status || i.status === status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((i) => structuredClone(i));
    },
  };
}

export async function createMongoHarnessStore(uri: string, dbName: string): Promise<HarnessStore> {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const versions = db.collection<AgentConfig>("config_versions");
  const state = db.collection<{ _id: string; versionId: string }>("harness_state");
  const grades = db.collection<GradeRecord>("grades");
  const improvements = db.collection<Improvement>("improvements");
  const proj = { projection: { _id: 0 } } as const;

  await versions.createIndex({ versionId: 1 }, { unique: true });
  await grades.createIndex({ callSid: 1 }, { unique: true });
  await improvements.createIndex({ id: 1 }, { unique: true });
  await versions.updateOne({ versionId: BASE_CONFIG.versionId }, { $setOnInsert: { ...BASE_CONFIG } }, { upsert: true });
  await state.updateOne({ _id: "active" }, { $setOnInsert: { versionId: BASE_CONFIG.versionId } }, { upsert: true });
  console.log(`[harness] MongoDB connected: db=${dbName}`);

  return {
    async getActiveConfig() {
      const s = await state.findOne({ _id: "active" });
      const cfg = await versions.findOne({ versionId: s?.versionId ?? BASE_CONFIG.versionId }, proj);
      return cfg ?? structuredClone(BASE_CONFIG);
    },
    async setActive(id) {
      if (!(await versions.findOne({ versionId: id }))) throw new Error(`unknown version ${id}`);
      await state.updateOne({ _id: "active" }, { $set: { versionId: id } }, { upsert: true });
    },
    getVersion: (id) => versions.findOne({ versionId: id }, proj),
    async saveVersion(cfg) {
      await versions.replaceOne({ versionId: cfg.versionId }, cfg, { upsert: true });
    },
    listVersions: () => versions.find({}, proj).sort({ createdAt: 1 }).toArray(),
    async saveGrade(g) {
      await grades.replaceOne({ callSid: g.callSid }, g, { upsert: true });
    },
    getGrade: (sid) => grades.findOne({ callSid: sid }, proj),
    listGrades: (limit) => grades.find({}, proj).sort({ startedAt: -1 }).limit(limit).toArray(),
    async saveImprovement(i) {
      await improvements.replaceOne({ id: i.id }, i, { upsert: true });
    },
    getImprovement: (id) => improvements.findOne({ id }, proj),
    listImprovements: (status) => improvements.find(status ? { status } : {}, proj).sort({ createdAt: -1 }).toArray(),
  };
}

let storePromise: Promise<HarnessStore> | null = null;
export function getHarnessStore(): Promise<HarnessStore> {
  storePromise ??= (async () => {
    const uri = process.env.MONGODB_URI?.trim();
    if (!uri) return createMemoryHarnessStore();
    return createMongoHarnessStore(uri, process.env.MONGODB_DB?.trim() || "snoopy");
  })().catch((err) => {
    storePromise = null;
    throw err;
  });
  return storePromise;
}
