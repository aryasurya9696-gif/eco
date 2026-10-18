import React from 'react';
import { Search, Sparkles, Globe, CircleAlert, Loader2, Plus } from 'lucide-react';
import type { LeadIcpSegment, LeadIcp } from '../../types';
import {
  getIcp, saveIcp, estimateRun, startRun, MAX_RUN_ROWS,
} from '../../lib/leads';
import { useAuth } from '../../context/AuthContext';
import { formatUsd, formatCredits } from '../../lib/billing';
import { Screen, Panel, Button, Textarea, Input, Figure, PriceBar } from './Screen';
import { ChipRow, ChipChoice } from './ChipRow';

/**
 * The screen people came for.
 *
 * It reads the profile they already filled in during onboarding, gives them the
 * ICP to correct, and puts a real call into estimate_lead_run underneath it so
 * the price updates as the count changes.
 *
 * The generator still records what it assumed, and the severity it gave each
 * one, and none of it is shown here. The data is kept because it is already
 * stored and it is the thing to reach for if someone asks why a search returned
 * what it did — but a panel of caveats above a form is a screen arguing with
 * itself, and the fields below already say what is being searched for.
 *
 * What does not work is reading the site, because that needs the provider and the
 * provider token is not valid. So that one button is present and disabled, with
 * the reason on it. Removing it would be worse: the user has been told the product
 * reads their site, and a screen that quietly omits the button reads as a feature
 * that does not exist rather than one that is temporarily unavailable.
 */

interface NewSearchProps {
  onStarted: (runId: string) => void;
}

const SIZES = [
  { label: '1–10', value: '1-10' },
  { label: '11–50', value: '11-50' },
  { label: '51–200', value: '51-200' },
  { label: '201–1000', value: '201-1000' },
  { label: '1000+', value: '1000+' },
];

const COUNT_PRESETS = [25, 50, 100, 250, 500];

const COUNTRY_SUGGESTIONS = ['United Kingdom', 'United States', 'Ireland', 'Australia', 'Germany', 'Netherlands', 'Canada'];

const TITLE_SUGGESTIONS = [
  'Founder', 'Owner', 'Managing Director', 'Director', 'Partner',
  'Head of', 'Chief Executive', 'COO', 'CFO', 'Practice Manager',
];

const EMPTY_SEGMENT: LeadIcpSegment = {
  name: '',
  industries: [],
  keywords: [],
  excludeKeywords: [],
  countries: [],
  targetTitles: [],
  seniority: [],
  employeeRange: [11, 50],
  pains: [],
};

export const NewSearch: React.FC<NewSearchProps> = ({ onStarted }) => {
  const { profile } = useAuth();

  const [icpId, setIcpId] = React.useState<string | null>(null);
  const [doc, setDoc] = React.useState<LeadIcp['json'] | null>(null);
  const [segment, setSegment] = React.useState<LeadIcpSegment>({ ...EMPTY_SEGMENT });
  const [summary, setSummary] = React.useState('');
  const [target, setTarget] = React.useState(50);
  const [estimate, setEstimate] = React.useState<Awaited<ReturnType<typeof estimateRun>>>(null);
  const [pricing, setPricing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const icp = await getIcp();
        if (cancelled) return;
        if (icp) {
          setIcpId(icp.id);
          setDoc(icp.json ?? null);
          const d = icp.json ?? {};
          const seg = d.segments?.[d.primarySegment ?? 0] ?? d.segments?.[0];
          if (seg) setSegment({ ...EMPTY_SEGMENT, ...seg });
          if (d.summary) setSummary(d.summary);
        }
      } catch {
        // A blank form and a failed load look the same. Not fatal either way —
        // the user can fill this in from nothing — so it does not earn an error
        // banner above fields that are all empty.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    setPricing(true);
    estimateRun({ kind: 'find', target })
      .then((est) => {
        if (!cancelled) setEstimate(est);
      })
      .catch(() => {
        if (!cancelled) setEstimate(null);
      })
      .finally(() => {
        if (!cancelled) setPricing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  const patch = (changes: Partial<LeadIcpSegment>) =>
    setSegment((prev) => ({ ...prev, ...changes }));

  const size = SIZES.find((s) => s.value === sizeValueOf(segment.employeeRange));

  const enoughToSearch =
    (segment.industries?.length ?? 0) > 0 ||
    (segment.keywords?.length ?? 0) > 0 ||
    (segment.name?.trim().length ?? 0) > 0;

  // What this search is made of, in the user's terms. Honest about being a
  // description rather than a count: without a provider there is no way to know
  // how many companies match, and a number that is not a number is worse than a
  // sentence that says what it does know.
  const chosenSummary = [
    segment.industries?.length ? segment.industries.join(', ') : null,
    segment.countries?.length ? segment.countries.join(', ') : null,
    size ? `${size.label} staff` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      // Saved and approved before the run starts, so the run and the profile that
      // produced it cannot come apart. A run pointing at an ICP that was never
      // written is a run nobody can explain six months later.
      const next = {
        ...doc,
        summary,
        segments: [segment],
        primarySegment: 0,
      };
      const saved = await saveIcp({
        id: icpId,
        website: profile?.website ?? null,
        offer: profile?.core_offer ?? null,
        icp: next,
        approved: true,
      });
      if (!saved.ok) {
        setError('Could not save the profile.');
        return;
      }
      if (!icpId) setIcpId(saved.id);

      const res = await startRun({
        kind: 'find',
        target,
        name: segment.name?.trim() || `${target} leads`,
        icp_id: saved.id,
      });

      if (!res.ok) {
        setError(
          res.error === 'insufficient_credits'
            ? 'Not enough credits for the worst case of this search. Top up and try again.'
            : (res as { message?: string }).message ?? 'Could not start the run.',
        );
        return;
      }

      onStarted(res.run.id);
    } catch {
      setError('Could not start the run.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title="New search"
      subtitle="Describe who buys from you. Nothing is spent until you press Find."
      icon={<Search className="w-4 h-4" />}
    >
      <Panel label="From your profile">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0 space-y-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <Globe className="w-3.5 h-3.5 text-[#b5b5ad] flex-shrink-0" />
              <span className="text-xs font-mono text-[#141414] truncate">
                {profile?.website || 'no website on file'}
              </span>
            </div>
            <p className="text-[11px] font-mono text-[#8a8a86] leading-relaxed">
              {profile?.core_offer || 'No description of what you sell on file yet.'}
            </p>
          </div>

          {/* Present and disabled, with the reason attached. Omitting it would
              read as a feature that does not exist; this reads as one waiting on
              a provider, which is what it is. */}
          <button
            disabled
            title="Reading your site needs the data provider, which is not connected yet."
            className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#e3e3de] text-[10px] font-mono uppercase tracking-wider text-[#b5b5ad] cursor-not-allowed"
          >
            <Sparkles className="w-3 h-3" />
            Read my site
          </button>
        </div>

        {loading ? (
          <p className="text-[10px] font-mono text-[#b5b5ad] mt-3 pt-3 border-t border-[#eeeeea]">
            looking for a profile you already saved…
          </p>
        ) : doc ? (
          <p className="text-[10px] font-mono text-[#1a7f4b] mt-3 pt-3 border-t border-[#eeeeea]">
            Saved profile loaded — everything below is editable, and what you change is what runs.
          </p>
        ) : null}
      </Panel>

      <Panel
        label="Who you are looking for"
        hint={chosenSummary || undefined}
      >
        <div className="space-y-5">
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] mb-1.5">
              Give this search a name
            </label>
            <Input
              value={segment.name ?? ''}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="UK accounting firms"
            />
          </div>

          <div>
            <label className="block text-[10px] font-mono uppercase tracking-wider text-[#8a8a86] mb-1.5">
              Describe them
            </label>
            <Textarea
              rows={2}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Accountants and bookkeepers who take on year-end work they do not want to do themselves."
            />
          </div>

          <div className="grid grid-cols-2 gap-6">
            <ChipRow
              label="Industries"
              values={segment.industries ?? []}
              onChange={(v) => patch({ industries: v })}
              placeholder="Accounting, Legal…"
              mapped
            />
            <ChipRow
              label="Countries"
              values={segment.countries ?? []}
              onChange={(v) => patch({ countries: v })}
              suggestions={COUNTRY_SUGGESTIONS}
              placeholder="Add a country…"
              mapped
            />
          </div>

          <div className="grid grid-cols-2 gap-6">
            <ChipRow
              label="Titles to look for"
              values={segment.targetTitles ?? []}
              onChange={(v) => patch({ targetTitles: v })}
              suggestions={TITLE_SUGGESTIONS}
              placeholder="Founder, Partner…"
              mapped
            />
            <ChipRow
              label="Never these"
              values={segment.excludeKeywords ?? []}
              onChange={(v) => patch({ excludeKeywords: v })}
              placeholder="franchise, recruitment…"
              mapped={false}
            />
          </div>

          <div>
            <ChipRow
              label="Keywords"
              values={segment.keywords ?? []}
              onChange={(v) => patch({ keywords: v })}
              placeholder="VAT, year-end accounts…"
              mapped
            />
          </div>

          <ChipChoice
            label="Company size"
            options={SIZES.map((s) => s.label)}
            value={size?.label ?? null}
            onChange={(v) => {
              const picked = SIZES.find((s) => s.label === v);
              if (!picked) return;
              patch({ employeeRange: sizeBounds(picked.value) });
            }}
          />
        </div>
      </Panel>

      <Panel label="What this costs">
        <div className="space-y-5">
          <div className="flex items-center gap-4 flex-wrap">
            <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86]">
              How many leads
            </span>
            <div className="flex gap-1">
              {COUNT_PRESETS.map((n) => (
                <button
                  key={n}
                  onClick={() => setTarget(n)}
                  className={`px-2.5 py-1 text-[10px] font-mono border transition-colors cursor-pointer ${
                    target === n
                      ? 'bg-[#141414] text-white border-[#141414]'
                      : 'border-[#e3e3de] text-[#8a8a86] hover:border-[#141414] hover:text-[#141414]'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
            <input
              type="number"
              value={target}
              min={1}
              max={MAX_RUN_ROWS}
              onChange={(e) => setTarget(Math.max(1, Math.min(MAX_RUN_ROWS, Number(e.target.value) || 1)))}
              className="w-20 bg-transparent text-xs font-mono text-[#141414] border border-[#e3e3de] px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[#141414] tabular-nums"
            />
          </div>

          <div className="flex gap-10 sm:gap-16">
            <Figure
              label="Likely"
              value={pricing || !estimate ? <Loader2 className="w-5 h-5 animate-spin text-[#b5b5ad]" /> : formatCredits(estimate!.expected_credits)}
              sub={estimate ? formatUsd(estimate.min_credits) + ' at the floor' : undefined}
            />
            <Figure
              label="At most"
              value={pricing || !estimate ? <Loader2 className="w-5 h-5 animate-spin text-[#b5b5ad]" /> : formatCredits(estimate!.max_credits)}
              sub={estimate ? formatUsd(estimate.max_credits) : undefined}
            />
            <Figure
              label="Rows"
              value={target.toLocaleString()}
              sub={target >= MAX_RUN_ROWS ? 'the ceiling for one run' : undefined}
            />
          </div>

          {estimate && (
            <PriceBar expected={estimate.expected_credits} max={estimate.max_credits} />
          )}

          {!enoughToSearch && (
            <div className="flex items-start gap-2 text-[10px] font-mono text-[#b5801f] leading-relaxed">
              <CircleAlert className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>
                Add at least one industry or keyword so the search knows who to look for. It will
                run without one, and return whatever the providers consider a match.
              </span>
            </div>
          )}

          <div className="flex items-center gap-4 pt-1 flex-wrap">
            <div className="flex items-stretch">
              <Button onClick={() => void start()} disabled={busy || pricing || !estimate} className="!px-6">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                Find {target.toLocaleString()} leads
              </Button>

              {/* The unit price on the button, because it answers a different
                  question from the total and is the one that decides whether the
                  thing is worth doing. Fifty credits is "can I afford this"; the
                  per-lead figure is "is this worth doing". */}
              {estimate && !pricing && (
                <span className="inline-flex items-center px-3 bg-[#141414] text-white text-[10px] font-mono border-l border-white/20 whitespace-nowrap">
                  about {formatUnitPrice(estimate.expected_credits, target)} each
                </span>
              )}
            </div>

            {estimate && (
              <span className="text-[10px] font-mono text-[#8a8a86]">a miss costs nothing</span>
            )}
          </div>

          {/* The hold, stated in one sentence.
              We reserve the worst case before the first provider call and settle
              down afterwards, and until now the screen said nothing about it. A
              user who reads "at most 61 credits", watches 61 leave their balance,
              and is never told otherwise has every reason to think we took the
              money and did not do the work. This is the line that prevents that. */}
          {estimate && !pricing && (
            <p className="text-[11px] font-mono text-[#8a8a86] leading-relaxed pt-4 border-t border-[#eeeeea]">
              The most it can cost is held when the search starts, and whatever it does not spend
              comes straight back when it ends. You are only charged for what it finds.
            </p>
          )}

          {error && (
            <div className="flex items-start gap-2 px-3 py-2.5 bg-[#fdf2f2] border border-[#f0c4c4]">
              <CircleAlert className="w-3.5 h-3.5 text-[#8a2a2a] mt-0.5 flex-shrink-0" />
              <span className="text-xs font-mono text-[#8a2a2a]">{error}</span>
            </div>
          )}
        </div>
      </Panel>

      <p className="text-[10px] font-mono text-[#8a8a86] leading-relaxed max-w-2xl">
        A search looks up companies, then the person who would buy at each, then an address for
        them, cheapest provider first. You are charged for what it finds, and the figure above is
        the most it can cost before it starts.
      </p>
    </Screen>
  );
};

// ---------------------------------------------------------------------------

/**
 * The price of one lead.
 *
 * Rounded to one decimal because the second one is noise on a screen where the
 * total is sitting two inches above — 16.6 tells you the order of magnitude and
 * whether it is worth it, and 16.63 pretends to a precision the estimate does not
 * have. A hit rate of 70% cannot tell you the price of the eleventh lead.
 *
 * Zero is shown as "less than one", not as 0. Because that is what it means: the
 * expected total came out under one credit for the whole search, and a rounded
 * "0 each" reads as free when it is merely cheap.
 */
function formatUnitPrice(total: number, count: number): string {
  if (count <= 0) return '—';
  const each = total / count;
  if (each === 0) return 'less than one';
  if (each < 0.05) return each.toFixed(2);
  return each.toFixed(1);
}

/** "51-200" to the pair the database stores. */
function sizeBounds(value: string): [number, number] {
  const s = SIZES.find((x) => x.value === value);
  if (!s) return [11, 50];
  const [a, b] = value.split('-');
  return [Number(a), b === '+' ? 999999 : Number(b)];
}

/** The inverse, tolerant of anything the database or an old profile holds. */
function sizeValueOf(range: LeadIcpSegment['employeeRange']): string | undefined {
  if (!range || range.length !== 2) return undefined;
  return SIZES.find((s) => {
    const [a, b] = sizeBounds(s.value);
    return a === range[0] && b === range[1];
  })?.value;
}