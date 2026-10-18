/**
 * Echo Leads — one lead, without leaving the table
 * ---------------------------------------------------------------------------
 * Everything known about a person, each value with where it came from. Fields
 * nobody has supplied say "Not available" rather than render blank, and the
 * email's status is the verifier's word, with when and which verifier.
 */
import React from 'react';
import { ExternalLink, Trash2 } from 'lucide-react';
import { Drawer, Field, SectionLabel, ScoreBadge } from './Pick';
import { StatusBadge } from './StatusBadge';
import { Button, Textarea } from './Screen';
import { ChipRow } from './ChipRow';
import { providerLabel } from '../../lib/leads';
import {
  getContact, updateContacts, deleteContacts, LEAD_STATUSES, errorCopy,
  type Contact, type Company, type EnrichAction, type LeadStatus,
} from '../../lib/leads-db';

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString() : null);

export const ContactPanel: React.FC<{
  id: string;
  onClose: () => void;
  onChanged: () => void;
  onEnrich: (action: EnrichAction, ids: string[]) => void;
  onOpenCompany?: (id: string) => void;
}> = ({ id, onClose, onChanged, onEnrich, onOpenCompany }) => {
  const [data, setData] = React.useState<{ contact: Contact; company: Company | null; lists: Array<{ id: string; name: string }> } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notes, setNotes] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    setError(null);
    const r = await getContact(id).catch((e) => ({ ok: false as const, error: (e as Error).message }));
    if (!r.ok) {
      setError(errorCopy(r.error));
      return;
    }
    setData(r);
    setNotes(r.contact.notes ?? '');
  }, [id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const patch = async (p: Parameters<typeof updateContacts>[1]) => {
    setSaving(true);
    const r = await updateContacts([id], p).catch(() => null);
    setSaving(false);
    if (!r?.ok) {
      setError(errorCopy(r && !r.ok ? r.error : undefined));
      return;
    }
    await load();
    onChanged();
  };

  const c = data?.contact;
  const co = data?.company;
  const firmo = { ...(c?.attributes?.company ?? {}), ...(co?.data ?? {}) };

  return (
    <Drawer
      onClose={onClose}
      title={
        c ? (
          <div>
            <div className="text-sm font-medium text-[#141414]">{c.person_name ?? c.email ?? 'Unnamed lead'}</div>
            <div className="text-[11px] font-mono text-[#8a8a86] mt-0.5">
              {[c.title, c.company_name ?? c.domain].filter(Boolean).join(' · ') || '—'}
            </div>
          </div>
        ) : (
          <div className="text-sm text-[#8a8a86]">Loading…</div>
        )
      }
      footer={
        c && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => onEnrich(c.email ? 'verify' : 'find_email', [c.id])}>
              {c.email ? 'Re-verify email' : 'Find email'}
            </Button>
            {!c.phone && <Button variant="secondary" onClick={() => onEnrich('phone', [c.id])}>Find phone</Button>}
            <Button
              variant="quiet"
              className="ml-auto !text-[#c0462e]"
              onClick={async () => {
                if (!window.confirm('Delete this lead from your database? Runs that found it keep their own rows.')) return;
                const r = await deleteContacts([c.id]);
                if (r.ok) {
                  onChanged();
                  onClose();
                }
              }}
            >
              <Trash2 className="w-3 h-3" /> Delete
            </Button>
          </div>
        )
      }
    >
      {error && <div className="text-xs font-mono text-[#c0462e]" role="alert">{error}</div>}
      {c && (
        <>
          <section className="space-y-2">
            <SectionLabel>Contact</SectionLabel>
            <Field label="Email" source={c.email_provider ? providerLabel(c.email_provider) : null}>
              {c.email && (
                <span className="inline-flex flex-wrap items-center gap-2">
                  {c.email} <StatusBadge status={c.email_status} />
                </span>
              )}
            </Field>
            <Field label="Checked">
              {c.email_checked_at
                ? `${when(c.email_checked_at)}${c.email_verifier ? ` by ${providerLabel(c.email_verifier)}` : ''}`
                : c.email
                  ? 'Never verified'
                  : null}
            </Field>
            <Field label="Phone" source={c.phone_provider ? providerLabel(c.phone_provider) : null}>{c.phone}</Field>
            <Field label="Profile">
              {c.linkedin_url && (
                <a href={c.linkedin_url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline">
                  LinkedIn <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </Field>
            <Field label="Location">{c.location}</Field>
          </section>

          <section className="space-y-2">
            <SectionLabel>Company</SectionLabel>
            <Field label="Name">
              {(c.company_name || c.domain) && (
                co && onOpenCompany ? (
                  <button className="underline cursor-pointer" onClick={() => onOpenCompany(co.id)}>{c.company_name ?? c.domain}</button>
                ) : (
                  c.company_name ?? c.domain
                )
              )}
            </Field>
            <Field label="Domain">{c.domain}</Field>
            <Field label="Industry">{firmo.industry}</Field>
            <Field label="Employees">{firmo.employee_count != null ? Number(firmo.employee_count).toLocaleString() : firmo.employee_range}</Field>
            <Field label="Revenue">{firmo.revenue_range ?? (firmo.revenue_min != null ? `$${(firmo.revenue_min / 1e6).toFixed(1)}M–$${((firmo.revenue_max ?? 0) / 1e6).toFixed(1)}M` : null)}</Field>
            <Field label="Details" source={co?.data?.source ? `${providerLabel(String(co.data.source))}, ${when(co.enriched_at)}` : c.attributes?.found_by ? 'search result' : null}>
              {co?.enriched_at ? 'Enriched' : 'Not enriched'}
            </Field>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <SectionLabel>Fit score</SectionLabel>
              <ScoreBadge score={c.score} label={c.score_label} />
            </div>
            <p className="text-[11px] font-mono text-[#8a8a86]">
              {c.score_label ?? 'Not scored'} · how well this lead matches your scoring rules. Not a likelihood of anything.
            </p>
            {(c.score_reasons ?? []).length > 0 && (
              <ul className="space-y-1">
                {(c.score_reasons ?? []).map((r) => (
                  <li key={r.factor} className="flex justify-between gap-3 text-[11px] font-mono">
                    <span className="text-[#4a4a47]">{r.note}</span>
                    <span className="tabular-nums text-[#8a8a86] whitespace-nowrap">{r.points}/{r.max}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-3">
            <SectionLabel>Qualification</SectionLabel>
            <div className="flex flex-wrap gap-1" role="group" aria-label="Lead status">
              {LEAD_STATUSES.map((s) => (
                <button
                  key={s.value}
                  disabled={saving}
                  aria-pressed={c.status === s.value}
                  onClick={() => void patch({ status: s.value as LeadStatus })}
                  className={`px-2 py-0.5 text-[11px] font-mono border cursor-pointer ${
                    c.status === s.value ? 'bg-[#141414] border-[#141414] text-white' : 'border-[#e3e3de] text-[#4a4a47] hover:border-[#141414]'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <ChipRow boxed
              label="Tags"
              values={c.tags ?? []}
              onChange={(next) => {
                const add = next.filter((t) => !(c.tags ?? []).includes(t));
                const remove = (c.tags ?? []).filter((t) => !next.includes(t));
                void patch({ add_tags: add, remove_tags: remove });
              }}
              placeholder="Add a tag"
            />
            <div>
              <SectionLabel>Notes</SectionLabel>
              <Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Notes" />
              {notes !== (c.notes ?? '') && (
                <div className="flex justify-end mt-1.5">
                  <Button variant="secondary" className="!py-1" disabled={saving} onClick={() => void patch({ notes })}>Save notes</Button>
                </div>
              )}
            </div>
          </section>

          <section className="space-y-2">
            <SectionLabel>Lists</SectionLabel>
            {data!.lists.length === 0 ? (
              <p className="text-[11px] font-mono text-[#9b9b96]">Not in any list.</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {data!.lists.map((l) => (
                  <span key={l.id} className="px-2 py-0.5 text-[11px] font-mono bg-[#f0f0ec] border border-[#e3e3de]">{l.name}</span>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-2">
            <SectionLabel>Record</SectionLabel>
            <Field label="Source">{c.source === 'search' ? 'People search' : c.source === 'import' ? 'Imported list' : 'Lead run'}</Field>
            <Field label="Added">{when(c.created_at)}</Field>
            <Field label="Updated">{when(c.updated_at)}</Field>
          </section>
        </>
      )}
    </Drawer>
  );
};
