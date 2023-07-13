import { PrismaClient } from '@prisma/client';
import type { WebhookStore } from './webhooks';

const g = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = g.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') g.prisma = prisma; // survive dev hot-reload

export const prismaStore: WebhookStore = {
  async claimEvent(id, type) {
    try {
      await prisma.webhookEvent.create({ data: { id, type } });
      return true;
    } catch (e: any) {
      if (e?.code === 'P2002') return false; // unique violation: already processed
      throw e;
    }
  },
  async releaseEvent(id) {
    await prisma.webhookEvent.delete({ where: { id } }).catch(() => undefined);
  },
  async upsertSubscription(s) {
    await prisma.customer.upsert({ where: { id: s.customerId }, create: { id: s.customerId, name: s.customerId, email: '' }, update: {} });
    // Only apply if this event is newer than what we already have.
    const updated = await prisma.subscription.updateMany({ where: { id: s.id, updatedAt: { lte: s.updatedAt } }, data: s });
    if (updated.count === 0) {
      await prisma.subscription.create({ data: s }).catch((e: any) => {
        if (e?.code !== 'P2002') throw e; // exists with a newer updatedAt: keep it
      });
    }
  },
  async recordInvoice(i) {
    await prisma.invoice.upsert({ where: { id: i.id }, create: i, update: i });
  },
};
