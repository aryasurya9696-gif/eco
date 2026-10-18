/**
 * Echo Leads — Unified Export Dialog
 * ---------------------------------------------------------------------------
 * A single, reusable dialog for exporting leads from runs or the CRM database.
 * Supports CSV and Excel (.xlsx) formats, quality filtering (verified only),
 * and provider attempt audit columns.
 */
import React from 'react';
import { Download, Loader2, FileSpreadsheet, FileText } from 'lucide-react';
import { Modal } from './Dialogs';
import { Button } from './Screen';
import {
  downloadCsv,
  downloadXlsx,
  exportFilename,
  type ExportColumn,
} from '../../lib/leads-csv';
import { emailStatusLabel, providerLabel, getRun } from '../../lib/leads';
import { queryContacts, type Contact, type ContactFilters, type Sort } from '../../lib/leads-db';
import type { LeadRow } from '../../types';

export interface ExportDialogProps {
  onClose: () => void;
  runId?: string | null;
  /** For CRM / PeopleView export */
  contactFilters?: ContactFilters;
  contactSort?: Sort;
  selectedIds?: string[];
  allMatching?: boolean;
  totalMatching?: number;
}

export const ExportDialog: React.FC<ExportDialogProps> = ({
  onClose,
  runId,
  contactFilters,
  contactSort,
  selectedIds = [],
  allMatching = false,
  totalMatching = 0,
}) => {
  const [format, setFormat] = React.useState<'csv' | 'xlsx'>('csv');
  const [verifiedOnly, setVerifiedOnly] = React.useState(false);
  const [includeCatchAll, setIncludeCatchAll] = React.useState(true);
  const [includeAttempts, setIncludeAttempts] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<string | null>(null);

  const isRunExport = Boolean(runId);
  const selectedCount = selectedIds.length;
  const countToExport = isRunExport
    ? totalMatching
    : (allMatching || selectedCount === 0 ? totalMatching : selectedCount);

  const startExport = async () => {
    setBusy(true);
    setError(null);
    setProgress('Fetching records…');

    try {
      if (isRunExport && runId) {
        // Run export
        const PAGE = 500;
        const MAX_ROWS = 25000;
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

        const kept = all.filter((r) => {
          if (verifiedOnly && r.email_status !== 'verified') return false;
          if (!includeCatchAll && r.email_status === 'catch_all') return false;
          return true;
        });

        if (kept.length === 0) {
          setError('No records matched your quality filters. Try including unverified or catch-all addresses.');
          setBusy(false);
          return;
        }

        const cols: ExportColumn[] = [
          { header: 'Email', value: (r: any) => r.email ?? '' },
          { header: 'Email status', value: (r: any) => emailStatusLabel(r.email_status).label },
          { header: 'Company', value: (r: any) => r.company_name ?? '' },
          { header: 'Domain', value: (r: any) => r.domain ?? '' },
          { header: 'Person', value: (r: any) => r.person_name ?? '' },
          { header: 'Title', value: (r: any) => r.title ?? '' },
          { header: 'Phone', value: (r: any) => r.phone ?? '' },
          ...[...passthrough].sort().map((k) => ({
            header: k,
            value: (r: any) => r.extra?.[k] ?? '',
          })),
        ];

        if (includeAttempts) {
          cols.push(
            { header: 'Email provider', value: (r: any) => (r.email_provider ? providerLabel(r.email_provider) : '') },
            { header: 'Phone provider', value: (r: any) => (r.phone_provider ? providerLabel(r.phone_provider) : '') },
            { header: 'Credits charged', value: (r: any) => r.credits ?? 0 },
            { header: 'Provider cost ($)', value: (r: any) => r.treg_cost_usd ?? 0 },
          );
        }

        const filename = exportFilename(runId, kept.length, format);
        if (format === 'csv') {
          downloadCsv(cols, kept, filename);
        } else {
          await downloadXlsx(cols, kept, filename);
        }
      } else {
        // CRM / People export
        let contacts: Contact[] = [];
        if (!allMatching && selectedCount > 0) {
          // If a few are ticked, page to get their details
          const r = await queryContacts(contactFilters ?? {}, contactSort ?? { field: 'updated_at', dir: 'desc' }, 0, 500);
          contacts = r.contacts.filter((c) => selectedIds.includes(c.id));
        } else {
          for (let p = 0; p < 50; p++) {
            setProgress(`Fetching page ${p + 1}…`);
            const r = await queryContacts(contactFilters ?? {}, contactSort ?? { field: 'updated_at', dir: 'desc' }, p, 500);
            contacts = contacts.concat(r.contacts);
            if (r.contacts.length < 500 || contacts.length >= 25000) break;
          }
        }

        const kept = contacts.filter((c) => {
          if (verifiedOnly && c.email_status !== 'verified') return false;
          if (!includeCatchAll && c.email_status === 'catch_all') return false;
          return true;
        });

        if (kept.length === 0) {
          setError('No contacts met your quality filter. Try unticking verified-only.');
          setBusy(false);
          return;
        }

        const cols: ExportColumn[] = [
          { header: 'Name', value: (c: Contact) => c.person_name ?? '' },
          { header: 'Title', value: (c: Contact) => c.title ?? '' },
          { header: 'Company', value: (c: Contact) => c.company_name ?? '' },
          { header: 'Domain', value: (c: Contact) => c.domain ?? '' },
          { header: 'Email', value: (c: Contact) => c.email ?? '' },
          { header: 'Email status', value: (c: Contact) => emailStatusLabel(c.email_status).label },
          { header: 'Phone', value: (c: Contact) => c.phone ?? '' },
          { header: 'LinkedIn', value: (c: Contact) => c.linkedin_url ?? '' },
          { header: 'Location', value: (c: Contact) => c.location ?? '' },
          { header: 'Fit score', value: (c: Contact) => c.score ?? '' },
          { header: 'Fit label', value: (c: Contact) => c.score_label ?? '' },
          { header: 'Status', value: (c: Contact) => c.status ?? '' },
          { header: 'Tags', value: (c: Contact) => (c.tags ?? []).join('; ') },
          { header: 'Source', value: (c: Contact) => c.source ?? '' },
          { header: 'Updated', value: (c: Contact) => c.updated_at?.slice(0, 10) ?? '' },
        ];

        if (includeAttempts) {
          cols.push(
            { header: 'Email verified at', value: (c: Contact) => c.email_checked_at?.slice(0, 10) ?? '' },
            { header: 'Email found by', value: (c: Contact) => (c.email_provider ? providerLabel(c.email_provider) : '') },
            { header: 'Phone found by', value: (c: Contact) => (c.phone_provider ? providerLabel(c.phone_provider) : '') },
          );
        }

        const filename = `leads-export-${kept.length}-${new Date().toISOString().slice(0, 10)}.${format}`;
        if (format === 'csv') {
          downloadCsv(cols, kept, filename);
        } else {
          await downloadXlsx(cols, kept, filename);
        }
      }

      onClose();
    } catch (err) {
      setError((err as Error)?.message ?? 'The export failed. Please try again.');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <Modal
      title="Export Leads"
      onClose={onClose}
      size="md"
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void startExport()} disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {progress || 'Exporting…'}
              </>
            ) : (
              <>
                <Download className="w-3.5 h-3.5" />
                Download {format.toUpperCase()}
              </>
            )}
          </Button>
        </>
      }
    >
      <div className="space-y-5 text-xs font-mono">
        {/* Format Selector */}
        <div>
          <label className="text-[10px] uppercase tracking-wider text-muted block mb-2 font-bold">
            File Format
          </label>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setFormat('csv')}
              className={`flex items-center gap-2 p-3 border text-left cursor-pointer transition-colors ${
                format === 'csv'
                  ? 'border-ink bg-surface font-medium text-ink'
                  : 'border-line bg-white text-muted hover:border-ink hover:text-ink'
              }`}
            >
              <FileText className="w-4 h-4 text-ink" />
              <div>
                <div className="font-bold text-ink">CSV</div>
                <div className="text-[10px] text-muted">Universal compatibility</div>
              </div>
            </button>
            <button
              type="button"
              onClick={() => setFormat('xlsx')}
              className={`flex items-center gap-2 p-3 border text-left cursor-pointer transition-colors ${
                format === 'xlsx'
                  ? 'border-ink bg-surface font-medium text-ink'
                  : 'border-line bg-white text-muted hover:border-ink hover:text-ink'
              }`}
            >
              <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
              <div>
                <div className="font-bold text-ink">Excel (.xlsx)</div>
                <div className="text-[10px] text-muted">Spreadsheet ready</div>
              </div>
            </button>
          </div>
        </div>

        {/* Quality Filters */}
        <div className="space-y-2 border-t border-line-soft pt-4">
          <label className="text-[10px] uppercase tracking-wider text-muted block mb-1 font-bold">
            Email Quality Filters
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={verifiedOnly}
              onChange={(e) => setVerifiedOnly(e.target.checked)}
              className="mt-0.5 accent-ink"
            />
            <div>
              <span className="text-ink">Verified emails only</span>
              <p className="text-[10px] text-muted">
                Best for cold outreach: protects sender reputation by excluding unverified rows.
              </p>
            </div>
          </label>

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={includeCatchAll}
              disabled={verifiedOnly}
              onChange={(e) => setIncludeCatchAll(e.target.checked)}
              className="mt-0.5 accent-ink disabled:opacity-40"
            />
            <div>
              <span className={verifiedOnly ? 'text-muted' : 'text-ink'}>Include catch-all domains</span>
              <p className="text-[10px] text-muted">
                Domains that accept all emails but cannot be 100% verified.
              </p>
            </div>
          </label>
        </div>

        {/* Audit Details */}
        <div className="space-y-2 border-t border-line-soft pt-4">
          <label className="text-[10px] uppercase tracking-wider text-muted block mb-1 font-bold">
            Audit Columns
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={includeAttempts}
              onChange={(e) => setIncludeAttempts(e.target.checked)}
              className="mt-0.5 accent-ink"
            />
            <div>
              <span className="text-ink">Include provider lookup & waterfall details</span>
              <p className="text-[10px] text-muted">
                Adds columns showing which provider found each lead, check timestamp, and verification status.
              </p>
            </div>
          </label>
        </div>

        {/* Summary note */}
        <div className="p-3 bg-surface border border-line text-[11px] text-ink-2 leading-relaxed">
          {countToExport > 0 ? (
            <span>
              Ready to export approximately <strong>{countToExport.toLocaleString()}</strong> leads.
            </span>
          ) : (
            <span>Exporting all matching leads.</span>
          )}
        </div>

        {error && (
          <div className="p-3 bg-danger-bg border border-danger-line text-danger-ink text-xs">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
};
