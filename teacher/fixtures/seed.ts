// Demo data in the bridge's document shapes. Only ever written to a database whose name ends in "_demo".
import { renderContext } from "../src/services/mongo/bridge.js";
import type { BridgeCall, BridgeConfig, WorkspaceDoc } from "../src/services/mongo/types.js";

const open: [string, string] = ["09:00", "18:00"];
/** Calendar settings for the demo salon. Maya's calendar is GOOGLE_CALENDAR_ID, or the signed-in account's own calendar. */
export const demoWorkspace: WorkspaceDoc = {
  _id: "default",
  timezone: "America/Los_Angeles",
  business_hours: { sun: null, mon: null, tue: open, wed: open, thu: open, fri: open, sat: open },
  staff: [{ id: "maya", name: "Maya", calendar_id: process.env.GOOGLE_CALENDAR_ID?.trim() || "primary" }],
};

export const demoConfig: BridgeConfig = {
  version: 1,
  companyName: "Luna Hair Studio",
  greeting: "Hi, this is Luna Hair Studio.",
  context: renderContext({
    context: [
      "Opening hours: Tuesday to Saturday, 9 AM to 6 PM. Closed Sunday and Monday.",
      "Prices: women's cut $65, men's cut $40.",
      "Location: 214 Valencia Street, San Francisco.",
    ].join("\n"),
    rules: [
      { id: "r1", kind: "guardrail", locked: true, text: "Only state facts that appear in the business information." },
      { id: "r2", kind: "behavior", text: "If the caller asks for a person, offer to take a message." },
    ],
    tools: { check_availability: "auto", book_appointment: "requires_approval" },
  }),
  author: "system",
  note: "Demo seed",
  createdAt: new Date().toISOString(),
};

export const call = (callSid: string, lines: [("caller" | "agent"), string][],
  toolCalls: Pick<BridgeCall["toolCalls"][number], "name" | "args" | "result">[] = []): BridgeCall => {
  const ts = new Date().toISOString();
  return {
    callSid, from: "+14155550134", startedAt: ts, endedAt: ts, durationSec: 40,
    transcript: lines.map(([role, text]) => ({ role, text, ts })),
    toolCalls: toolCalls.map((t) => ({ ...t, ts })),
    status: "completed", configVersion: demoConfig.version,
  };
};

export const demoCalls: BridgeCall[] = [
  // 1. Invented facts + missed question -> should score low and produce a guardrail + owner question.
  call("fake_call_1", [
    ["caller", "Hi, do you take walk-ins?"],
    ["agent", "Yes, walk-ins are welcome any time!"],
    ["caller", "Great. And how much is a balayage?"],
    ["agent", "A balayage is $120."],
    ["caller", "Okay, thanks."],
  ]),
  // 2. Frustrated caller, agent loops and never offers a message.
  call("fake_call_2", [
    ["caller", "I need to move my appointment on Thursday."],
    ["agent", "I can tell you our opening hours. We are open Tuesday to Saturday, 9 AM to 6 PM."],
    ["caller", "No, I need to reschedule. Can you do that?"],
    ["agent", "We are open Tuesday to Saturday, 9 AM to 6 PM. Is there anything else?"],
    ["caller", "This isn't working. Can I talk to a person?"],
    ["agent", "I am sorry, I cannot help with that. Goodbye."],
  ]),
  // 3. Clean call -> should score high with few or no changes.
  call("fake_call_3", [
    ["caller", "Hi, what time do you close on Saturday?"],
    ["agent", "We close at 6 PM on Saturday."],
    ["caller", "Can you ask Maya to call me back about color? It's Priya, 415-555-0134."],
    ["agent", "Of course. I have a message for Maya from Priya at 415-555-0134 about color. She will call you back."],
    ["caller", "Perfect, thanks."],
  ], [{
    name: "take_message", args: { name: "Priya", phone: "415-555-0134", message: "Call back about color, for Maya" },
    result: { saved: true, message: { name: "Priya", phone: "+14155550134", message: "Call back about color, for Maya" } },
  }]),
];
