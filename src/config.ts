import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || undefined);

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  GEMINI_API_KEY: z.string().min(1),
  TWILIO_ACCOUNT_SID: optionalString,
  TWILIO_AUTH_TOKEN: optionalString,
  TWILIO_PHONE_NUMBER: optionalString,
  STRIPE_SECRET_KEY: optionalString,
  PUBLIC_HOST: optionalString,
  DASHBOARD_TOKEN: optionalString,
  ALLOWED_ORIGINS: optionalString,
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Missing or invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

if (!config.TWILIO_AUTH_TOKEN) {
  console.warn("TWILIO_AUTH_TOKEN not set: skipping Twilio signature validation");
}
if (!config.STRIPE_SECRET_KEY) {
  console.warn("STRIPE_SECRET_KEY not set: send_payment_request will report itself unavailable");
}
