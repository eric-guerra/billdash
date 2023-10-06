import { describe, it, expect } from 'vitest';
import Stripe from 'stripe';
import { customerMrr, logoChurnRate, movements, nrr, prorationPreview, subMrr, Sub } from '../lib/billing';
import { handleStripeEvent, WebhookStore } from '../lib/webhooks';

const sub = (id: string, customerId: string, cents: number, extra: Partial<Sub> = {}, interval: 'month' | 'year' = 'month', quantity = 1): Sub =>
  ({ id, customerId, status: 'active', lines: [{ priceCents: cents, quantity, interval }], ...extra });

describe('MRR', () => {
  it('normalises intervals, quantities and discounts', () => {
    expect(subMrr(sub('a', 'c', 1200_00, {}, 'year'))).toBe(100_00);
    expect(subMrr(sub('a', 'c', 49_00, {}, 'month', 3))).toBe(147_00);
    expect(subMrr(sub('a', 'c', 100_00, { discountPercent: 20 }))).toBe(80_00);
    expect(subMrr(sub('a', 'c', 1200_00, { discountAmountCents: 120_00 }, 'year'))).toBe(90_00);
    expect(subMrr({ id: 'q', customerId: 'c', status: 'active', lines: [{ priceCents: 300_00, quantity: 1, interval: 'month', intervalCount: 3 }] })).toBe(100_00);
  });

  it('excludes trials and canceled, keeps past_due', () => {
    expect(subMrr(sub('a', 'c', 100_00, { status: 'trialing' }))).toBe(0);
    expect(subMrr(sub('a', 'c', 100_00, { status: 'canceled' }))).toBe(0);
    expect(subMrr(sub('a', 'c', 100_00, { status: 'past_due' }))).toBe(100_00);
  });

  it('computes the MRR bridge', () => {
    const prev = customerMrr([sub('1', 'A', 100_00), sub('2', 'B', 200_00), sub('3', 'C', 300_00), sub('4', 'D', 50_00)]);
    const curr = customerMrr([sub('1', 'A', 150_00), sub('2', 'B', 120_00), sub('5', 'E', 80_00), sub('6', 'F', 40_00), sub('4', 'D', 50_00)]);
    const m = movements(prev, curr, new Set(['F']));
    expect(m).toEqual({ new: 80_00, expansion: 50_00, contraction: -80_00, churn: -300_00, reactivation: 40_00, net: -210_00, startMrr: 650_00, endMrr: 440_00 });
    expect(m.startMrr + m.net).toBe(m.endMrr);
    expect(nrr(prev, curr)).toBeCloseTo(320 / 650, 6);
    expect(logoChurnRate(prev, curr)).toBe(0.25);
  });

  it('previews proration for a mid-cycle upgrade', () => {
    const p = prorationPreview(100_00, 300_00, new Date('2024-03-01T00:00:00Z'), new Date('2024-03-31T00:00:00Z'), new Date('2024-03-16T00:00:00Z'));
    expect(p).toEqual({ credit: -50_00, charge: 150_00, due: 100_00, fractionRemaining: 0.5 });
  });
});

function memStore() {
  const events = new Set<string>();
  const subs = new Map<string, any>();
  const invoices: any[] = [];
  const store: WebhookStore = {
    async claimEvent(id) { if (events.has(id)) return false; events.add(id); return true; },
    async releaseEvent(id) { events.delete(id); },
    async upsertSubscription(s) {
      const cur = subs.get(s.id);
      if (!cur || cur.updatedAt <= s.updatedAt) subs.set(s.id, s); // ignore out-of-order older events
    },
    async recordInvoice(i) { invoices.push(i); },
  };
  return { store, subs, invoices };
}

describe('Stripe webhooks', () => {
  const stripe = new Stripe('sk_test_dummy', { apiVersion: '2023-10-16' });
  const secret = 'whsec_test_secret';
  const signed = (payload: object) => {
    const body = JSON.stringify(payload);
    return { body, sig: stripe.webhooks.generateTestHeaderString({ payload: body, secret }) };
  };
  const subEvent = (id: string, type: string, created: number, status: string, qty = 1) => ({
    id, object: 'event', type, created, data: { object: {
      id: 'sub_1', object: 'subscription', customer: 'cus_1', status, cancel_at_period_end: false, current_period_end: 1712000000,
      items: { data: [{ quantity: qty, price: { id: 'price_pro', unit_amount: 4900, recurring: { interval: 'month' } } }] },
    } },
  });

  it('verifies, applies and dedupes', async () => {
    const { store, subs } = memStore();
    const { body, sig } = signed(subEvent('evt_1', 'customer.subscription.created', 1000, 'active'));
    expect(await handleStripeEvent(stripe, body, sig, secret, store)).toBe('processed');
    expect(await handleStripeEvent(stripe, body, sig, secret, store)).toBe('duplicate');
    expect(subs.get('sub_1')).toMatchObject({ customerId: 'cus_1', unitAmount: 4900, interval: 'month', status: 'active' });
  });

  it('rejects bad signatures', async () => {
    const { store } = memStore();
    const { body } = signed(subEvent('evt_x', 'customer.subscription.created', 1, 'active'));
    await expect(handleStripeEvent(stripe, body, 't=1,v1=deadbeef', secret, store)).rejects.toThrow();
  });

  it('an older event delivered late does not overwrite newer state', async () => {
    const { store, subs } = memStore();
    const newer = signed(subEvent('evt_2', 'customer.subscription.updated', 2000, 'active', 5));
    const older = signed(subEvent('evt_1', 'customer.subscription.updated', 1000, 'active', 2));
    await handleStripeEvent(stripe, newer.body, newer.sig, secret, store);
    await handleStripeEvent(stripe, older.body, older.sig, secret, store);
    expect(subs.get('sub_1').quantity).toBe(5);
  });

  it('records invoices and releases the claim on failure so Stripe can retry', async () => {
    const { store, invoices } = memStore();
    const inv = { id: 'evt_9', object: 'event', type: 'invoice.paid', created: 5, data: { object: {
      id: 'in_1', object: 'invoice', customer: 'cus_1', subscription: 'sub_1', amount_paid: 4900, amount_due: 4900, status_transitions: { paid_at: 1711000000 } } } };
    const { body, sig } = signed(inv);
    const failing = { ...store, recordInvoice: async () => { throw new Error('db down'); } };
    await expect(handleStripeEvent(stripe, body, sig, secret, failing)).rejects.toThrow('db down');
    expect(await handleStripeEvent(stripe, body, sig, secret, store)).toBe('processed');
    expect(invoices[0]).toMatchObject({ id: 'in_1', status: 'paid', amountPaid: 4900 });
  });
});
