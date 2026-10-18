import React from 'react';
import { Plus, X, ShieldOff, Trash2, Loader2 } from 'lucide-react';
import {
  getSuppressions,
  addSuppression,
  removeSuppression,
  suppressionKind,
  normaliseSuppression,
} from '../../lib/leads';
import type { LeadSuppression } from '../../types';
import { Screen, Panel, Button, Input, Figure } from './Screen';

/**
 * Who never gets contacted.
 *
 * This was a paragraph saying the feature would exist. It exists — the worker
 * checks the list before every paid call, so a suppressed address is never even
 * looked up, which means suppressing somebody costs nothing and their data is
 * not fetched at all.
 *
 * Built around the one thing a suppression list has to get right: adding
 * something that does not match what the worker will check later. The input
 * shows what it is about to file before anything is filed, using the same
 * normalisation the server applies, because a list that silently fails to
 * suppress is worse than no list — the user believes those people are protected.
 */

export const OptOuts: React.FC = () => {
  const [items, setItems] = React.useState<LeadSuppression[] | null>(null);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setItems(await getSuppressions());
    } catch {
      // Named, not blanked. An empty list and a failed load look identical, and
      // the first one tells the user they have nothing suppressed when they may
      // have plenty.
      setError('Could not load your opt-outs list.');
      setItems([]);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const normalised = normaliseSuppression(draft);
  const preview = normalised ? suppressionKind(normalised) : null;
  const alreadyThere = normalised ? items?.some((i) => i.value === normalised) ?? false : false;

  const add = async () => {
    if (!normalised) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await addSuppression(normalised);
      if (!res.ok) {
        setError(res.error === 'Nothing to suppress' ? 'Type an address or a domain.' : 'Could not add that.');
        return;
      }
      setDraft('');
      await load();
      // Said once, in the server's terms, because the point of the field is what
      // it prevents and the cost of getting it wrong is a contact that happens.
      setNotice(`Nothing will be looked up for ${normalised}. Suppression is free and it applies to every future run.`);
    } catch {
      setError('Could not add that.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (value: string) => {
    // Optimistic, then confirmed by the reload. Waiting on the round trip to
    // close the row makes deleting six things feel like a form.
    setItems((prev) => (prev ?? []).filter((i) => i.value !== value));
    try {
      await removeSuppression(value);
      await load();
    } catch {
      setError(`Could not remove ${value}.`);
      void load();
    }
  };

  const bulkClear = async () => {
    const all = items ?? [];
    if (all.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // Sequential rather than parallel. These are cheap writes, and firing
      // forty of them at once against one row's own list is a good way to get a
      // rate limit and leave the list in a state nobody can describe.
      for (const item of all) await removeSuppression(item.value);
      setNotice('Opt-outs cleared. Anyone on it can be looked up again.');
      await load();
    } catch {
      setError('Could not clear the list.');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const emails = (items ?? []).filter((i) => i.kind === 'email').length;

  return (
    <Screen
      title="Opt-outs"
      subtitle="People and domains you never want contacted. Checked before every paid call, so a suppressed row is never even looked up."
      icon={<ShieldOff className="w-4 h-4" />}
    >
      <Panel label="Add">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <Input
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setNotice(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add();
              }}
              placeholder="an email address, or a domain"
              spellCheck={false}
              autoComplete="off"
            />
            {/* What it will be filed as, before it is filed. The whole point of
                this field is that it is checked later by something else, so the
                user should never have to wonder what was stored on their
                behalf. */}
            {normalised && (
              <p className="text-[10px] font-mono text-[#8a8a86] mt-1.5">
                will suppress{' '}
                <span className="text-[#4a4a47]">{normalised}</span> as a{' '}
                {preview === 'email' ? 'single address' : 'whole domain'}
                {alreadyThere && <span className="text-[#b45309]"> · already on the list</span>}
              </p>
            )}
          </div>
          <Button onClick={() => void add()} disabled={busy || !normalised || alreadyThere}>
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
            Add
          </Button>
        </div>
      </Panel>

      {error && (
        <div className="flex items-start gap-2 px-4 py-3 bg-[#fdf2f2] border border-[#f0c4c4]">
          <X className="w-3.5 h-3.5 text-[#8a2a2a] mt-0.5 flex-shrink-0" />
          <span className="text-xs font-mono text-[#8a2a2a]">{error}</span>
        </div>
      )}

      {notice && (
        <div className="flex items-start gap-2 px-4 py-3 bg-[#f6f6f4] border border-[#e3e3de]">
          <span className="text-xs font-mono text-[#4a4a47] leading-relaxed">{notice}</span>
        </div>
      )}

      <Panel
        label={items ? `Suppressed · ${items.length}` : 'Suppressed'}
        aside={
          items && items.length > 0 ? (
            <button
              onClick={() => void bulkClear()}
              disabled={busy}
              className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] hover:text-[#b03a20] transition-colors cursor-pointer disabled:opacity-40 flex items-center gap-1.5"
            >
              <Trash2 className="w-3 h-3" />
              Clear all
            </button>
          ) : null
        }
      >
        {items === null ? (
          <div className="py-6 flex justify-center">
            <Loader2 className="w-4 h-4 animate-spin text-[#b5b5ad]" />
          </div>
        ) : items.length === 0 ? (
          <div className="py-4 text-center">
            <p className="text-xs font-mono text-[#8a8a86] leading-relaxed max-w-sm mx-auto">
              Nothing suppressed. Add an address or a domain above and Echo will skip it before it
              spends anything looking.
            </p>
          </div>
        ) : (
          <>
            {/* Two counts rather than one list length, because suppressing one
                company and suppressing six people at one company are different
                amounts of protection and the number alone cannot say which. */}
            <div className="flex gap-8 pb-4 mb-4 border-b border-[#eeeeea]">
              <Figure label="Addresses" value={emails} size="sm" />
              <Figure
                label="Domains"
                value={items.length - emails}
                size="sm"
              />
            </div>

            <ul className="divide-y divide-[#eeeeea] -mx-5">
              {items.map((item) => (
                <li key={item.id ?? item.value} className="flex items-center gap-3 px-5 h-11 group">
                  <span
                    className={`inline-flex items-center px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider flex-shrink-0 ${
                      item.kind === 'email'
                        ? 'bg-[#eef3f8] text-[#2f6aa8]'
                        : 'bg-[#f0f0ec] text-[#4a4a47]'
                    }`}
                  >
                    {item.kind}
                  </span>
                  <span className="text-xs font-mono text-[#141414] truncate flex-1 min-w-0">
                    {item.value}
                  </span>
                  <span className="text-[10px] font-mono text-[#b5b5ad] hidden sm:block flex-shrink-0">
                    {whenAdded(item.created_at)}
                  </span>
                  <button
                    onClick={() => void remove(item.value)}
                    className="text-[#b5b5ad] hover:text-[#b03a20] transition-colors cursor-pointer flex-shrink-0 p-1"
                    aria-label={`Stop suppressing ${item.value}`}
                    title="Stop suppressing"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>

      {items && items.length > 0 && (
        <p className="text-[10px] font-mono text-[#8a8a86] leading-relaxed max-w-2xl">
          An address on this list is never sent to a provider, so it costs nothing to suppress and
          nothing about it is fetched. Removing it makes it eligible again for every run from then
          on — runs already finished are not revisited.
        </p>
      )}
    </Screen>
  );
};

/** Coarse, because the exact minute somebody added an opt-out is not the point. */
function whenAdded(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}