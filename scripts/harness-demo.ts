// Offline demo of the RSI loop with the mock teacher: npm run harness:demo
process.env.GEMINI_API_KEY ||= "demo";
delete process.env.MONGODB_URI;

import { getStore } from "../src/services/gemini/liveSession";
import { getHarnessStore } from "../src/services/harness/store";
import { buildSystemPrompt } from "../src/services/gemini/systemPrompt";
import { processCall, rollbackImprovement } from "../src/services/harness/pipeline";
import { setTeacher } from "../src/services/harness/teacher";
import { mockTeacher } from "../src/services/harness/mockTeacher";
import { executeTool } from "../src/services/gemini/tools";
import type { CallRecord } from "../src/services/data/store";

async function fakeCall(sid: string, versionId: string, item: string): Promise<CallRecord> {
  const store = await getStore();
  const args = { item, speed: "Regular" };
  const result = await executeTool("lookup_price", args, store);
  const ts = new Date().toISOString();
  return {
    callSid: sid, startedAt: ts, endedAt: ts, durationSec: 20, status: "completed", configVersionId: versionId,
    transcript: [{ role: "caller", text: `How much for a ${item}?`, ts }],
    toolCalls: [{ name: "lookup_price", args, result, ts }],
  };
}

async function main() {
  setTeacher(mockTeacher);
  const hs = await getHarnessStore();

  const c1 = await fakeCall("CA-demo-1", (await hs.getActiveConfig()).versionId, "Blazer");
  const g1 = await processCall(c1);
  console.log("call 1:", g1?.outcome.label, "overall", g1?.overall?.toFixed(2), "improvements", g1?.improvementIds);

  const cfg = await hs.getActiveConfig();
  console.log("active config:", cfg.versionId, cfg.rules.map((r) => r.text));
  console.log("prompt now includes rule:", buildSystemPrompt("today", undefined, cfg).includes("LEARNED RULES"));

  const imp = (await hs.listImprovements("applied"))[0];
  if (imp) {
    await rollbackImprovement(imp.id);
    const after = await hs.getActiveConfig();
    console.log("after rollback:", after.versionId, "rules:", after.rules.length);
  }
  console.log("versions:", (await hs.listVersions()).map((v) => `${v.versionId}<-${v.parentId}(${v.createdBy})`).join(", "));
}
main().catch((e) => { console.error(e); process.exit(1); });
