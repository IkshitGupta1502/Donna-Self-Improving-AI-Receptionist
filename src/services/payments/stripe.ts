import Stripe from "stripe";
import { config } from "../../config";

let client: Stripe | null = null;

function getClient(): Stripe {
  if (!config.STRIPE_SECRET_KEY) throw new Error("Stripe is not configured.");
  if (!client) client = new Stripe(config.STRIPE_SECRET_KEY);
  return client;
}

export function stripeConfigured(): boolean {
  return !!config.STRIPE_SECRET_KEY;
}

export async function createPaymentRequestLink(input: {
  amountCents: number;
  description: string;
  metadata?: Record<string, string>;
}): Promise<string> {
  const stripe = getClient();
  const link = await stripe.paymentLinks.create({
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: input.description },
          unit_amount: input.amountCents,
        },
        quantity: 1,
      },
    ],
    // One-time link: it stops taking payments after the first completed checkout.
    restrictions: { completed_sessions: { limit: 1 } },
    after_completion: {
      type: "hosted_confirmation",
      hosted_confirmation: { custom_message: "Thanks! Your payment is confirmed." },
    },
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
  return link.url;
}
