import React from 'react';
import { Download, ChevronDown, Loader2 } from 'lucide-react';
import type { LeadRow } from '../../types';
import { getRun } from '../../lib/leads';
import {
  downloadCsv,
  downloadXlsx,
  exportFilename,
  type ExportColumn,
} from '../../lib/leads-csv';
import { emailStatusLabel } from '../../lib/leads';

/**
 * Get the rows out.
 *
 * CSV and Excel, with the choice about what goes in the file made before it is
 * downloaded rather than afterwards in a spreadsheet. The one that matters is
 * verified-only: someone handing this list to an outreach tool will send to every
 * address in it, so "catch-all" and "invalid" in a file is a bounce rate they
 * inherit and a sender reputation that takes months to recover.
 *
 * Attempt history is included by default. It is extra columns the user did not
 * ask for, and it is why the export is auditable: which provider found each
 * address, and what it cost, is the difference between a waterfall they can check
 * and one they have to take on trust.
 */

/** Fixed-width page, because get_run pages and the file has to come out whole. */
const PAGE = 500;
const MAX_ROWS = 20000;

export interface ExportOptions {
  verifiedOnly: boolean;
  includeCatchAll: boolean;
  includeAttempts: boolean;
}

const DEFAULTS: ExportOptions = {
  verifiedOnly: false,
  includeCatchAll: true,
  includeAttempts: true,
};

/** The columns, in the order someone reads them. */
function columnsFor(opts: ExportOptions, passthrough: string[]): ExportColumn[] {
  const cols: ExportColumn[] = [
    { header: 'Email', value: (r: any) => r.email ?? '' },
    { header: 'Status', value: (r: any) => emailStatusLabel(r.email_status).label },
    { header: 'Name', value: (r: any) => r.person_name ?? '' },
    { header: 'Title', value: (r: any) => r.title ?? '' },
    { header: 'Company', value: (r: any) => r.company_name ?? '' },
    { header: 'Domain', value: (r: any) => r.domain ?? '' },
    { header: 'LinkedIn', value: (r: any) => r.linkedin_url ?? '' },
  ];

  if (opts.includeAttempts) {
    cols.push(
      { header: 'Found by', value: (r: any) => r.email_provider ?? '' },
      { header: 'Credits', value: (r: any) => r.credits ?? 0 },
    );
  }

  // Whatever the file brought in comes back out, under its own header. A clean
  // that silently deletes the user's own notes is a clean they will not trust
  // and will not pay for twice.
  for (const h of passthrough) {
    cols.push({ header: h, value: (r: any) => r.extra?.[h] ?? '' });
  }

  return cols;
}

/** Everything except rows the user said to leave out. */
function keepRow(r: LeadRow, opts: ExportOptions): boolean {
  if (r.state !== 'done' && r.state !== 'skipped' && r.state !== 'failed') return false;
  if (!r.email) return false;
  if (opts.verifiedOnly) return r.email_status === 'verified';
  if (!opts.includeCatchAll && (r.email_status === 'catch_all' || r.email_status === 'unknown')) {
    return false;
  }
  return true;
}

interface ExportMenuProps {
  runId: string;
  /** Shown in the tooltip on the count, so the button's number is explainable. */
  rowCount?: number;
}

export const ExportMenu: React.FC<ExportMenuProps> = ({ runId, rowCount }) => {
  const [open, setOpen] = React.useState(false);
  const [opts, setOpts] = React.useState<ExportOptions>(DEFAULTS);
  const [busy, setBusy] = React.useState<'csv' | 'xlsx' | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const ref = React.useRef<HTMLDivElement>(null);

  // Close on an outside click. A menu that stays open behind the next screen is
  // a menu that gets clicked twice.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const doExport = async (format: 'csv' | 'xlsx') => {
    setBusy(format);
    setNote(null);
    setOpen(false);

    try {
      // Paged, because a run can be far larger than one response and a partial
      // file that looks complete is the worst outcome here — it is a list
      // somebody sends emails to.
      const all: LeadRow[] = [];
      const passthrough = new Set<string>();

      for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
        const res = await getRun(runId, { limit: PAGE, offset });
        if (!res.ok) throw new Error(res.error);

        all.push(...res.rows);
        for (const r of res.rows) {
          for (const k of Object.keys(r.extra ?? {})) passthrough.add(k);
        }

        if (all.length >= res.total || res.rows.length < PAGE) break;
      }

      const kept = all.filter((r) => keepRow(r, opts));
      if (kept.length === 0) {
        setNote('Nothing in this run met those options. Untick verified-only, or wait for the run to finish.');
        setBusy(null);
        return;
      }

      const cols = columnsFor(opts, [...passthrough].sort());
      const name = exportFilename(runId, kept.length, format);

      if (format === 'csv') {
        downloadCsv(cols, kept, name);
      } else {
        await downloadXlsx(cols, kept, name);
      }

      if (all.length >= MAX_ROWS) {
        setNote(`Exported the first ${MAX_ROWS.toLocaleString()} rows. This run is larger than that.`);
      } else if (kept.length < all.length) {
        setNote(
          `${kept.length.toLocaleString()} of ${all.length.toLocaleString()} rows exported — the rest had no address or were still being worked.`,
        );
      }
      setBusy(null);
    } catch (err) {
      setNote((err as Error)?.message ?? 'The export did not finish.');
      setBusy(null);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy !== null}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#e3e3de] text-[10px] font-mono uppercase tracking-wider text-[#4a4a47] hover:border-[#141414] hover:text-[#141414] transition-colors cursor-pointer disabled:opacity-40 rounded-none"
      >
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
        {busy ? (busy === 'csv' ? 'csv' : 'xlsx') : 'Export'}
        {!busy && <ChevronDown className="w-3 h-3 text-[#8a8a86]" />}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-72 bg-white border border-[#e3e3de] shadow-lg">
          <div className="px-3 py-2 border-b border-[#e3e3de]">
            <span className="text-[10px] font-mono uppercase tracking-wider text-[#8a8a86]">
              What goes in the file
            </span>
          </div>

          <div className="divide-y divide-[#eeeeea]">
            <label className="flex items-start gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-[#fbfbfa]">
              <input
                type="checkbox"
                checked={opts.verifiedOnly}
                onChange={(e) => setOpts({ ...opts, verifiedOnly: e.target.checked })}
                className="mt-0.5 accent-[#141414]"
              />
              <span>
                <span className="block text-[10px] font-mono text-[#141414]">Verified addresses only</span>
                <span className="block text-[9px] font-mono text-[#8a8a86] mt-0.5 leading-relaxed">
                  Catch-all and unknown addresses go in at a guessed mailbox. Sending to them is what
                  gets a domain flagged.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-[#fbfbfa]">
              <input
                type="checkbox"
                checked={opts.includeCatchAll}
                disabled={opts.verifiedOnly}
                onChange={(e) => setOpts({ ...opts, includeCatchAll: e.target.checked })}
                className="mt-0.5 accent-[#141414] disabled:opacity-40"
              />
              <span className={opts.verifiedOnly ? 'opacity-40' : ''}>
                <span className="block text-[10px] font-mono text-[#141414]">Include catch-all</span>
                <span className="block text-[9px] font-mono text-[#8a8a86] mt-0.5 leading-relaxed">
                  Looked up and confirmed as a pattern, not as a person&rsquo;s mailbox.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-[#fbfbfa]">
              <input
                type="checkbox"
                checked={opts.includeAttempts}
                onChange={(e) => setOpts({ ...opts, includeAttempts: e.target.checked })}
                className="mt-0.5 accent-[#141414]"
              />
              <span>
                <span className="block text-[10px] font-mono text-[#141414]">Found by, and cost</span>
                <span className="block text-[9px] font-mono text-[#8a8a86] mt-0.5 leading-relaxed">
                  Which provider found each address and what it charged, so the waterfall is auditable.
                </span>
              </span>
            </label>
          </div>

          <div className="border-t border-[#e3e3de] p-2 flex gap-2">
            <button
              onClick={() => void doExport('csv')}
              className="flex-1 px-3 py-1.5 bg-[#141414] hover:bg-black text-white text-[10px] font-mono uppercase tracking-wider transition-colors cursor-pointer"
            >
              CSV
            </button>
            <button
              onClick={() => void doExport('xlsx')}
              className="flex-1 px-3 py-1.5 border border-[#e3e3de] text-[#4a4a47] hover:border-[#141414] hover:text-[#141414] text-[10px] font-mono uppercase tracking-wider transition-colors cursor-pointer"
            >
              Excel
            </button>
          </div>

          {rowCount !== undefined && (
            <p className="px-3 py-2 border-t border-[#eeeeea] text-[9px] font-mono text-[#b5b5ad]">
              {rowCount.toLocaleString()} rows in this run
            </p>
          )}
        </div>
      )}

      {note && (
        <div className="absolute right-0 top-full mt-1 z-20 w-72 bg-white border border-[#e3e3de] px-3 py-2 shadow-lg">
          <p className="text-[10px] font-mono text-[#4a4a47] leading-relaxed">{note}</p>
          <button
            onClick={() => setNote(null)}
            className="mt-1 text-[10px] font-mono text-[#8a8a86] hover:text-[#141414] underline cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
};