# BillDash

Portfolio reference implementation of a 2023 project, built to show a subscription revenue dashboard for a B2B SaaS product. Stripe is the system of record; this app mirrors it through webhooks and shows MRR, ARR, NRR, churn and an MRR bridge.

**Stack:** Next.js 13 (app router, server components, route handlers), Prisma 5 + PostgreSQL, Tailwind CSS, Stripe Node SDK, Vitest.

## Metrics (`lib/billing.ts`)
- **MRR is monthly-normalised:**
  - Annual and quarterly prices are divided by their months; quantity is included.
  - Percent and amount-off discounts are applied per interval.
  - Trials don't count. `past_due` still counts until the subscription actually churns.
- **MRR bridge** between month-end snapshots: new, expansion, contraction, churn and reactivation. Reactivation means "paid before", which is different from new. The test asserts the bridge reconciles: start + net = end.
- **NRR** (revenue retained from customers paying at the start of the period) and **logo churn rate**.
- **Proration preview** for mid-cycle plan changes, matching Stripe's `create_prorations` behaviour: credit for unused time on the old price, charge for the remaining time on the new one.
- All money is integer cents.

## Webhooks (`lib/webhooks.ts`, `app/api/webhooks/stripe/route.ts`)
- Verifies the signature against the **raw request body** (`constructEvent`, 5-minute tolerance), then dedupes on the event id with a unique insert.
- If processing fails, the claim is released, so Stripe's retry gets another chance instead of being treated as a duplicate.
- **Out-of-order safe:** a subscription row carries the Stripe *event* time. An older event delivered late never overwrites newer state (`updateMany ... where updatedAt <= eventTime`).
- Handles `customer.subscription.{created,updated,deleted}` and `invoice.{paid,payment_failed}`.

## Dashboard
`/dashboard` is a server component that queries Prisma directly. It shows:
- Tiles for MRR, ARR, NRR and churn.
- A bar breakdown of the MRR bridge.
- The past-due subscriptions list.

## Run and test
```bash
npm install
cp .env.example .env && npm run db:push
npm test             # 8 tests: MRR normalisation, bridge reconciliation, NRR/churn, proration, webhook verify/dedupe/ordering/retry
npm run build        # prisma generate + next build
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```
The webhook tests use real Stripe signatures from `stripe.webhooks.generateTestHeaderString`; no network is needed.
