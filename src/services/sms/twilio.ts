import twilio from "twilio";
import { config } from "../../config";

let client: ReturnType<typeof twilio> | null = null;

function getClient(): ReturnType<typeof twilio> {
  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) throw new Error("Twilio SMS is not configured.");
  if (!client) client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
  return client;
}

export function smsConfigured(): boolean {
  return !!(config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && config.TWILIO_PHONE_NUMBER);
}

export async function sendSms(to: string, body: string): Promise<void> {
  if (!config.TWILIO_PHONE_NUMBER) throw new Error("TWILIO_PHONE_NUMBER is not set.");
  await getClient().messages.create({ to, from: config.TWILIO_PHONE_NUMBER, body });
}
