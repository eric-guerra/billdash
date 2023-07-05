// SaaS billing metrics. All money in integer cents; MRR is always monthly-normalised.

export type Interval = 'month' | 'year';

export interface SubLine {
  priceCents: number; // per unit per interval
  quantity: number;
  interval: Interval;
  intervalCount?: number; // e.g. 3 = quarterly
}

export interface Sub {
  id: string;
  customerId: string;
  status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused';
  lines: SubLine[];
  /** Percent-off coupon applying forever / repeating; amount-off is converted per interval. */
  discountPercent?: number;
  discountAmountCents?: number; // per interval, applied to the subscription total
}

/** Statuses that count toward MRR. Trials don't (no money yet); past_due still does until it churns. */
const COUNTS = new Set<Sub['status']>(['active', 'past_due']);

export function lineMrr(l: SubLine): number {
  const months = (l.interval === 'year' ? 12 : 1) * (l.intervalCount ?? 1);
  return (l.priceCents * l.quantity) / months;
}

export function subMrr(s: Sub): number {
  if (!COUNTS.has(s.status)) return 0;
  const gross = s.lines.reduce((sum, l) => sum + lineMrr(l), 0);
  const months = s.lines[0] ? (s.lines[0].interval === 'year' ? 12 : 1) * (s.lines[0].intervalCount ?? 1) : 1;
  let net = gross * (1 - (s.discountPercent ?? 0) / 100) - (s.discountAmountCents ?? 0) / months;
  return Math.max(0, Math.round(net));
}

export function customerMrr(subs: Sub[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of subs) m.set(s.customerId, (m.get(s.customerId) ?? 0) + subMrr(s));
  return m;
}

export interface Movements {
  new: number;
  expansion: number;
  contraction: number;
  churn: number;
  reactivation: number;
  net: number;
  startMrr: number;
  endMrr: number;
}

/**
 * MRR bridge between two months. `everPaid` = customers who had MRR at any point before `prev`
 * (distinguishes reactivation from new).
 */
export function movements(prev: Map<string, number>, curr: Map<string, number>, everPaid: Set<string>): Movements {
  const m: Movements = { new: 0, expansion: 0, contraction: 0, churn: 0, reactivation: 0, net: 0, startMrr: 0, endMrr: 0 };
  const ids = new Set([...prev.keys(), ...curr.keys()]);
  for (const id of ids) {
    const a = prev.get(id) ?? 0;
    const b = curr.get(id) ?? 0;
    m.startMrr += a;
    m.endMrr += b;
    if (a === 0 && b > 0) everPaid.has(id) ? (m.reactivation += b) : (m.new += b);
    else if (a > 0 && b === 0) m.churn -= a;
    else if (b > a) m.expansion += b - a;
    else if (b < a) m.contraction -= a - b;
  }
  m.net = m.new + m.expansion + m.contraction + m.churn + m.reactivation;
  return m;
}

/** Net revenue retention over the period for customers who were paying at the start. */
export function nrr(prev: Map<string, number>, curr: Map<string, number>): number | null {
  let start = 0, end = 0;
  for (const [id, a] of prev) {
    if (a <= 0) continue;
    start += a;
    end += curr.get(id) ?? 0;
  }
  return start ? end / start : null;
}

export function logoChurnRate(prev: Map<string, number>, curr: Map<string, number>): number | null {
  const paying = [...prev].filter(([, v]) => v > 0).map(([k]) => k);
  if (!paying.length) return null;
  return paying.filter((id) => !(curr.get(id) ?? 0)).length / paying.length;
}

/**
 * Mid-cycle plan change preview (what Stripe will invoice with proration_behavior=create_prorations):
 * credit for unused time on the old price, charge for remaining time on the new one.
 */
export function prorationPreview(oldCents: number, newCents: number, periodStart: Date, periodEnd: Date, changeAt: Date) {
  const total = periodEnd.getTime() - periodStart.getTime();
  const remaining = Math.max(0, periodEnd.getTime() - changeAt.getTime());
  if (total <= 0) throw new Error('invalid period');
  const frac = remaining / total;
  const credit = -Math.round(oldCents * frac);
  const charge = Math.round(newCents * frac);
  return { credit, charge, due: credit + charge, fractionRemaining: Math.round(frac * 10_000) / 10_000 };
}

export const formatUsd = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);
