import React, { useEffect, useState } from 'react';
import { Building2, ExternalLink, Loader2, MapPin, Users, CalendarDays, Factory, X, AlertCircle, ShieldCheck, Newspaper, Landmark, Briefcase } from 'lucide-react';
import { ModalDialog } from '../dashboard/ModalDialog';
import { usePricing } from '../../lib/pricing';
import { useWallet } from '../../lib/wallet-store';
import { creditsLabel, formatCredits } from '../../lib/billing';
import { companyStore, useCompany, type CompanyEntry } from './company-store';
import { prospectorPrefill } from './prospector-prefill';
import type { CompanyFundingRound, CompanyJobOpening, CompanyNewsArticle, CompanySignalKind } from '../../types';
import { LinkedinIcon } from './LeadCells';

// ============================================================================
// Company profile dialog. Opens on a company name in the results table, the
// lead cards and saved leads. Shows the cached profile when the shared cache
// has one (free); otherwise offers to enrich it (charged only when found).
// ============================================================================

interface CompanyPanelProps {
  domain: string;
  /** The name the lead row already shows, used until a profile is loaded. */
  fallbackName?: string | null;
  onClose: () => void;
}

export const CompanyPanel: React.FC<CompanyPanelProps> = ({ domain, fallbackName, onClose }) => {
  const entry = useCompany(domain);
  const { creditsFor } = usePricing();
  const { balance } = useWallet();
  const price = creditsFor('treg.companies.enrich');

  useEffect(() => {
    void companyStore.load(domain);
  }, [domain]);

  const company = entry.status === 'found' ? entry.company : null;
  const name = company?.name || fallbackName || domain;
  const busy = entry.status === 'enriching';

  const facts: { icon: React.ElementType; label: string; value: string | null }[] = company
    ? [
        { icon: Factory, label: 'Industry', value: company.industry },
        { icon: Users, label: 'Employees', value: company.employees },
        { icon: MapPin, label: 'Headquarters', value: company.location },
        { icon: CalendarDays, label: 'Founded', value: company.founded_year ? String(company.founded_year) : null },
      ]
    : [];

  return (
    <ModalDialog
      title={name}
      onClose={onClose}
      busy={busy}
      className="max-w-lg"
      renderHeader={(titleId) => (
        <div className="flex items-start gap-3 px-5 py-4 border-b border-line-soft">
          {company?.logo_url ? (
            <img src={company.logo_url} alt="" className="w-10 h-10 object-contain border border-line-soft bg-white shrink-0" />
          ) : (
            <span className="w-10 h-10 flex items-center justify-center bg-fill text-muted shrink-0" aria-hidden>
              <Building2 className="w-5 h-5" />
            </span>
          )}
          <div className="flex-1 min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-ink truncate">{name}</h2>
            <a
              href={company?.website || `https://${domain}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[13px] text-muted hover:text-ink hover:underline inline-flex items-center gap-1"
            >
              {domain}
              <ExternalLink className="w-3 h-3" aria-hidden />
            </a>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="p-1.5 text-muted hover:text-ink hover:bg-fill cursor-pointer disabled:opacity-50"
            aria-label="Close"
          >
            <X className="w-4 h-4" aria-hidden />
          </button>
        </div>
      )}
    >
      <div className="px-5 py-4 space-y-4 text-sm">
        {(entry.status === 'idle' || entry.status === 'loading') && (
          <p className="flex items-center gap-2 text-muted">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
            Checking for a company profile…
          </p>
        )}

        {company && (
          <>
            {company.description && <p className="text-ink-2 leading-relaxed whitespace-pre-line">{company.description}</p>}
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
              {facts.map(({ icon: Icon, label, value }) => (
                <div key={label} className="flex items-start gap-2 min-w-0">
                  <Icon className="w-4 h-4 text-muted shrink-0 mt-0.5" aria-hidden />
                  <div className="min-w-0">
                    <dt className="text-xs text-muted">{label}</dt>
                    <dd className={`break-words ${value ? 'text-ink' : 'text-muted'}`}>{value || 'Unknown'}</dd>
                  </div>
                </div>
              ))}
            </dl>
            {company.linkedin_url && (
              <a
                href={company.linkedin_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 h-9 px-3 border border-line hover:bg-fill text-ink-2 text-[13px] font-medium"
              >
                <LinkedinIcon className="w-4 h-4" />
                Company on LinkedIn
              </a>
            )}
            {company.enriched_at && (
              <p className="text-xs text-muted">Profile updated {new Date(company.enriched_at).toLocaleDateString()}.</p>
            )}
            {entry.status === 'found' &&
              SIGNALS.map((signal) => (
                <SignalSection key={signal.kind} domain={domain} entry={entry} signal={signal} price={creditsFor(signal.operation)} />
              ))}
          </>
        )}

        {entry.status === 'not_found' && (
          <p className="flex items-start gap-2 text-ink-2 bg-fill border border-line-soft p-3">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-muted" aria-hidden />
            No company profile was found for {domain}. Nothing was charged.
          </p>
        )}

        {entry.status === 'error' && (
          <p role="alert" className="flex items-start gap-2 text-ink bg-warn-bg border border-warn-line p-3 text-[13px]">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-warn" aria-hidden />
            {entry.message}
          </p>
        )}

        {(entry.status === 'none' || entry.status === 'enriching' || entry.status === 'error') && (
          <EnrichOffer
            domain={domain}
            price={price}
            balance={balance}
            busy={busy}
          />
        )}

        <button
          type="button"
          onClick={() => {
            onClose();
            prospectorPrefill.open(domain);
          }}
          disabled={busy}
          className="w-full h-10 border border-line hover:bg-fill text-ink text-sm font-medium inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
        >
          <Users className="w-4 h-4" aria-hidden />
          Find people at {company?.name || fallbackName || domain}
        </button>
      </div>
    </ModalDialog>
  );
};

type FoundEntry = Extract<CompanyEntry, { status: 'found' }>;

interface SignalConfig {
  kind: CompanySignalKind;
  operation: string;
  title: string;
  icon: React.ElementType;
  blurb: string;
  empty: string;
  /** One row: the main line, an optional link, and the detail line. */
  row: (item: any) => { main: string; href: string | null; detail: string };
}

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : null);
const money = (usd: number | null) =>
  usd === null ? null : usd >= 1e9 ? `$${(usd / 1e9).toFixed(1)}B` : usd >= 1e6 ? `$${(usd / 1e6).toFixed(1)}M` : `$${Math.round(usd / 1e3)}K`;

const SIGNALS: SignalConfig[] = [
  {
    kind: 'news',
    operation: 'treg.companies.news',
    title: 'Recent news',
    icon: Newspaper,
    blurb: 'Launches, hires and announcements from the last few months.',
    empty: 'No recent news was found for this company.',
    row: (a: CompanyNewsArticle) => ({ main: a.title, href: a.url, detail: [a.source, date(a.published_at)].filter(Boolean).join(' · ') }),
  },
  {
    kind: 'funding',
    operation: 'treg.companies.funding',
    title: 'Funding rounds',
    icon: Landmark,
    blurb: 'Rounds raised, with amounts and dates.',
    empty: 'No funding rounds were found for this company.',
    row: (r: CompanyFundingRound) => ({ main: r.name, href: null, detail: [money(r.amount_usd), date(r.announced_on)].filter(Boolean).join(' · ') }),
  },
  {
    kind: 'jobs',
    operation: 'treg.companies.jobs',
    title: 'Open jobs',
    icon: Briefcase,
    blurb: 'Roles they are hiring for right now: a sign of where they are growing.',
    empty: 'No open jobs were found for this company.',
    row: (j: CompanyJobOpening) => ({ main: j.title, href: j.url, detail: [j.location, date(j.posted_at)].filter(Boolean).join(' · ') }),
  },
];

/** One signal: shown from the cache when present, otherwise offered as a paid lookup. */
const SignalSection: React.FC<{ domain: string; entry: FoundEntry; signal: SignalConfig; price: number }> = ({
  domain,
  entry,
  signal,
  price,
}) => {
  const items = entry.company[signal.kind] as unknown[] | null | undefined;
  const loading = Boolean(entry.signalLoading?.[signal.kind]);
  const error = entry.signalError?.[signal.kind];
  const Icon = signal.icon;
  return (
    <section className="border-t border-line-soft pt-4 space-y-2" aria-label={signal.title}>
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
        <Icon className="w-3.5 h-3.5" aria-hidden /> {signal.title}
      </h3>
      {items && items.length > 0 ? (
        <ul className="space-y-2">
          {items.map((item, i) => {
            const r = signal.row(item);
            return (
              <li key={`${r.main}-${i}`}>
                {r.href ? (
                  <a href={r.href} target="_blank" rel="noopener noreferrer" className="text-[13px] text-ink hover:underline line-clamp-2">
                    {r.main}
                  </a>
                ) : (
                  <p className="text-[13px] text-ink line-clamp-2">{r.main}</p>
                )}
                {r.detail && <p className="text-xs text-muted">{r.detail}</p>}
              </li>
            );
          })}
        </ul>
      ) : items && items.length === 0 ? (
        <p className="text-[13px] text-muted">{signal.empty} Nothing was charged.</p>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <p className="text-[13px] text-ink-2">{signal.blurb}</p>
          <button
            type="button"
            onClick={() => void companyStore.loadSignal(domain, signal.kind)}
            disabled={loading}
            className="h-9 px-3 border border-line hover:bg-fill text-ink text-[13px] font-medium inline-flex items-center gap-2 shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-wait"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : null}
            {loading ? 'Looking up…' : `Get · ${formatCredits(price)} cr`}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {!items && <p className="text-xs text-muted">Charged only when something is found.</p>}
    </section>
  );
};

const EnrichOffer: React.FC<{ domain: string; price: number; balance: number | null; busy: boolean }> = ({
  domain,
  price,
  balance,
  busy,
}) => {
  const short = balance !== null && balance < price;
  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 text-[13px] text-ink-2 bg-ok-bg border border-ok-line p-3">
        <ShieldCheck className="w-4 h-4 text-ok shrink-0 mt-0.5" aria-hidden />
        <span>
          Get the industry, size, location, founding year and LinkedIn page for this company. {creditsLabel(price)}, charged
          only when a profile is found.
        </span>
      </p>
      <div className="flex items-center justify-between gap-3">
        <span className={`text-xs tabular-nums ${short ? 'text-danger' : 'text-muted'}`}>
          {balance !== null ? `Balance: ${formatCredits(balance)} credits` : ''}
        </span>
        <button
          type="button"
          onClick={() => void companyStore.enrich(domain)}
          disabled={busy || short}
          className="h-10 px-4 bg-ink hover:bg-black text-white text-sm font-medium flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
              <span>Looking up…</span>
            </>
          ) : (
            <span>Get company profile · {formatCredits(price)} cr</span>
          )}
        </button>
      </div>
    </div>
  );
};

/**
 * A company name that opens its profile. Without a domain there is nothing to
 * look up, so it renders as plain text.
 */
export const CompanyName: React.FC<{
  name: string | null | undefined;
  domain: string | null | undefined;
  className?: string;
}> = ({ name, domain, className = '' }) => {
  const [open, setOpen] = useState(false);
  const label = name || '—';
  if (!domain) return <span className={className}>{label}</span>;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`text-left hover:underline cursor-pointer ${className}`}
        title={`View ${name || domain} company profile`}
      >
        {label}
      </button>
      {open && <CompanyPanel domain={domain} fallbackName={name} onClose={() => setOpen(false)} />}
    </>
  );
};
