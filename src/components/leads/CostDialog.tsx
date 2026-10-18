/**
 * Echo Leads — the confirmation in front of every paid bulk action
 * ---------------------------------------------------------------------------
 * One dialog for re-verify, find emails, find phones and company details, so
 * every paid action shows the same four things before it starts: how many of the
 * selection will actually be worked (and why the rest will not), what it is
 * expected to cost, the most it can cost, and what the wallet can cover.
 *
 * The maximum is what is checked against the balance. The worker reserves the
 * worst case per chunk and settles what was earned, so a miss is never charged -
 * but a run whose worst case the wallet cannot cover is refused at the start
 * rather than paused halfway.
 */
import React from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from './Screen';
import { Modal } from './Dialogs';
import { formatCredits } from '../../lib/billing';
import { errorCopy, skippedCopy, newRequestId, type EnrichEstimate, type StartResult } from '../../lib/leads-db';
import { fetchBalance } from '../../lib/billing';

export const CostDialog: React.FC<{
  title: string;
  /** One sentence on what will happen, in the user's terms. */
  description: string;
  getEstimate: (refresh: boolean) => Promise<EnrichEstimate>;
  start: (requestId: string, refresh: boolean) => Promise<StartResult>;
  /** Offer "include ones checked recently". */
  allowRefresh?: boolean;
  onStarted: (runId: string) => void;
  onClose: () => void;
}> = ({ title, description, getEstimate, start, allowRefresh = false, onStarted, onClose }) => {
  const [refresh, setRefresh] = React.useState(false);
  const [est, setEst] = React.useState<EnrichEstimate | null>(null);
  const [available, setAvailable] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // One id per dialog: pressing Start twice, or a retried request, is the same
  // request and gets the same run back rather than a second charge.
  const requestId = React.useRef(newRequestId());

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([getEstimate(refresh), fetchBalance().catch(() => null)])
      .then(([e, bal]) => {
        if (cancelled) return;
        if (!e.ok) setError(errorCopy(e.error));
        setEst(e);
        const a = e.available ?? (bal?.wallet ? Number(bal.wallet.available ?? bal.wallet.balance - bal.wallet.reserved) : null);
        setAvailable(Number.isFinite(a as number) ? (a as number) : null);
      })
      .catch((err) => !cancelled && setError((err as Error)?.message ?? 'Could not price this.'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // getEstimate is supplied fresh each render by the caller; refresh is the input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const max = est?.estimate?.max_credits ?? null;
  const short = max !== null && available !== null && available < max;
  const nothing = est?.ok && est.eligible === 0;

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await start(requestId.current, refresh);
      if (!r.ok || !r.run) {
        setError(r.message ?? errorCopy(r.error));
        return;
      }
      onStarted(r.run.id);
    } catch (err) {
      setError((err as Error)?.message ?? 'Could not start.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void go()} disabled={loading || busy || !est?.ok || nothing || short}>
            {busy ? 'Starting…' : max !== null ? `Start · up to ${formatCredits(max)} credits` : 'Start'}
          </Button>
        </>
      }
    >
          <p className="text-xs font-mono text-ink-2 leading-relaxed">{description}</p>

          {loading ? (
            <div className="flex items-center gap-2 text-xs font-mono text-muted">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Pricing…
            </div>
          ) : est?.ok ? (
            <>
              <div className="text-xs font-mono text-ink">
                <span className="tabular-nums font-medium">{est.eligible}</span> of{' '}
                <span className="tabular-nums">{est.selected}</span> selected will be worked.
                {skippedCopy(est.skipped).length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 text-muted">
                    {skippedCopy(est.skipped).map((s) => (
                      <li key={s}>· {s}</li>
                    ))}
                  </ul>
                )}
              </div>

              {allowRefresh && (
                <label className="flex items-center gap-2 text-xs font-mono text-ink-2 cursor-pointer select-none">
                  <input type="checkbox" checked={refresh} onChange={(e) => setRefresh(e.target.checked)} />
                  Refresh ones checked recently as well
                </label>
              )}

              {est.estimate && est.estimate.ok !== false && (
                <div className="border border-line-soft">
                  <div className="grid grid-cols-3 divide-x divide-line-soft">
                    <Cell label="Expected" value={est.estimate.expected_credits} />
                    <Cell label="At most" value={est.estimate.max_credits} />
                    <Cell label="Available" value={available} tone={short ? 'bad' : undefined} />
                  </div>
                  {est.estimate.breakdown && est.estimate.breakdown.length > 0 && (
                    <ul className="border-t border-line-soft px-3 py-2 space-y-1">
                      {est.estimate.breakdown.map((b) => (
                        <li key={b.label} className="flex justify-between gap-3 text-[11px] font-mono text-ink-2">
                          <span>
                            {b.label}
                            {b.note && <span className="text-muted"> · {b.note}</span>}
                          </span>
                          <span className="tabular-nums">{formatCredits(b.credits)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <p className="text-[11px] font-mono text-muted leading-relaxed">
                Credits are held for the maximum while it runs and only what is found is charged; the rest is
                released. A lookup that finds nothing costs nothing.
              </p>

              {short && (
                <div className="flex items-start gap-2 text-xs font-mono text-warn bg-warn-bg border border-warn-line px-3 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span>
                    The balance does not cover the maximum.{' '}
                    <a href="#dashboard/billing" className="underline">Top up</a> or select fewer.
                  </span>
                </div>
              )}
            </>
          ) : null}

          {error && <div className="text-xs font-mono text-danger">{error}</div>}
    </Modal>
  );
};

const Cell: React.FC<{ label: string; value: number | null; tone?: 'bad' }> = ({ label, value, tone }) => (
  <div className="px-3 py-2">
    <div className="text-[10px] font-mono uppercase tracking-wider text-muted">{label}</div>
    <div className={`text-sm font-mono tabular-nums ${tone === 'bad' ? 'text-danger' : 'text-ink'}`}>
      {value === null ? '—' : formatCredits(value)}
    </div>
  </div>
);
