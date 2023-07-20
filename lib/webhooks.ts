import Stripe from 'stripe';

/** Storage operations the webhook needs; Prisma in the app, in-memory in tests. */
export interface WebhookStore {
  /** Insert the event id; returns false if it was already processed (Stripe retries and duplicates). */
  claimEvent(id: string, type: string): Promise<boolean>;
  releaseEvent(id: string): Promise<void>;
  upsertSubscription(s: {
    id: string; customerId: string; status: string; priceId: string; unitAmount: number; quantity: number;
    interval: 'month' | 'year'; currentPeriodEnd: Date; cancelAtPeriodEnd: boolean; updatedAt: Date;
  }): Promise<void>;
  recordInvoice(i: { id: string; customerId: string; subscriptionId: string | null; amountPaid: number; amountDue: number; status: string; paidAt: Date | null }): Promise<void>;
}

export type Outcome = 'processed' | 'duplicate' | 'ignored';

/**
 * Verify, dedupe and apply one Stripe event. Subscription state is taken from the event's object
 * (the latest state at send time); out-of-order delivery is handled by the store's
 * `updatedAt` guard (an older event never overwrites a newer one).
 */
export async function handleStripeEvent(stripe: Stripe, rawBody: string, signature: string, secret: string, store: WebhookStore): Promise<Outcome> {
  // Throws Stripe.errors.StripeSignatureVerificationError on a bad signature or a stale timestamp (5 min tolerance).
  const event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  if (!(await store.claimEvent(event.id, event.type))) return 'duplicate';
  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const s = event.data.object as Stripe.Subscription;
        const item = s.items.data[0];
        await store.upsertSubscription({
          id: s.id,
          customerId: typeof s.customer === 'string' ? s.customer : s.customer.id,
          status: event.type === 'customer.subscription.deleted' ? 'canceled' : s.status,
          priceId: item.price.id,
          unitAmount: item.price.unit_amount ?? 0,
          quantity: item.quantity ?? 1,
          interval: (item.price.recurring?.interval === 'year' ? 'year' : 'month'),
          currentPeriodEnd: new Date(s.current_period_end * 1000),
          cancelAtPeriodEnd: s.cancel_at_period_end,
          updatedAt: new Date(event.created * 1000),
        });
        return 'processed';
      }
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const i = event.data.object as Stripe.Invoice;
        await store.recordInvoice({
          id: i.id,
          customerId: typeof i.customer === 'string' ? i.customer : (i.customer as Stripe.Customer).id,
          subscriptionId: typeof i.subscription === 'string' ? i.subscription : i.subscription?.id ?? null,
          amountPaid: i.amount_paid,
          amountDue: i.amount_due,
          status: event.type === 'invoice.paid' ? 'paid' : 'payment_failed',
          paidAt: i.status_transitions?.paid_at ? new Date(i.status_transitions.paid_at * 1000) : null,
        });
        return 'processed';
      }
      default:
        return 'ignored';
    }
  } catch (e) {
    await store.releaseEvent(event.id); // let Stripe's retry try again
    throw e;
  }
}
