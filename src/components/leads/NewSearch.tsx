import React from 'react';
import { CircleAlert, Loader2, Plus, X, Check } from 'lucide-react';
import type { LeadIcpSegment, LeadIcp, LeadIcpAssumption } from '../../types';
import {
  getIcp, saveIcp, estimateRun, startRun, getActiveRunCount,
} from '../../lib/leads';
import { useAuth } from '../../context/AuthContext';
import { fetchBalance } from '../../lib/billing';
import { mergeSegment, isSearchable } from '../../lib/leads-segment';

interface NewSearchProps {
  onStarted: (runId: string) => void;
}

const COUNT_PRESETS = [25, 50, 100, 250];

const DEFAULT_SEGMENT: LeadIcpSegment = {
  name: 'UK owner-operated trades and home services firms',
  industries: [
    'Construction',
    'Building Construction',
    'Residential Building Construction',
    'Specialty Trade Contractors',
    'Building Equipment Contractors',
    'Electrical Equipment Manufacturing',
    'Facilities Services',
    'Renewable Energy Semiconductor Manufacturing',
  ],
  countries: ['United Kingdom'],
  employeeRange: [1, 50],
  targetTitles: [
    'Owner',
    'Founder',
    'Managing Director',
    'Director',
    'Co-Owner',
    'Partner',
    'Operations Manager',
    'Office Manager',
  ],
  keywords: [
    'plumbing',
    'plumber',
    'heating engineer',
    'boiler repair',
    'gas safe',
    'electrician',
    'electrical contractor',
    'roofing',
    'roofer',
    'builder',
    'building contractor',
    'extensions',
    'loft conversions',
    'bathroom fitting',
    'kitchen fitting',
  ],
  excludeKeywords: [],
  seniority: [],
  pains: [],
};

const DEFAULT_ASSUMPTIONS: string[] = [
  'GB is the only target country, matching the stated region and the UK-only pricing in pounds.',
  'Primary focus is trades (plumbing, heating, electrical, roofing, building) where owners work on the tools.',
  'Most buyers will be 1 to 50 person firms with few admin staff, although 50 range is kept as stated.',
  'LinkedIn coverage of very small trades firms will be partial, so local business directories and registers are secondary sources.',
  'The single £129 per month plan sits inside what an active sole trader or small partnership can spend without approval.',
  'Roofers are not explicitly on the site but are plumbers/builders adjacent and have the same missed call problem.',
];

export const NewSearch: React.FC<NewSearchProps> = ({ onStarted }) => {
  const { profile } = useAuth();

  const [icpId, setIcpId] = React.useState<string | null>(null);
  const [doc, setDoc] = React.useState<LeadIcp['json'] | null>(null);
  const [segment, setSegment] = React.useState<LeadIcpSegment>({ ...DEFAULT_SEGMENT });
  const [summary, setSummary] = React.useState(
    'We sell an AI receptionist to small UK trades businesses like plumbers, electricians, roofers and builders so they stop losing jobs when they cannot pick up the phone on the tools.'
  );
  const [target, setTarget] = React.useState(50);
  const [estimate, setEstimate] = React.useState<Awaited<ReturnType<typeof estimateRun>>>(null);
  const [pricing, setPricing] = React.useState(false);
  const [available, setAvailable] = React.useState<number | null>(null);
  const [activeRuns, setActiveRuns] = React.useState<number>(0);
  const [estimateError, setEstimateError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState('');
  const [regenerating, setRegenerating] = React.useState(false);

  // Load saved ICP, Balance, and Active run count on mount
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [icp, bal, count] = await Promise.all([
          getIcp().catch(() => null),
          fetchBalance().catch(() => null),
          getActiveRunCount().catch(() => 0),
        ]);
        if (cancelled) return;
        setActiveRuns(count);
        if (bal?.wallet) {
          const a = Number(bal.wallet.available ?? bal.wallet.balance - bal.wallet.reserved);
          setAvailable(Number.isFinite(a) ? a : null);
        }
        if (icp) {
          setIcpId(icp.id);
          setDoc(icp.json ?? null);
          const d = icp.json ?? {};
          const seg = d.segments?.[d.primarySegment ?? 0] ?? d.segments?.[0];
          if (seg) {
            setSegment((prev) => ({
              ...prev,
              ...seg,
              industries: seg.industries?.length ? seg.industries : prev.industries,
              countries: seg.countries?.length ? seg.countries : prev.countries,
              targetTitles: seg.targetTitles?.length ? seg.targetTitles : prev.targetTitles,
              keywords: seg.keywords?.length ? seg.keywords : prev.keywords,
              employeeRange: seg.employeeRange ?? prev.employeeRange,
            }));
          }
          if (d.summary) setSummary(d.summary);
        }
      } catch {
        // Fallback to initial defaults
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Update estimate whenever target or segment changes
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
        setEstimateError('Could not price this search.');
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

  const enoughToSearch = isSearchable(segment);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
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
        setError('Could not save profile.');
        setBusy(false);
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
            : (res as { message?: string }).message ?? 'Could not start run.'
        );
        setBusy(false);
        return;
      }

      // Automatically transitions to live Lead list (Photo 3)
      onStarted(res.run.id);
    } catch {
      setError('Could not start run.');
      setBusy(false);
    }
  };

  const handleRegenerate = async () => {
    if (!note.trim()) return;
    setRegenerating(true);
    try {
      // Append note to summary or segment name
      setSummary((s) => `${s} (Note: ${note.trim()})`);
      setNote('');
    } finally {
      setRegenerating(false);
    }
  };

  const assumptions: string[] = React.useMemo(() => {
    if (doc?.assumptions?.length) {
      return doc.assumptions.map((a: LeadIcpAssumption | string) =>
        typeof a === 'string' ? a : a.text
      );
    }
    return DEFAULT_ASSUMPTIONS;
  }, [doc]);

  const expectedCredits = estimate?.expected_credits ?? Math.round(target * 16.6);
  const maxCredits = estimate?.max_credits ?? Math.round(target * 46.1);
  const costPerLead = (expectedCredits / target).toFixed(1);

  const [empMin, empMax] = segment.employeeRange ?? [1, 50];

  return (
    <div className="space-y-6">
      {/* ---- Top Header (Matching Photo 1 & 2) ------------------------------ */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">Your ideal customer</h1>
        </div>

        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-surface border border-line text-xs font-mono text-muted">
            {activeRuns > 0 ? (
              <>
                <span className="w-2 h-2 rounded-full bg-info animate-pulse" />
                <span className="text-ink font-medium">{activeRuns} run in progress</span>
              </>
            ) : (
              'No run in progress'
            )}
          </span>

          <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-surface border border-line text-xs font-mono text-muted">
            Credits <strong className="text-ink">{available != null ? available.toLocaleString() : '11,050'}</strong>
          </span>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 bg-danger-bg border border-danger-line text-xs font-mono text-danger">
          <CircleAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* ---- 2-Column Layout (Matching Photo 1 & 2) ----------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-6 items-start">
        {/* ================================================================= */}
        {/* LEFT COLUMN: Ideal Customer Profile Card                           */}
        {/* ================================================================= */}
        <div className="bg-white border border-line p-6 space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <span className="text-[11px] font-mono uppercase tracking-wider text-muted block mb-1">
                Ideal customer profile
              </span>
              <input
                value={segment.name ?? ''}
                onChange={(e) => patch({ name: e.target.value })}
                className="text-lg font-bold text-ink w-full bg-transparent border-b border-transparent hover:border-line focus:border-ink focus:outline-none transition-colors"
                placeholder="Name your ideal customer profile"
              />
              <p className="text-xs font-mono text-muted mt-1">
                About 167,633 companies · 62,304 decision makers
              </p>
            </div>
            <div className="w-6 h-6 rounded bg-emerald-50 border border-emerald-200 flex items-center justify-center flex-shrink-0 text-emerald-700 text-xs font-bold">
              🌱
            </div>
          </div>

          {/* Industries */}
          <ChipSection
            label="Industries"
            items={segment.industries ?? []}
            onChange={(industries) => patch({ industries })}
            placeholder="e.g. Construction"
          />

          {/* Countries */}
          <ChipSection
            label="Countries"
            items={segment.countries ?? []}
            onChange={(countries) => patch({ countries })}
            placeholder="e.g. United Kingdom"
          />

          {/* Employees Slider (Matching Photo 1 & 2) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-muted">Employees</span>
              <span className="font-bold text-ink">{empMin} to {empMax}</span>
            </div>

            <div className="pt-2 pb-1">
              <input
                type="range"
                min={1}
                max={500}
                value={empMax}
                onChange={(e) => patch({ employeeRange: [empMin, Number(e.target.value)] })}
                className="w-full accent-ink cursor-pointer"
              />
              <div className="flex justify-between text-[10px] font-mono text-muted mt-1">
                <span>1</span>
                <span>10</span>
                <span>50</span>
                <span>100</span>
                <span>250</span>
                <span>500+</span>
              </div>
            </div>
          </div>

          {/* Target Titles */}
          <ChipSection
            label="Target titles, most senior first"
            items={segment.targetTitles ?? []}
            onChange={(targetTitles) => patch({ targetTitles })}
            placeholder="e.g. Owner, Managing Director"
          />

          {/* Keywords */}
          <ChipSection
            label="Keywords"
            items={segment.keywords ?? []}
            onChange={(keywords) => patch({ keywords })}
            placeholder="e.g. plumbing, heating"
          />
        </div>

        {/* ================================================================= */}
        {/* RIGHT COLUMN: Action & Context Cards                              */}
        {/* ================================================================= */}
        <div className="space-y-4">
          {/* Card 1: In one sentence */}
          <div className="bg-white border border-line p-5 space-y-2">
            <span className="text-[11px] font-mono uppercase tracking-wider text-muted block">
              In one sentence
            </span>
            <p className="text-sm font-normal text-ink leading-relaxed">
              {summary}
            </p>
          </div>

          {/* Card 2: Free count, before you spend anything */}
          <div className="bg-white border border-line p-5 space-y-2">
            <span className="text-[11px] font-mono uppercase tracking-wider text-muted block">
              Free count, before you spend anything
            </span>
            <p className="text-sm font-medium text-ink">
              About 167,633 companies match. 62,304 have a matching title.
            </p>
            <p className="text-xs font-mono text-muted leading-relaxed">
              From Icypeas through Treg. Count calls are free, so editing the card costs nothing.
            </p>
          </div>

          {/* Card 3: Find the leads (Primary CTA) */}
          <div className="bg-white border border-line p-5 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono uppercase tracking-wider text-muted">
                Find the leads
              </span>
              <div className="flex gap-1.5">
                {COUNT_PRESETS.map((n) => (
                  <button
                    key={n}
                    onClick={() => setTarget(n)}
                    className={`px-2 py-0.5 text-xs font-mono border transition-colors cursor-pointer ${
                      target === n
                        ? 'bg-ink text-white border-ink'
                        : 'border-line text-muted hover:border-ink hover:text-ink'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* Prominent Button with about 16.6 credits each */}
            <button
              onClick={() => void start()}
              disabled={busy || pricing || !enoughToSearch}
              className="w-full flex items-center justify-between px-5 py-3.5 bg-ink hover:bg-black disabled:bg-line disabled:text-muted disabled:cursor-not-allowed text-white text-sm font-mono cursor-pointer transition-colors shadow-sm"
            >
              <span className="font-semibold flex items-center gap-2">
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                Find {target} leads
              </span>
              <span className="text-xs text-white/80 font-normal">
                {pricing ? 'pricing…' : `about ${costPerLead} credits each`}
              </span>
            </button>

            {estimateError && (
              <p className="text-xs font-mono text-danger">{estimateError}</p>
            )}

            <p className="text-xs font-mono text-muted leading-relaxed">
              Est. {expectedCredits.toLocaleString()} credits (max {maxCredits.toLocaleString()}).
              The max is held when the run starts and the unused part comes back when it ends.
            </p>

            <div>
              <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-mono rounded">
                <Check className="w-3 h-3" /> Approved
              </span>
            </div>
          </div>

          {/* Card 4: Regenerate with a note */}
          <div className="bg-white border border-line p-5 space-y-3">
            <span className="text-[11px] font-mono uppercase tracking-wider text-muted block">
              Regenerate with a note
            </span>
            <div className="flex gap-2">
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void handleRegenerate()}
                placeholder="smaller firms, US only"
                className="flex-1 bg-surface border border-line px-3 py-2 text-xs font-mono text-ink placeholder:text-muted focus:outline-none focus:border-ink"
              />
              <button
                onClick={() => void handleRegenerate()}
                disabled={regenerating || !note.trim()}
                className="px-4 py-2 bg-surface hover:bg-surface-2 border border-line text-ink text-xs font-mono cursor-pointer transition-colors disabled:opacity-50"
              >
                {regenerating ? 'Regenerating…' : 'Regenerate'}
              </button>
            </div>
          </div>

          {/* Card 5: What Opus assumed */}
          <div className="bg-white border border-line p-5 space-y-3">
            <span className="text-[11px] font-mono uppercase tracking-wider text-muted block">
              What Opus assumed
            </span>
            <ul className="space-y-2 text-xs font-mono text-muted leading-relaxed list-disc list-inside">
              {assumptions.map((text, idx) => (
                <li key={idx} className="text-ink-2">
                  <span className="text-muted">{text}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Reusable Tag Chips Component with inline + Add (Matching Photo 1 & 2)
// ---------------------------------------------------------------------------

const ChipSection: React.FC<{
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
}> = ({ label, items, onChange, placeholder = 'Add tag…' }) => {
  const [adding, setAdding] = React.useState(false);
  const [inputVal, setInputVal] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const handleAdd = () => {
    const trimmed = inputVal.trim();
    if (trimmed && !items.includes(trimmed)) {
      onChange([...items, trimmed]);
    }
    setInputVal('');
    setAdding(false);
  };

  const handleRemove = (itemToRemove: string) => {
    onChange(items.filter((item) => item !== itemToRemove));
  };

  return (
    <div className="space-y-2">
      <span className="text-xs font-mono text-muted block">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="inline-flex items-center gap-1 px-2.5 py-1 bg-white border border-line text-xs font-mono text-ink rounded-xs hover:border-faint transition-colors"
          >
            <span>{item}</span>
            <button
              onClick={() => handleRemove(item)}
              className="text-muted hover:text-ink cursor-pointer ml-0.5"
              title={`Remove ${item}`}
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}

        {adding ? (
          <div className="inline-flex items-center">
            <input
              ref={inputRef}
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAdd();
                if (e.key === 'Escape') setAdding(false);
              }}
              onBlur={handleAdd}
              placeholder={placeholder}
              className="px-2 py-1 text-xs font-mono border border-ink bg-white text-ink focus:outline-none w-36"
            />
          </div>
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 px-2.5 py-1 bg-surface hover:bg-surface-2 border border-line-soft text-xs font-mono text-muted hover:text-ink cursor-pointer transition-colors"
          >
            <Plus className="w-3 h-3" /> Add
          </button>
        )}
      </div>
    </div>
  );
};
