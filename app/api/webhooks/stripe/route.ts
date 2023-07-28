import Stripe from 'stripe';
import { NextRequest, NextResponse } from 'next/server';
import { handleStripeEvent } from '@/lib/webhooks';
import { prismaStore } from '@/lib/db';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? 'sk_test_missing', { apiVersion: '2023-10-16' });

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature');
  if (!sig) return NextResponse.json({ error: 'missing signature' }, { status: 400 });
  const raw = await req.text(); // the exact bytes Stripe signed; never re-serialize JSON before verifying
  try {
    const outcome = await handleStripeEvent(stripe, raw, sig, process.env.STRIPE_WEBHOOK_SECRET!, prismaStore);
    return NextResponse.json({ outcome });
  } catch (e) {
    if (e instanceof Stripe.errors.StripeSignatureVerificationError) return NextResponse.json({ error: 'bad signature' }, { status: 400 });
    console.error('webhook failed', e);
    return NextResponse.json({ error: 'processing failed' }, { status: 500 }); // Stripe retries with backoff
  }
}
