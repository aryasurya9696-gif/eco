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
import {
  SIZE_BANDS, sizeLabelOf, sizeBoundsOf, sizeIsJunk, searchTextOf, isSearchable, mergeSegment,
} from '../../lib/leads-segment';

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

const SIZES = SIZE_BANDS.map((b) => b.label);

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
  // Why there is no price, as distinct from "the price is loading".
  //
  // These were the same thing. A failed estimate set the estimate to null, the
  // button's disabled condition included `!estimate`, and nothing on the screen
  // distinguished the two — so a dropped connection left the user looking at a
  // permanently disabled Find button, three empty figures and no reason. The
  // only way out was to reload the page.
  const [estimateError, setEstimateError] = React.useState<string | null>(null);
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
        if (cancelled) return;
        setEstimate(est);
        setEstimateError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setEstimate(null);
        setEstimateError('Could not price this search. The price comes from a live lookup, so this is usually a connection problem — try again in a moment.');
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

  // Which band, if any, the saved range is. Null means it is not one of them —
  // a custom size, or a range from an older profile — and the chip row then
  // shows a read-only version of it rather than nothing at all, which is what
  // happened before: the user had a size set and the screen claimed they did not.
  const size = sizeLabelOf(segment.employeeRange);
  const customSize =
    size === null && segment.employeeRange && !sizeIsJunk(segment.employeeRange)
      ? customSizeLabel(segment.employeeRange)
      : null;
  const junkSize = sizeIsJunk(segment.employeeRange);

  // The same rule the backend applies, in the same module. They used to differ:
  // the form treated a name as enough to run and the worker refused it, so the
  // warning under the price said the search would go ahead and it then failed
  // with no rows and no clear reason.
  const enoughToSearch = isSearchable(segment);
  const searchText = searchTextOf(segment);

  // What this search is made of, in the user's terms. Honest about being a
  // description rather than a count: without a provider there is no way to know
  // how many companies match, and a number that is not a number is worse than a
  // sentence that says what it does know.
  const chosenSummary = [
    segment.industries?.length ? segment.industries.join(', ') : null,
    segment.countries?.length ? segment.countries.join(', ') : null,
    (size ?? customSize) ? `${size ?? customSize} staff` : null,
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
      //
      // The edited segment goes back *into* the document rather than replacing
      // it. `segments: [segment]` was the old version and it was correct only
      // for a document with one segment: a profile with three lost the other two
      // every time someone pressed Find from this screen, with a success toast
      // and no undo. "Find more" builds the second segment, so the loss was
      // reachable in ordinary use and not by any unusual sequence.
      const merged = mergeSegment(doc, segment);
      const next = { ...doc, summary, ...merged };
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
              <Globe className="w-3.5 h-3.5 text-faint flex-shrink-0" />
              <span className="text-xs font-mono text-ink truncate">
                {profile?.website || 'no website on file'}
              </span>
            </div>
            <p className="text-[11px] font-mono text-muted leading-relaxed">
              {profile?.core_offer || 'No description of what you sell on file yet.'}
            </p>
          </div>

          {/* Present and disabled, with the reason attached. Omitting it would
              read as a feature that does not exist; this reads as one waiting on
              a provider, which is what it is. */}
          <button
            disabled
            title="Reading your site needs the data provider, which is not connected yet."
            className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 border border-line text-[10px] font-mono uppercase tracking-wider text-faint cursor-not-allowed"
          >
            <Sparkles className="w-3 h-3" />
            Read my site
          </button>
        </div>

        {loading ? (
          <p className="text-[10px] font-mono text-faint mt-3 pt-3 border-t border-line-soft">
            looking for a profile you already saved…
          </p>
        ) : doc ? (
          <p className="text-[10px] font-mono text-ok mt-3 pt-3 border-t border-line-soft">
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
            <label className="block text-[10px] font-mono uppercase tracking-wider text-muted mb-1.5">
              Give this search a name
            </label>
            <Input
              value={segment.name ?? ''}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="UK accounting firms"
            />
          </div>

          <div>
            <label className="block text-[10px] font-mono uppercase tracking-wider text-muted mb-1.5">
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

          <div>
            <ChipChoice
              label="Company size"
              options={SIZES}
              value={size ?? customSize}
              onChange={(v) => patch({ employeeRange: sizeBoundsOf(v) })}
            />
            {/* A size the bands do not cover, or one that is not a number. Both
                used to be invisible: the first left nothing selected with no
                explanation, the second left nothing selected and then failed the
                run with a message about the profile rather than the form. */}
            {customSize && (
              <p className="text-[10px] font-mono text-muted mt-1.5">
                {customSize} — not one of the bands above, and it will be searched on as it is.
              </p>
            )}
            {junkSize && (
              <p className="text-[10px] font-mono text-danger-ink mt-1.5">
                The company size on this profile is not a number. Pick a band above to fix it — a
                search cannot use it as it is.
              </p>
            )}
          </div>
        </div>
      </Panel>

      <Panel label="What this costs">
        <div className="space-y-5">
          <div className="flex items-center gap-4 flex-wrap">
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted">
              How many leads
            </span>
            <div className="flex gap-1">
              {COUNT_PRESETS.map((n) => (
                <button
                  key={n}
                  onClick={() => setTarget(n)}
                  className={`px-2.5 py-1 text-[10px] font-mono border transition-colors cursor-pointer ${
                    target === n
                      ? 'bg-ink text-white border-ink'
                      : 'border-line text-muted hover:border-ink hover:text-ink'
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
              className="w-20 bg-transparent text-xs font-mono text-ink border border-line px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ink tabular-nums"
            />
          </div>

          {/* A spinner that never stops is a lie about the state. When there is
              no price and none is coming, the figures say so rather than
              implying they are about to arrive. */}
          <div className="flex gap-10 sm:gap-16">
            <Figure
              label="Likely"
              value={figure(estimate, 'expected_credits', pricing)}
              sub={estimate ? formatUsd(estimate.min_credits) + ' at the floor' : undefined}
            />
            <Figure
              label="At most"
              value={figure(estimate, 'max_credits', pricing)}
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

          {estimateError && (
            <div className="flex items-start gap-2 text-[10px] font-mono text-danger-ink leading-relaxed">
              <CircleAlert className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>{estimateError}</span>
            </div>
          )}

          {/* Two separate things, and they were one message that was wrong about
              both.

              Not enough to search on is a hard stop: the worker refuses a profile
              with no name, industry or keyword, so the button says so instead of
              letting someone press it and watch a run fail with no rows. The old
              copy said the search "will run without one, and return whatever the
              providers consider a match", which is not what happens and never
              was.

              Not enough credits is the same shape of problem — a button that will
              not do the thing — but the fix is different, so it gets its own
              line and its own link. */}
          {!enoughToSearch && !junkSize && (
            <div className="flex items-start gap-2 text-[10px] font-mono text-warn leading-relaxed">
              <CircleAlert className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>
                There is nothing to search for yet. Give this search a name, an industry or a
                keyword — the name you typed is enough on its own — and the search will use it.
              </span>
            </div>
          )}

          {enoughToSearch && searchText && (
            <p className="text-[10px] font-mono text-muted leading-relaxed">
              Searching for: <span className="text-ink">{searchText}</span>
              {segment.targetTitles?.length ? (
                <> · decision makers with {segment.targetTitles.join(', ')}</>
              ) : null}
            </p>
          )}

          <div className="flex items-center gap-4 pt-1 flex-wrap">
            <div className="flex items-stretch">
              {/* Disabled, and each reason stated above rather than left to be
                  discovered. A disabled control with no explanation is the one
                  thing on a pricing screen that guarantees the user cannot tell
                  whether the product is broken or they are being charged too
                  much. */}
              <Button
                onClick={() => void start()}
                disabled={busy || pricing || !estimate || !enoughToSearch || junkSize}
                className="!px-6"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                Find {target.toLocaleString()} leads
              </Button>

              {/* The unit price on the button, because it answers a different
                  question from the total and is the one that decides whether the
                  thing is worth doing. Fifty credits is "can I afford this"; the
                  per-lead figure is "is this worth doing". */}
              {estimate && !pricing && (
                <span className="inline-flex items-center px-3 bg-ink text-white text-[10px] font-mono border-l border-white/20 whitespace-nowrap">
                  about {formatUnitPrice(estimate.expected_credits, target)} each
                </span>
              )}
            </div>

            {estimate && (
              <span className="text-[10px] font-mono text-muted">a miss costs nothing</span>
            )}
          </div>

          {/* The hold, stated in one sentence.
              We reserve the worst case before the first provider call and settle
              down afterwards, and until now the screen said nothing about it. A
              user who reads "at most 61 credits", watches 61 leave their balance,
              and is never told otherwise has every reason to think we took the
              money and did not do the work. This is the line that prevents that. */}
          {estimate && !pricing && (
            <p className="text-[11px] font-mono text-muted leading-relaxed pt-4 border-t border-line-soft">
              The most it can cost is held when the search starts, and whatever it does not spend
              comes straight back when it ends. You are only charged for what it finds.
            </p>
          )}

          {error && (
            <div className="flex items-start gap-2 px-3 py-2.5 bg-danger-bg border border-danger-line">
              <CircleAlert className="w-3.5 h-3.5 text-danger-ink mt-0.5 flex-shrink-0" />
              <span className="text-xs font-mono text-danger-ink">{error}</span>
            </div>
          )}
        </div>
      </Panel>

      <p className="text-[10px] font-mono text-muted leading-relaxed max-w-2xl">
        A search looks up companies, then the person who would buy at each, then an address for
        them, cheapest provider first. You are charged for what it finds, and the figure above is
        the most it can cost before it starts.
      </p>
    </Screen>
  );
};

// ---------------------------------------------------------------------------

/**
 * One of the two price figures.
 *
 * Three states, and they used to be two: loading showed a spinner and so did
 * "there is no price", so a failed estimate left three spinners turning
 * indefinitely on a screen that was not going to load anything. A dash with the
 * reason two lines below is the honest rendering of "there is no price".
 */
function figure(
  estimate: { expected_credits: number; max_credits: number } | null,
  field: 'expected_credits' | 'max_credits',
  pricing: boolean,
) {
  if (estimate) return formatCredits(estimate[field]);
  if (pricing) return <Loader2 className="w-5 h-5 animate-spin text-faint" />;
  return <span className="text-faint">—</span>;
}

/**
 * A company size that is a real range but not one of the bands.
 *
 * Only ever used when sizeLabelOf declined to answer, so the range is a pair of
 * finite numbers in the right order — anything else is reported as junk instead.
 */
function customSizeLabel(range: LeadIcpSegment['employeeRange']): string {
  if (!range || range.length !== 2) return '';
  const lo = Number(range[0]);
  const hi = Number(range[1]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return '';
  // The open-ended band, spelled the way the person would.
  if (hi >= 999999) return `${lo.toLocaleString()}+`;
  return `${lo.toLocaleString()}–${hi.toLocaleString()}`;
}
 /**
 * The price of one lead, as it will read on the button.
 *
 * Kept separate from the figure above because it answers a different question
 * from the total: the total is "can I afford this", the per-lead figure is "is
 * this worth doing". A search that costs 61 credits is affordable and useless at
 * fifty leads and cheap at five hundred.
 *
 * One decimal, because the second is noise on a screen where the total is
 * sitting two inches above - 16.6 tells you the order of magnitude and whether it
 * is worth it, and 16.63 pretends to a precision a 70% default cannot have.
 *
 * Zero is shown as "less than one" rather than 0. Because that is what it means
 * - the expected total came out under one credit for the whole search - and a
 * rounded "0 each" reads as free when it is merely cheap.
 */
function formatUnitPrice(total: number, count: number): string {
  if (count <= 0) return '—';
  const each = total / count;
  if (each === 0) return 'less than one';
  if (each < 0.05) return each.toFixed(2);
  return each.toFixed(1);
}
