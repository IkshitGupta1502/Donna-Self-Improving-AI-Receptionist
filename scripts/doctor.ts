// Pre-flight check: `npm run doctor`. Tests keys and connections without a phone call.
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import twilio from "twilio";

dotenv.config();

const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => console.log(`  ✗ ${m}`);
const warn = (m: string) => console.log(`  ! ${m}`);
let failures = 0;
const fail = (m: string) => { failures++; bad(m); };

function redact(msg: string): string {
  return msg.replace(/mongodb(\+srv)?:\/\/[^@\s]+@/g, "mongodb$1://<redacted>@");
}

async function checkEnv(): Promise<void> {
  console.log("Environment (.env)");
  const required = ["GEMINI_API_KEY"];
  const optional = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "MONGODB_URI", "DASHBOARD_TOKEN"];
  for (const k of required) process.env[k] ? ok(`${k} is set`) : fail(`${k} is missing`);
  for (const k of optional) process.env[k] ? ok(`${k} is set`) : warn(`${k} is not set`);
  if (process.env.TWILIO_NUMBER && !process.env.TWILIO_PHONE_NUMBER) {
    fail("Found TWILIO_NUMBER. The variable must be named TWILIO_PHONE_NUMBER");
  }
  const num = process.env.TWILIO_PHONE_NUMBER;
  if (num && !/^\+\d{10,15}$/.test(num)) fail(`TWILIO_PHONE_NUMBER should look like +16054761503 (got "${num}")`);
}

async function checkMongo(): Promise<void> {
  console.log("\nMongoDB");
  const uri = process.env.MONGODB_URI;
  if (!uri) return warn("MONGODB_URI not set: the app will use the in-memory store");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    await client.db(process.env.MONGODB_DB ?? "snoopy").command({ ping: 1 });
    ok("Connected to Atlas and ping succeeded");
  } catch (err) {
    fail(`Could not connect: ${redact(err instanceof Error ? err.message : String(err))}`);
    warn("Common causes: wrong password, special characters not URL-encoded, or your IP is not allowed (Atlas > Network Access)");
  } finally {
    await client.close().catch(() => {});
  }
}

async function checkTwilio(): Promise<void> {
  console.log("\nTwilio");
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_PHONE_NUMBER: num } = process.env;
  if (!sid || !token) return warn("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set: skipping (set the webhook manually)");
  try {
    const client = twilio(sid, token);
    await client.api.accounts(sid).fetch();
    ok("Account SID and auth token are valid");
    if (!num) return warn("TWILIO_PHONE_NUMBER not set");
    const found = await client.incomingPhoneNumbers.list({ phoneNumber: num, limit: 1 });
    if (found.length === 0) return fail(`${num} is not a number on this account`);
    ok(`${num} found. Voice webhook: ${found[0].voiceUrl || "(none)"} [${found[0].voiceMethod}]`);
    if (!found[0].voiceUrl?.endsWith("/voice")) warn("Webhook should end in /voice and use POST");
  } catch (err) {
    fail(`Twilio rejected the credentials: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function checkGemini(): Promise<void> {
  console.log("\nGemini Live (same session setup as a real call)");
  if (!process.env.GEMINI_API_KEY) return fail("No GEMINI_API_KEY");
  const { openGeminiSession, MODEL } = await import("../src/services/gemini/liveSession");
  console.log(`  model: ${MODEL}`);
  let audioChunks = 0;
  let error: string | null = null;
  let onClosed!: () => void;
  const closedEarly = new Promise<"closed">((resolve) => { onClosed = () => resolve("closed"); });
  const timeout = (ms: number) => new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms));

  const opening = openGeminiSession({
    onAudio: () => { audioChunks++; },
    onError: (err) => { error = err.message; onClosed(); },
    onClose: () => onClosed(),
  }).catch((err) => { error = err instanceof Error ? err.message : String(err); return null; });

  // connect() can stay pending forever when Gemini rejects the key, so also race the close callback
  const first = await Promise.race([opening, closedEarly, timeout(15000)]);
  if (first === "closed" || error) {
    return fail(`Gemini closed the session during setup${error ? `: ${error}` : ""}. See the [gemini] line above for the code and reason.`);
  }
  if (first === "timeout" || first === null) return fail("Timed out opening the session (15s). Check your network and the model name.");
  ok("Session opened");

  const handle = first;
  await Promise.race([timeout(8000), closedEarly]);
  handle.close();
  if (error) fail(`Session error: ${error}`);
  else if (audioChunks === 0) fail("Session opened but produced no greeting audio in 8s (closed early, or the model did not answer)");
  else ok(`Greeting audio received (${audioChunks} chunks). The agent can speak.`);
}

async function main(): Promise<void> {
  await checkEnv();
  await checkMongo();
  await checkTwilio();
  await checkGemini();
  console.log(failures === 0 ? "\nAll checks passed. Run: npm run live\n" : `\n${failures} problem(s) found. Fix the ✗ lines above.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
