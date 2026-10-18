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
import { Loader2 } from 'lucide-react';
import { Button } from './Screen';
import { Modal } from './Dialogs';
import { formatCredits } from '../../lib/billing';
import { errorCopy, skippedCopy, newRequestId, type EnrichEstimate, type StartResult } from '../../lib/leads-db';
import { fetchBalance } from '../../lib/billing';
import { PriceSummary } from './PriceSummary';

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
                <PriceSummary
                  expected={est.estimate.expected_credits}
                  max={est.estimate.max_credits}
                  available={available}
                  breakdown={est.estimate.breakdown}
                  note="Credits are held for the maximum while it runs and only what is found is charged; the rest is released. A lookup that finds nothing costs nothing."
                />
              )}
            </>
          ) : null}

          {error && <div className="text-xs font-mono text-danger">{error}</div>}
    </Modal>
  );
};
