import React from 'react';
import { Upload, FileText, X, Loader2, Check } from 'lucide-react';
import type { LeadEstimate } from '../../types';
import {
  autoMap,
  applyMapping,
  dedupe,
  parseCsv,
  type MappedRow,
  type ParseResult,
} from '../../lib/leads-csv';
import { startRun, importRows, estimateRun, MAX_RUN_ROWS } from '../../lib/leads';
import { ColumnMapper, checkMapping, type CleanMode, type FieldKey } from './ColumnMapper';
import { Figure } from './Screen';
import { formatUsd } from '../../lib/billing';

/**
 * Import a list you already have.
 *
 * The order is deliberate: file, then mapping, then the price, then the run. The
 * estimate is only asked for once the row count is final — after de-duplication —
 * because de-duplication moves the count, and a price shown against a count that
 * later drops is a price for work that is not being done.
 *
 * The run is created before the rows are sent. That ordering is not arbitrary:
 * `import` refuses a run that does not belong to the caller, so there has to be
 * a run first, and creating the run is what prices and reserves against the
 * wallet. A run whose rows all fail to import is therefore still a run, sitting
 * in the list having cost nothing — visible rather than silently absent.
 */

/**
 * The three clean modes.
 *
 * These used to price differently and behave identically: the worker read
 * lead_runs.mode for nothing, so all three ran the same email waterfall, which
 * meant the cheapest one went out and found replacements for the rows it had
 * promised to leave alone and charged the find price for doing it.
 *
 * They now come from steps.ts, which is the same function the estimator and the
 * tests read, so the price shown and the work done cannot drift apart. Nothing
 * is read from lead_runs.mode in this file — the estimate is asked for the mode
 * and the worker is told it separately, and the two agree because they come from
 * one list of names.
 */
const MODES: Array<{ id: CleanMode; label: string; body: string; credits: string }> = [
  {
    id: 'verify_only',
    label: 'Check what I have',
    body: 'Verify the addresses in the file and leave the rows that fail alone.',
    credits: 'verification only',
  },
  {
    id: 'verify_refind',
    label: 'Check, then replace',
    body: 'Verify what is there, and look up a new address for every row that does not verify.',
    credits: 'verification, plus replacements where they fail',
  },
  {
    id: 'full_enrich',
    label: 'Fill in everything',
    body: 'Verify, refind, and add the company details and the person’s details.',
    credits: 'verification, replacements, and enrichment',
  },
];

interface CleanListProps {
  onOpenRun: (runId: string) => void;
}

type Stage = 'pick' | 'map' | 'importing';

export const CleanList: React.FC<CleanListProps> = ({ onOpenRun }) => {
  const [stage, setStage] = React.useState<Stage>('pick');
  const [file, setFile] = React.useState<File | null>(null);
  const [parsed, setParsed] = React.useState<ParseResult | null>(null);
  const [mode, setMode] = React.useState<CleanMode>('verify_refind');
  const [mapping, setMapping] = React.useState<Partial<Record<FieldKey, string>>>({});
  const [passthrough, setPassthrough] = React.useState<string[]>([]);
  const [estimate, setEstimate] = React.useState<LeadEstimate | null>(null);
  const [pricing, setPricing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<{ done: number; total: number; skipped: number } | null>(null);
  const [dragging, setDragging] = React.useState(false);

  const inputRef = React.useRef<HTMLInputElement>(null);

  // ---- Derived ------------------------------------------------------------

  const mapped = React.useMemo(() => {
    if (!parsed) return null;
    return applyMapping(parsed.rows, mapping, passthrough);
  }, [parsed, mapping, passthrough]);

  const clean = React.useMemo(() => (mapped ? dedupe(mapped.rows) : null), [mapped]);

  const usable = React.useMemo(() => {
    if (!clean) return 0;
    return clean.rows.filter((r) => r.email || (r.person_name && r.domain) || r.company_name || r.domain).length;
  }, [clean]);

  // Above the ceiling, and the difference is not silently dropped.
  const overCap = usable > MAX_RUN_ROWS;

  const mappingCheck = checkMapping(mapping, mode);

  // ---- Price --------------------------------------------------------------

  // Asked for whenever the count settles, so the number on the button is the
  // number the run will be started against.
  React.useEffect(() => {
    if (!clean || usable === 0) {
      setEstimate(null);
      return;
    }
    let cancelled = false;
    setPricing(true);

    estimateRun({ kind: 'clean', target: Math.min(usable, MAX_RUN_ROWS), mode })
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
  }, [usable, mode]);

  // ---- File ---------------------------------------------------------------

  const load = async (f: File) => {
    setError(null);
    try {
      const result = await parseCsv(f);
      if (result.headers.length === 0) {
        setError('That file has no header row, so there is nothing to match columns against.');
        return;
      }
      const { mapping: auto, unmapped } = autoMap(result.headers);
      setFile(f);
      setParsed(result);
      setMapping(auto);
      setPassthrough(unmapped);
      setStage('map');
    } catch {
      setError('Could not read that file. A plain CSV works; if it is an Excel file, save it as CSV first.');
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void load(f);
  };

  // ---- Import -------------------------------------------------------------

  const run = async () => {
    if (!clean || usable === 0) return;
    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: clean.rows.length, skipped: 0 });

    try {
      // Capped to the same number the estimate was priced for. The surplus is
      // reported rather than dropped quietly — a file of 5,000 becoming a run of
      // 2,000 with no mention reads as data loss.
      // Sliced to the cap the run is priced for; the server refuses rows past it.
      const toImport = clean.rows
        .filter((r) => r.email || (r.person_name && r.domain) || r.company_name || r.domain)
        .slice(0, MAX_RUN_ROWS);

      const started = await startRun({
        kind: 'clean',
        mode,
        target: toImport.length,
        name: file ? `${file.name.replace(/\.[^.]+$/, '')}` : 'Cleaned list',
      });

      if (!started.ok) {
        setError(
          started.message ??
            (started.error === 'insufficient_credits'
              ? 'Not enough credits for the worst case of this list. Top up and try again.'
              : 'Could not start the run.'),
        );
        setBusy(false);
        setProgress(null);
        return;
      }

      const runId = started.run.id;

      // Batches of 1000, because the function slices to that. A batch larger than
      // the cap would be truncated and every row past it would vanish without an
      // error, so the batching is the caller's job and is done here.
      let done = 0;
      let skipped = 0;

      for (let i = 0; i < toImport.length; i += 1000) {
        const batch = toImport.slice(i, i + 1000);
        const res = await importRows(runId, batch as MappedRow[], i + 1000 >= toImport.length);
        if (!res.ok) throw new Error(res.error);
        done += res.inserted;
        skipped += res.skipped;
        setProgress({ done, total: toImport.length, skipped });
      }

      onOpenRun(runId);
    } catch (err) {
      setError((err as Error)?.message ?? 'The import did not finish.');
      setBusy(false);
      setProgress(null);
    }
  };

  const reset = () => {
    setStage('pick');
    setFile(null);
    setParsed(null);
    setMapping({});
    setPassthrough([]);
    setError(null);
    setProgress(null);
    setEstimate(null);
  };

  // -------------------------------------------------------------------------
  // 1. Pick a file
  // -------------------------------------------------------------------------

  if (stage === 'pick') {
    return (
      <div className="space-y-4">
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`bg-white border px-8 py-16 flex flex-col items-center text-center cursor-pointer transition-colors ${
            dragging ? 'border-ink' : 'border-line hover:border-faint'
          }`}
        >
          <Upload className={`w-5 h-5 ${dragging ? 'text-ink' : 'text-faint'}`} />
          <h3 className="text-sm font-bold tracking-tight text-ink mt-3">
            Drop a CSV here
          </h3>
          <p className="text-xs font-mono text-muted mt-2 max-w-sm leading-relaxed">
            People, companies, or both. Columns are matched automatically and you can correct them
            before anything runs.
          </p>
          <button
            className="mt-5 px-4 py-2 bg-ink hover:bg-black text-white text-xs font-mono transition-colors cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              inputRef.current?.click();
            }}
          >
            Choose a file
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void load(f);
            }}
          />
        </div>

        {error && <p className="text-xs font-mono text-danger">{error}</p>}

        <div className="bg-white border border-line px-6 py-5">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted">
            What each mode does
          </span>
          <div className="grid grid-cols-3 gap-4 mt-3">
            {MODES.map((m) => (
              <div key={m.id}>
                <p className="text-[11px] font-mono text-ink">{m.label}</p>
                <p className="text-[10px] font-mono text-muted mt-1 leading-relaxed">{m.body}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // 2. Map, dedupe, price
  // -------------------------------------------------------------------------

  return (
    <div className="space-y-4">
      {/* What was loaded */}
      <div className="bg-white border border-line px-4 py-3 flex items-center gap-3">
        <FileText className="w-3.5 h-3.5 text-muted shrink-0" />
        <span className="text-xs font-mono text-ink truncate">{file?.name}</span>
        <span className="text-[10px] font-mono text-muted">
          {parsed?.rows.length ?? 0} rows · {parsed?.headers.length ?? 0} columns
        </span>
        {parsed && parsed.malformed > 0 && (
          <span
            className="text-[10px] font-mono text-warn"
            title="Some lines did not split into the same number of fields. They were read as far as they went."
          >
            {parsed.malformed} unreadable lines
          </span>
        )}
        <button
          onClick={reset}
          disabled={busy}
          className="ml-auto text-[10px] font-mono text-muted hover:text-ink underline cursor-pointer disabled:opacity-40"
        >
          Choose another
        </button>
      </div>

      {/* Worth knowing before choosing, because it decides the bill. */}
      <div className="bg-white border border-line px-4 py-2.5">
        <p className="text-[10px] font-mono text-muted leading-relaxed">
          Verification is charged per row whatever the answer turns out to be — you are buying the
          check, not the result. A replacement is charged on top, and only for the rows whose address
          did not survive.
        </p>
      </div>

      {/* Mode */}
      <div className="bg-white border border-line px-4 py-3">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted block mb-2">
          What to do
        </span>
        <div className="flex flex-col gap-1.5">
          {MODES.map((m) => (
            <label
              key={m.id}
              className={`flex items-start gap-2.5 px-3 py-2 border cursor-pointer transition-colors ${
                mode === m.id
                  ? 'border-ink bg-surface'
                  : 'border-line hover:border-faint'
              }`}
            >
              <input
                type="radio"
                name="clean-mode"
                checked={mode === m.id}
                onChange={() => setMode(m.id)}
                className="mt-0.5 accent-ink"
              />
              <span>
                <span className="block text-[11px] font-mono text-ink">{m.label}</span>
                <span className="block text-[10px] font-mono text-muted mt-0.5 leading-relaxed">
                  {m.body}
                </span>
                <span className="block text-[9px] font-mono text-faint mt-0.5">{m.credits}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <ColumnMapper
        headers={parsed?.headers ?? []}
        sample={parsed?.rows.slice(0, 20) ?? []}
        mapping={mapping}
        onChange={setMapping}
        mode={mode}
      />

      {/* What survived */}
      <div className="bg-white border border-line px-4 py-3 flex items-center gap-6 flex-wrap">
        <Figure size="sm" label="In file" value={parsed?.rows.length ?? 0} />
        <Figure
          size="sm"
          label="Duplicates"
          value={clean?.removed ?? 0}
          tone={clean?.removed ? 'warn' : 'default'}
          title="The same address twice, or the same name at the same domain twice. Removed before the run, so you are not billed for them."
        />
        <Figure
          size="sm"
          label="No address"
          value={clean?.unusable ?? 0}
          tone={clean?.unusable ? 'bad' : 'default'}
          title="Rows with nothing to look anyone up with — no address, no name, no company. They are kept in the file and skipped by the run."
        />
        <Figure size="sm" label="To work" value={usable} tone={usable ? 'default' : 'bad'} />
      </div>

      {overCap && (
        <div className="bg-warn-bg border border-warn-line px-4 py-3">
          <p className="text-[10px] font-mono text-warn leading-relaxed">
            This file has <span className="font-semibold">{usable.toLocaleString()}</span> workable
            rows. A run can be priced for at most {MAX_RUN_ROWS.toLocaleString()}, which is also the
            worst case the wallet is checked against, so the first{' '}
            {MAX_RUN_ROWS.toLocaleString()} will be imported and the rest left in your file. Split
            the file and run the remainder as a second clean if you need all of it.
          </p>
        </div>
      )}

      {/* Price */}
      <div className="bg-white border border-line px-4 py-3 flex items-center gap-6 flex-wrap">
        <div>
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted block leading-none">
            Likely
          </span>
          <span className="text-base font-bold tabular-nums text-ink">
            {pricing || !estimate ? (
              <Loader2 className="w-4 h-4 animate-spin text-faint" />
            ) : (
              `${estimate.expected_credits} cr`
            )}
          </span>
        </div>
        <div>
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted block leading-none">
            Most it can cost
          </span>
          <span className="text-base font-bold tabular-nums text-ink">
            {estimate ? `${estimate.max_credits} cr` : '—'}
          </span>
        </div>
        {estimate && (
          <span className="text-[10px] font-mono text-muted">
            {formatUsd(estimate.min_credits)} – {formatUsd(estimate.max_credits)}
          </span>
        )}
        <button
          onClick={() => void run()}
          disabled={busy || usable === 0 || !mappingCheck.ok || pricing || !estimate}
          className="ml-auto inline-flex items-center gap-2 px-4 py-2 bg-ink hover:bg-black disabled:bg-line disabled:text-muted disabled:cursor-not-allowed text-white text-xs font-mono transition-colors cursor-pointer"
        >
          {busy ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" />
              Importing
            </>
          ) : (
            <>
              <Check className="w-3 h-3" />
              Clean {Math.min(usable, MAX_RUN_ROWS).toLocaleString()} rows
            </>
          )}
        </button>
      </div>

      {!mappingCheck.ok && usable > 0 && (
        <p className="text-[10px] font-mono text-warn">
          This mode still needs {mappingCheck.missing.join(' or ')} mapped before it can run.
        </p>
      )}

      {progress && (
        <div className="bg-white border border-line px-4 py-3">
          <div className="flex items-center gap-3">
            <Loader2 className="w-3 h-3 animate-spin text-muted" />
            <span className="text-[10px] font-mono text-ink-2 tabular-nums">
              {progress.done.toLocaleString()} of {progress.total.toLocaleString()} imported
            </span>
            {progress.skipped > 0 && (
              <span
                className="text-[10px] font-mono text-muted"
                title="Matched something on your opt-outs list. Never written, never billed."
              >
                {progress.skipped.toLocaleString()} on your opt-outs
              </span>
            )}
          </div>
          <div className="h-1 w-full bg-line-soft mt-2">
            <div
              className="h-full bg-ink transition-[width] duration-300"
              style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="bg-danger-bg border border-danger-line px-4 py-3 flex items-start gap-2">
          <X className="w-3.5 h-3.5 text-danger shrink-0 mt-0.5" />
          <p className="text-xs font-mono text-danger">{error}</p>
        </div>
      )}
    </div>
  );
};