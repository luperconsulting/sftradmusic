// Stripe Checkout in TEST MODE only, used when CARD_PAYMENTS_ENABLED=true. Live keys are ignored everywhere.
// No customers are saved and there is no autopay: each Checkout pays one invoice's amount due.
import Stripe from "stripe";

export interface StripeKeys {
  secretKey: string;
  publishableKey: string;
}

/** Test-mode keys only. A live key is treated as unavailable, so nothing real can be charged. */
export function stripeKeysFromEnv(env: Record<string, string | undefined>): StripeKeys | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim() ?? "";
  const publishableKey = env.VITE_STRIPE_PUBLISHABLE_KEY?.trim() ?? "";
  if (!secretKey.startsWith("sk_test_") || !publishableKey.startsWith("pk_test_")) return null;
  return { secretKey, publishableKey };
}

export interface CheckoutClient {
  createSession(input: { invoiceId: string; invoiceNumber: number; amountCents: number; label: string; successUrl: string; cancelUrl: string }): Promise<{ id: string; url: string | null }>;
  /** Verifies the Stripe-Signature header against the raw body. Throws on any mismatch. */
  verifyEvent(rawBody: Buffer, signature: string, webhookSecret: string): { id: string; type: string; data: { object: any } };
}

export function createStripeCheckout(keys: StripeKeys): CheckoutClient {
  if (!keys.secretKey.startsWith("sk_test_")) throw new Error("stripe: test keys only");
  const stripe = new Stripe(keys.secretKey);
  return {
    async createSession(input) {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: input.amountCents, product_data: { name: `${input.label} · Invoice #${input.invoiceNumber}` } } }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.invoiceId,
        metadata: { invoice_id: input.invoiceId },
        payment_intent_data: { metadata: { invoice_id: input.invoiceId } },
      });
      return { id: session.id, url: session.url };
    },
    verifyEvent(rawBody, signature, webhookSecret) {
      return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret) as unknown as { id: string; type: string; data: { object: any } };
    },
  };
}
