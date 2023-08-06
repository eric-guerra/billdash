import { prisma } from '@/lib/db';
import { formatUsd, logoChurnRate, movements, nrr } from '@/lib/billing';

export const dynamic = 'force-dynamic';

const monthKey = (d: Date) => d.toISOString().slice(0, 7);

async function snapshot(month: string) {
  const rows = await prisma.mrrSnapshot.findMany({ where: { month } });
  return new Map(rows.map((r) => [r.customerId, r.mrrCents]));
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export default async function Dashboard() {
  const now = new Date();
  const thisMonth = monthKey(now);
  const lastMonth = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  const [prev, curr, everPaidRows, pastDue] = await Promise.all([
    snapshot(lastMonth),
    snapshot(thisMonth),
    prisma.mrrSnapshot.findMany({ where: { month: { lt: lastMonth }, mrrCents: { gt: 0 } }, select: { customerId: true }, distinct: ['customerId'] }),
    prisma.subscription.findMany({ where: { status: 'past_due' }, include: { customer: true }, take: 20 }),
  ]);
  const m = movements(prev, curr, new Set(everPaidRows.map((r) => r.customerId)));
  const retention = nrr(prev, curr);
  const churn = logoChurnRate(prev, curr);
  const bridge: [string, number][] = [['New', m.new], ['Expansion', m.expansion], ['Reactivation', m.reactivation], ['Contraction', m.contraction], ['Churn', m.churn]];
  const maxAbs = Math.max(1, ...bridge.map(([, v]) => Math.abs(v)));

  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="text-2xl font-semibold">Revenue · {thisMonth}</h1>
      <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="MRR" value={formatUsd(m.endMrr)} hint={`${m.net >= 0 ? '+' : ''}${formatUsd(m.net)} vs ${lastMonth}`} />
        <Stat label="ARR" value={formatUsd(m.endMrr * 12)} />
        <Stat label="Net revenue retention" value={retention == null ? '–' : `${(retention * 100).toFixed(1)}%`} />
        <Stat label="Logo churn" value={churn == null ? '–' : `${(churn * 100).toFixed(1)}%`} />
      </div>
      <section className="mt-8 rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
        <h2 className="font-medium">MRR bridge</h2>
        <ul className="mt-3 space-y-2">
          {bridge.map(([label, v]) => (
            <li key={label} className="flex items-center gap-3 text-sm">
              <span className="w-28 text-slate-600">{label}</span>
              <span className={`h-3 rounded ${v >= 0 ? 'bg-emerald-500' : 'bg-rose-500'}`} style={{ width: `${(Math.abs(v) / maxAbs) * 60}%` }} />
              <span className="tabular-nums">{formatUsd(v)}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="mt-8 rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
        <h2 className="font-medium">Past due ({pastDue.length})</h2>
        <table className="mt-2 w-full text-sm">
          <tbody>
            {pastDue.map((s) => (
              <tr key={s.id} className="border-t border-slate-100">
                <td className="py-2">{s.customer.name}</td>
                <td className="tabular-nums">{formatUsd(s.unitAmount * s.quantity)}/{s.interval === 'year' ? 'yr' : 'mo'}</td>
                <td className="text-slate-500">renews {s.currentPeriodEnd.toISOString().slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
