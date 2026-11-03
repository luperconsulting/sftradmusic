import Stripe from "stripe";

export interface StripeKeys {
  secretKey: string;
  publishableKey: string;
}

/** Test-mode keys only. A live secret is treated as unavailable so safe mode cannot charge. */
export function stripeKeysFromEnv(env: Record<string, string | undefined>): StripeKeys | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim() ?? "";
  const publishableKey = env.VITE_STRIPE_PUBLISHABLE_KEY?.trim() ?? "";
  if (!secretKey.startsWith("sk_test_") || !publishableKey.startsWith("pk_test_")) return null;
  return { secretKey, publishableKey };
}

export interface CardSetupClient {
  customers: { create(input: { metadata: Record<string, string> }): Promise<{ id: string }> };
  setupIntents: { create(input: { customer: string; usage: "off_session"; payment_method_types: string[]; metadata: Record<string, string> }): Promise<{ id: string }> };
  checkout: { sessions: { create(input: { mode: "setup"; customer: string; success_url: string; cancel_url: string; metadata: Record<string, string> }): Promise<{ id: string; url: string | null }> } };
}

/**
 * Saves a card with a SetupIntent and a Checkout Session in setup mode.
 * Neither call includes an amount, so nothing is charged.
 */
export async function createCardSetup(input: {
  keys: StripeKeys | null;
  safeMode: boolean;
  studentId: string;
  appUrl: string;
  stripe?: CardSetupClient;
}) {
  if (!input.safeMode) {
    console.info("[autopay] refused card setup outside safe mode. Nothing was charged.");
    return { available: false as const, charged: false as const, url: null, setupIntentId: null };
  }
  if (!input.keys || !input.keys.secretKey.startsWith("sk_test_") || !input.keys.publishableKey.startsWith("pk_test_")) {
    if (input.keys) console.info("[autopay] safe mode ignored a non-test Stripe key. Nothing was charged.");
    return { available: false as const, charged: false as const, url: null, setupIntentId: null };
  }
  const stripe = input.stripe ?? new Stripe(input.keys.secretKey);
  const customer = await stripe.customers.create({ metadata: { studentId: input.studentId, portal: "preview" } });
  const setupIntent = await stripe.setupIntents.create({
    customer: customer.id,
    usage: "off_session",
    payment_method_types: ["card"],
    metadata: { studentId: input.studentId },
  });
  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: customer.id,
    success_url: `${input.appUrl.replace(/\/$/, "")}/portal?card=saved`,
    cancel_url: `${input.appUrl.replace(/\/$/, "")}/portal`,
    metadata: { studentId: input.studentId, setupIntentId: setupIntent.id },
  });
  console.info(`[autopay] safe mode: opened Stripe test Checkout in setup mode for student ${input.studentId}. Nothing was charged.`);
  return { available: true as const, charged: false as const, url: session.url, setupIntentId: setupIntent.id };
}
