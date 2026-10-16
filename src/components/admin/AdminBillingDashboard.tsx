import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import {
  formatCredits,
  formatUsd,
  ledgerLabel,
  type LedgerRow,
  type OperationPrice,
} from '../../lib/credits';
import { useAuth } from '../../context/AuthContext';
import { ArrowDownRight, ArrowUpRight, RefreshCw, Settings2 } from 'lucide-react';

interface Summary {
  collected_usd: number;
  fees_usd: number;
  refunded_usd: number;
  net_cash_usd: number;
  credits_granted: number;
  credits_consumed: number;
  credits_outstanding: number;
  deferred_revenue_usd: number;
  recognised_usd: number;
  service_cost_usd: number;
  realised_profit_usd: number;
  realised_margin_pct: number | null;
  cash_after_cost_usd: number;
  reconciliation_delta_usd: number;
  topups: number;
  subscriptions: number;
  refunds: number;
  provider_calls: number;
  credits_per_usd: number;
}

interface UserRow {
  user_id: string;
  name: string;
  subscription_plan: string;
  credits_balance: number;
  paid_usd: number;
  fees_usd: number;
  credits_bought: number;
  credits_consumed: number;
  credits_outstanding: number;
  deferred_revenue_usd: number;
  recognised_usd: number;
  service_cost_usd: number;
  realised_profit_usd: number;
  cash_after_cost_usd: number;
  provider_calls: number;
}

interface OperationRow {
  operation: string;
  label: string;
  events: number;
  calls: number;
  credits: number;
  revenue_usd: number;
  service_cost_usd: number;
  profit_usd: number;
  margin_pct: number | null;
}

interface MonthRow {
  month: string;
  collected_usd: number;
  fees_usd: number;
  service_cost_usd: number;
  recognised_usd: number;
  credits_consumed: number;
}

const num = (v: unknown) => Number(v ?? 0);

/**
 * Reads a view through the service role. billing_summary aggregates every
 * user's money, so the view is granted to service_role only and never to
 * authenticated. That means the admin dashboard has to be served by an edge
 * function rather than queried straight from the browser -- otherwise granting
 * it here would hand every user the whole company's revenue.
 */
const AdminBilling: React.FC = () => {
  const { user } = useAuth();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [operations, setOperations] = useState<OperationRow[]>([]);
  const [months, setMonths] = useState<MonthRow[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [pricing, setPricing] = useState<Record<string, OperationPrice> | null>(null);
  const [rate, setRate] = useState<number>(20);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);

    try {
      if (!supabase) {
        setError('Not connected to a Supabase project.');
        setLoading(false);
        return;
      }

      // SECURITY DEFINER reader. The browser never receives the service role
      // key, so the aggregate view stays unreachable to it.
      const { data, error: rpcErr } = await supabase.rpc('admin_billing_snapshot');

      if (rpcErr) {
        setError(rpcErr.message);
        setLoading(false);
        return;
      }

      const snap = data ?? {};
      setSummary(snap.summary ?? null);
      setUsers(snap.users ?? []);
      setOperations(snap.operations ?? []);
      setMonths(snap.months ?? []);
      setLedger(snap.ledger ?? []);
      setPricing(snap.operation_pricing ?? null);
      setRate(Number(snap.credits_per_usd ?? 20));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  const reconciliationOk = useMemo(
    () => summary !== null && Math.abs(summary.reconciliation_delta_usd) < 0.01,
    [summary],
  );

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto py-16 text-center">
        <p className="text-xs font-mono text-[#8a8a86]">Loading billing…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-6xl mx-auto py-16 text-center space-y-2">
        <p className="text-sm font-mono text-red-600">{error}</p>
        <p className="text-[11px] font-mono text-[#8a8a86]">
          The admin reader is a SECURITY DEFINER function granted to service_role.
          An authenticated browser cannot call it by design.
        </p>
      </div>
    );
  }

  const s = summary;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-[#141414]">
            Billing &amp; Profit
          </h2>
          <p className="text-[11px] font-mono text-[#8a8a86] mt-1">
            Cash collected is not profit. Revenue is recognised as credits are spent.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-2 px-3 py-2 border border-[#e3e3de] bg-white text-[11px] font-mono text-[#4a4a47] hover:bg-[#f6f6f4] cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {/* ---- the headline distinction ---------------------------------- */}
      <section className="bg-white border border-[#141414]">
        <header className="px-6 py-4 border-b border-[#eeeeea] flex items-center justify-between">
          <h3 className="text-sm font-bold text-[#141414]">
            Where the money actually is
          </h3>
          <span
            className={`text-[10px] font-mono px-2 py-0.5 border font-medium ${
              reconciliationOk
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-red-300 bg-red-50 text-red-700'
            }`}
          >
            {reconciliationOk ? 'Ledger reconciles' : 'Ledger mismatch'}
          </span>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-[#eeeeea]">
          <div className="p-6">
            <p className="text-[10px] font-mono uppercase tracking-wide text-[#8a8a86]">
              Net cash collected
            </p>
            <p className="text-2xl font-bold text-[#141414] mt-1">
              {formatUsd(s?.net_cash_usd)}
            </p>
            <dl className="mt-3 space-y-1 text-[11px] font-mono">
              <div className="flex justify-between">
                <dt className="text-[#8a8a86]">Gross received</dt>
                <dd className="text-[#141414]">{formatUsd(s?.collected_usd)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[#8a8a86]">Gateway fees</dt>
                <dd className="text-red-600">-{formatUsd(s?.fees_usd)}</dd>
              </div>
              {num(s?.refunds) > 0 && (
                <div className="flex justify-between">
                  <dt className="text-[#8a8a86]">Refunds ({s?.refunds})</dt>
                  <dd className="text-red-600">-{formatUsd(s?.refunded_usd)}</dd>
                </div>
              )}
            </dl>
          </div>

          <div className="p-6 bg-amber-50/40">
            <p className="text-[10px] font-mono uppercase tracking-wide text-amber-700">
              Deferred revenue (liability)
            </p>
            <p className="text-2xl font-bold text-amber-900 mt-1">
              {formatUsd(s?.deferred_revenue_usd)}
            </p>
            <p className="mt-3 text-[11px] font-mono text-amber-800 leading-relaxed">
              {formatCredits(s?.credits_outstanding)} credits are paid for but not yet
              spent. This is cash you hold against future work, not profit.
            </p>
          </div>

          <div className="p-6 bg-emerald-50/40">
            <p className="text-[10px] font-mono uppercase tracking-wide text-emerald-700">
              Realised profit
            </p>
            <p className="text-2xl font-bold text-emerald-900 mt-1">
              {formatUsd(s?.realised_profit_usd)}
            </p>
            <dl className="mt-3 space-y-1 text-[11px] font-mono">
              <div className="flex justify-between">
                <dt className="text-[#8a8a86]">Recognised revenue</dt>
                <dd className="text-[#141414]">{formatUsd(s?.recognised_usd)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[#8a8a86]">Service cost</dt>
                <dd className="text-red-600">-{formatUsd(s?.service_cost_usd, 4)}</dd>
              </div>
              {s?.realised_margin_pct != null && (
                <div className="flex justify-between">
                  <dt className="text-[#8a8a86]">Margin</dt>
                  <dd className="text-emerald-700 font-semibold">
                    {s.realised_margin_pct}%
                  </dd>
                </div>
              )}
            </dl>
          </div>
        </div>

        {s && (
          <footer className="px-6 py-3 border-t border-[#eeeeea] bg-[#fbfbfa]">
            <p className="text-[11px] font-mono text-[#8a8a86] leading-relaxed">
              Recognised {formatUsd(s.recognised_usd)} + deferred{' '}
              {formatUsd(s.deferred_revenue_usd)} = net cash {formatUsd(s.net_cash_usd)}
              {Math.abs(s.reconciliation_delta_usd) >= 0.01 && (
                <span className="text-red-600">
                  {' '}
                  — off by {formatUsd(s.reconciliation_delta_usd)}
                </span>
              )}
            </p>
          </footer>
        )}
      </section>

      {/* ---- volumes ---------------------------------------------------- */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-[#e3e3de] border border-[#e3e3de]">
        {[
          { label: 'Credits sold', value: formatCredits(s?.credits_granted) },
          { label: 'Credits consumed', value: formatCredits(s?.credits_consumed) },
          { label: 'Credits outstanding', value: formatCredits(s?.credits_outstanding) },
          { label: 'Provider calls', value: (s?.provider_calls ?? 0).toLocaleString() },
          { label: 'Top-ups', value: String(s?.topups ?? 0) },
          { label: 'Subscriptions', value: String(s?.subscriptions ?? 0) },
          { label: 'Refund value', value: formatUsd(s?.refunded_usd) },
          { label: 'Credits per $1', value: String(s?.credits_per_usd ?? '—') },
        ].map((tile) => (
          <div key={tile.label} className="bg-white px-4 py-3">
            <p className="text-[10px] font-mono uppercase tracking-wide text-[#8a8a86]">
              {tile.label}
            </p>
            <p className="text-sm font-bold text-[#141414] mt-0.5">{tile.value}</p>
          </div>
        ))}
      </section>

      {/* ---- cost and margin per operation ------------------------------ */}
      <section className="bg-white border border-[#e3e3de]">
        <header className="px-6 py-4 border-b border-[#eeeeea] flex items-center gap-2">
          <Settings2 className="w-4 h-4 text-[#141414]" />
          <h3 className="text-sm font-bold text-[#141414]">
            Profit by operation
          </h3>
        </header>

        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-[#8a8a86] text-left border-b border-[#eeeeea]">
                <th className="px-6 py-2 font-normal">Operation</th>
                <th className="px-3 py-2 font-normal text-right">Calls</th>
                <th className="px-3 py-2 font-normal text-right">Credits</th>
                <th className="px-3 py-2 font-normal text-right">Revenue</th>
                <th className="px-3 py-2 font-normal text-right">Cost</th>
                <th className="px-3 py-2 font-normal text-right">Profit</th>
                <th className="px-6 py-2 font-normal text-right">Margin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f6f6f4]">
              {operations.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-6 py-6 text-[#8a8a86]">
                    No usage recorded yet.
                  </td>
                </tr>
              )}
              {operations.map((row) => (
                <tr key={row.operation} className="text-[#141414]">
                  <td className="px-6 py-2">{row.label}</td>
                  <td className="px-3 py-2 text-right">{num(row.calls).toLocaleString()}</td>
                  <td className="px-3 py-2 text-right">{formatCredits(row.credits)}</td>
                  <td className="px-3 py-2 text-right">{formatUsd(row.revenue_usd, 4)}</td>
                  <td className="px-3 py-2 text-right text-red-600">
                    {formatUsd(row.service_cost_usd, 4)}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold">
                    {formatUsd(row.profit_usd, 4)}
                  </td>
                  <td
                    className={`px-6 py-2 text-right font-semibold ${
                      (row.margin_pct ?? 0) >= 0 ? 'text-emerald-700' : 'text-red-600'
                    }`}
                  >
                    {row.margin_pct != null ? `${row.margin_pct}%` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {pricing && (
          <footer className="px-6 py-3 border-t border-[#eeeeea] bg-[#fbfbfa]">
            <p className="text-[11px] font-mono text-[#8a8a86]">
              Credit prices (live from billing_config):{' '}
              {Object.entries(pricing)
                .map(([key, v]) => `${key.replace('sweep_call_', '')} ${v.credits}c`)
                .join(' · ')}
            </p>
          </footer>
        )}
      </section>

      {/* ---- per workspace ---------------------------------------------- */}
      <section className="bg-white border border-[#e3e3de]">
        <header className="px-6 py-4 border-b border-[#eeeeea]">
          <h3 className="text-sm font-bold text-[#141414]">Revenue and profit per workspace</h3>
        </header>

        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-[#8a8a86] text-left border-b border-[#eeeeea]">
                <th className="px-6 py-2 font-normal">Workspace</th>
                <th className="px-3 py-2 font-normal">Plan</th>
                <th className="px-3 py-2 font-normal text-right">Paid</th>
                <th className="px-3 py-2 font-normal text-right">Credits left</th>
                <th className="px-3 py-2 font-normal text-right">Deferred</th>
                <th className="px-3 py-2 font-normal text-right">Cost</th>
                <th className="px-3 py-2 font-normal text-right">Realised</th>
                <th className="px-6 py-2 font-normal text-right">Cash after cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f6f6f4]">
              {users.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-6 py-6 text-[#8a8a86]">
                    No workspaces yet.
                  </td>
                </tr>
              )}
              {users.map((row) => (
                <tr key={row.user_id} className="text-[#141414]">
                  <td className="px-6 py-2">
                    {row.name || <span className="text-[#8a8a86]">unnamed</span>}
                  </td>
                  <td className="px-3 py-2 text-[#4a4a47]">{row.subscription_plan}</td>
                  <td className="px-3 py-2 text-right">{formatUsd(row.paid_usd)}</td>
                  <td className="px-3 py-2 text-right">{formatCredits(row.credits_balance)}</td>
                  <td className="px-3 py-2 text-right text-amber-700">
                    {formatUsd(row.deferred_revenue_usd)}
                  </td>
                  <td className="px-3 py-2 text-right text-red-600">
                    {formatUsd(row.service_cost_usd, 4)}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold">
                    {formatUsd(row.realised_profit_usd, 4)}
                  </td>
                  <td className="px-6 py-2 text-right">
                    {formatUsd(row.cash_after_cost_usd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- monthly ----------------------------------------------------- */}
      <section className="bg-white border border-[#e3e3de]">
        <header className="px-6 py-4 border-b border-[#eeeeea]">
          <h3 className="text-sm font-bold text-[#141414]">By month</h3>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-[#8a8a86] text-left border-b border-[#eeeeea]">
                <th className="px-6 py-2 font-normal">Month</th>
                <th className="px-3 py-2 font-normal text-right">Collected</th>
                <th className="px-3 py-2 font-normal text-right">Fees</th>
                <th className="px-3 py-2 font-normal text-right">Recognised</th>
                <th className="px-3 py-2 font-normal text-right">Service cost</th>
                <th className="px-6 py-2 font-normal text-right">Profit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f6f6f4]">
              {months.map((m) => {
                const profit = num(m.recognised_usd) - num(m.service_cost_usd);
                return (
                  <tr key={m.month}>
                    <td className="px-6 py-2">{m.month}</td>
                    <td className="px-3 py-2 text-right">{formatUsd(m.collected_usd)}</td>
                    <td className="px-3 py-2 text-right text-red-600">
                      {formatUsd(m.fees_usd)}
                    </td>
                    <td className="px-3 py-2 text-right">{formatUsd(m.recognised_usd)}</td>
                    <td className="px-3 py-2 text-right text-red-600">
                      {formatUsd(m.service_cost_usd, 4)}
                    </td>
                    <td
                      className={`px-6 py-2 text-right font-semibold ${
                        profit >= 0 ? 'text-emerald-700' : 'text-red-600'
                      }`}
                    >
                      {formatUsd(profit, 4)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- ledger ------------------------------------------------------ */}
      <section className="bg-white border border-[#e3e3de]">
        <header className="px-6 py-4 border-b border-[#eeeeea]">
          <h3 className="text-sm font-bold text-[#141414]">Recent ledger activity</h3>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-[#8a8a86] text-left border-b border-[#eeeeea]">
                <th className="px-6 py-2 font-normal">When</th>
                <th className="px-3 py-2 font-normal">Entry</th>
                <th className="px-3 py-2 font-normal text-right">Credits</th>
                <th className="px-3 py-2 font-normal text-right">Balance</th>
                <th className="px-3 py-2 font-normal text-right">Revenue</th>
                <th className="px-6 py-2 font-normal text-right">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f6f6f4]">
              {ledger.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-6 text-[#8a8a86]">
                    Ledger is empty.
                  </td>
                </tr>
              )}
              {ledger.map((row) => (
                <tr key={row.id}>
                  <td className="px-6 py-2 text-[#8a8a86]">
                    {new Date(row.created_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">{ledgerLabel(row)}</td>
                  <td
                    className={`px-3 py-2 text-right font-semibold inline-flex items-center gap-1 ${
                      num(row.delta) >= 0 ? 'text-emerald-700' : 'text-[#141414]'
                    }`}
                  >
                    {num(row.delta) >= 0 ? (
                      <ArrowUpRight className="w-3 h-3" />
                    ) : (
                      <ArrowDownRight className="w-3 h-3" />
                    )}
                    {formatCredits(Math.abs(num(row.delta)))}
                  </td>
                  <td className="px-3 py-2 text-right">{formatCredits(row.balance_after)}</td>
                  <td className="px-3 py-2 text-right">{formatUsd(row.revenue_usd, 4)}</td>
                  <td className="px-6 py-2 text-right text-red-600">
                    {formatUsd(row.service_cost_usd, 4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-[11px] font-mono text-[#8a8a86] leading-relaxed">
        Conversion rate is {rate} credits per US dollar. Unspent credits are carried as
        deferred revenue at the price actually paid for them, so a top-up that carried a
        card fee is not valued at the pre-fee list price.
      </p>
    </div>
  );
};

export { AdminBilling };
