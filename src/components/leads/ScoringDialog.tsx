/**
 * Echo Leads — scoring rules and duplicate review
 * ---------------------------------------------------------------------------
 * ScoringDialog   the workspace's fit rules: what counts, and how much. Saved
 *                 rules rescore every lead. Until saved, the rules shown are
 *                 seeded from the approved ideal customer profile.
 * DuplicatesDialog groups of records that look like the same person, and a
 *                 merge that keeps the record the user picks.
 */
import React from 'react';
import { X, Loader2 } from 'lucide-react';
import { Button } from './Screen';
import { ChipRow } from './ChipRow';
import { StatusBadge } from './StatusBadge';
import {
  getScoring, putScoring, findDuplicates, mergeContacts, errorCopy,
  type ScoringRules, type Contact,
} from '../../lib/leads-db';

const SENIORITIES = ['c_suite', 'founder', 'owner', 'partner', 'vp', 'head', 'director', 'manager', 'senior', 'entry'];

const Modal: React.FC<{ title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }> = ({
  title, onClose, children, footer, wide,
}) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4" role="dialog" aria-modal="true" aria-label={title}>
    <div className={`w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} max-h-[90vh] flex flex-col bg-white border border-line shadow-xl`}>
      <div className="flex items-center justify-between px-5 py-3 border-b border-line-soft">
        <h2 className="text-sm font-medium text-ink">{title}</h2>
        <button onClick={onClose} className="text-muted hover:text-ink cursor-pointer" aria-label="Close"><X className="w-4 h-4" /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-5 space-y-4">{children}</div>
      {footer && <div className="flex justify-end gap-2 px-5 py-3 border-t border-line-soft">{footer}</div>}
    </div>
  </div>
);

const Weight: React.FC<{ value: number; onChange: (n: number) => void; label: string }> = ({ value, onChange, label }) => (
  <label className="flex items-center gap-2 text-[11px] font-mono text-muted">
    weight
    <input
      type="number" min={0} max={100} value={value} aria-label={`${label} weight`}
      onChange={(e) => onChange(Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))))}
      className="w-14 px-1.5 py-0.5 border border-line text-ink tabular-nums"
    />
  </label>
);

export const ScoringDialog: React.FC<{ onClose: () => void; onSaved: () => void }> = ({ onClose, onSaved }) => {
  const [rules, setRules] = React.useState<ScoringRules | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    getScoring().then((r) => {
      if (r.ok) {
        setRules(r.rules);
        setSaved(r.saved);
      }
    }).catch((e) => setError((e as Error).message));
  }, []);

  const set = <K extends keyof ScoringRules>(k: K, v: ScoringRules[K]) => setRules((r) => (r ? { ...r, [k]: v } : r));

  const save = async () => {
    if (!rules) return;
    setBusy(true);
    setError(null);
    try {
      const r = await putScoring(rules);
      if (r.ok) {
        onSaved();
        onClose();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Scoring rules"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} disabled={!rules || busy}>{busy ? 'Rescoring…' : 'Save and rescore'}</Button>
        </>
      }
    >
      <p className="text-[11px] font-mono text-muted leading-relaxed">
        A score is how well a lead matches these rules, out of 100. Factors a lead has no data for are left out rather than
        counted against it; with too little data the lead shows "Not enough data" instead of a number.
        {!saved && ' These starting rules come from your ideal customer profile.'}
      </p>
      {!rules ? (
        <div className="text-xs font-mono text-muted flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1">
            <ChipRow boxed label="Target titles (contains)" values={rules.titles.include} onChange={(v) => set('titles', { ...rules.titles, include: v })} />
            <Weight label="Titles" value={rules.titles.weight} onChange={(n) => set('titles', { ...rules.titles, weight: n })} />
          </div>
          <div className="space-y-1">
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted block">Seniority</span>
            <div className="flex flex-wrap gap-1">
              {SENIORITIES.map((s) => {
                const on = rules.seniority.levels.includes(s);
                return (
                  <button
                    key={s}
                    aria-pressed={on}
                    onClick={() => set('seniority', { ...rules.seniority, levels: on ? rules.seniority.levels.filter((x) => x !== s) : [...rules.seniority.levels, s] })}
                    className={`px-2 py-0.5 text-[11px] font-mono border cursor-pointer ${on ? 'bg-ink border-ink text-white' : 'border-line text-ink-2'}`}
                  >
                    {s.replace('_', ' ')}
                  </button>
                );
              })}
            </div>
            <Weight label="Seniority" value={rules.seniority.weight} onChange={(n) => set('seniority', { ...rules.seniority, weight: n })} />
          </div>
          <div className="space-y-1">
            <ChipRow boxed label="Industries (contains)" values={rules.industries.include} onChange={(v) => set('industries', { ...rules.industries, include: v })} />
            <Weight label="Industries" value={rules.industries.weight} onChange={(n) => set('industries', { ...rules.industries, weight: n })} />
          </div>
          <div className="space-y-1">
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted block">Company size</span>
            <div className="flex items-center gap-2 text-xs font-mono">
              <input type="number" min={0} aria-label="Minimum employees" placeholder="Min" value={rules.employees.min ?? ''}
                onChange={(e) => set('employees', { ...rules.employees, min: e.target.value === '' ? null : Number(e.target.value) })}
                className="w-24 px-2 py-1 border border-line tabular-nums" />
              –
              <input type="number" min={0} aria-label="Maximum employees" placeholder="Max" value={rules.employees.max ?? ''}
                onChange={(e) => set('employees', { ...rules.employees, max: e.target.value === '' ? null : Number(e.target.value) })}
                className="w-24 px-2 py-1 border border-line tabular-nums" />
            </div>
            <Weight label="Company size" value={rules.employees.weight} onChange={(n) => set('employees', { ...rules.employees, weight: n })} />
          </div>
          <div className="space-y-1">
            <ChipRow boxed label="Locations (country code or name)" values={rules.locations.include} onChange={(v) => set('locations', { ...rules.locations, include: v })} />
            <Weight label="Locations" value={rules.locations.weight} onChange={(n) => set('locations', { ...rules.locations, weight: n })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted block mb-1">Verified email</span>
              <Weight label="Email" value={rules.email.weight} onChange={(n) => set('email', { weight: n })} />
            </div>
            <div>
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted block mb-1">Phone on file</span>
              <Weight label="Phone" value={rules.phone.weight} onChange={(n) => set('phone', { weight: n })} />
            </div>
          </div>
          <div className="flex items-center gap-3 text-[11px] font-mono text-ink-2">
            Strong fit from
            <input type="number" min={0} max={100} aria-label="Strong fit threshold" value={rules.thresholds.strong}
              onChange={(e) => set('thresholds', { ...rules.thresholds, strong: Number(e.target.value) || 0 })}
              className="w-14 px-1.5 py-0.5 border border-line tabular-nums" />
            possible fit from
            <input type="number" min={0} max={100} aria-label="Possible fit threshold" value={rules.thresholds.possible}
              onChange={(e) => set('thresholds', { ...rules.thresholds, possible: Number(e.target.value) || 0 })}
              className="w-14 px-1.5 py-0.5 border border-line tabular-nums" />
          </div>
        </div>
      )}
      {error && <div className="text-xs font-mono text-danger">{error}</div>}
    </Modal>
  );
};

export const DuplicatesDialog: React.FC<{ onClose: () => void; onMerged: () => void }> = ({ onClose, onMerged }) => {
  const [groups, setGroups] = React.useState<Array<Array<Partial<Contact> & { id: string }>> | null>(null);
  const [total, setTotal] = React.useState(0);
  const [keep, setKeep] = React.useState<Record<number, string>>({});
  const [busy, setBusy] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    findDuplicates().then((r) => {
      if (r.ok) {
        setGroups(r.groups);
        setTotal(r.total_groups);
      }
    }).catch((e) => setError((e as Error).message));
  }, []);
  React.useEffect(load, [load]);

  const merge = async (i: number) => {
    const g = groups![i];
    const k = keep[i] ?? g[0].id;
    setBusy(i);
    const r = await mergeContacts(k, g.filter((c) => c.id !== k).map((c) => c.id)).catch(() => null);
    setBusy(null);
    if (!r?.ok) {
      setError(errorCopy(r && !r.ok ? r.error : undefined));
      return;
    }
    onMerged();
    load();
  };

  return (
    <Modal title="Possible duplicates" onClose={onClose} wide>
      <p className="text-[11px] font-mono text-muted leading-relaxed">
        Records sharing an email, a LinkedIn profile, or a name at the same domain. Merging keeps the record you pick, fills
        its empty fields from the others, combines tags and notes, and moves list memberships to it.
      </p>
      {error && <div className="text-xs font-mono text-danger">{error}</div>}
      {!groups ? (
        <div className="text-xs font-mono text-muted flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Looking…</div>
      ) : groups.length === 0 ? (
        <p className="text-xs font-mono text-ink-2">No duplicates found.</p>
      ) : (
        <div className="space-y-3">
          {total > groups.length && <p className="text-[11px] font-mono text-muted">Showing {groups.length} of {total} groups.</p>}
          {groups.map((g, i) => (
            <div key={g[0].id} className="border border-line">
              {g.map((c) => (
                <label key={c.id} className="flex items-center gap-3 px-3 py-2 border-b border-line-soft last:border-b-0 text-xs font-mono cursor-pointer">
                  <input type="radio" name={`keep-${i}`} checked={(keep[i] ?? g[0].id) === c.id} onChange={() => setKeep((k) => ({ ...k, [i]: c.id }))} />
                  <span className="min-w-0 flex-1">
                    <span className="text-ink">{c.person_name ?? '—'}</span>
                    <span className="text-muted"> · {c.title ?? '—'} · {c.company_name ?? c.domain ?? '—'}</span>
                    <span className="block text-[11px] text-ink-2">{c.email ?? 'no email'}</span>
                  </span>
                  {c.email_status && <StatusBadge status={c.email_status} />}
                </label>
              ))}
              <div className="flex justify-end px-3 py-2 bg-surface-2">
                <Button variant="secondary" className="!py-1" disabled={busy !== null} onClick={() => void merge(i)}>
                  {busy === i ? 'Merging…' : `Merge ${g.length} into the selected record`}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
};
