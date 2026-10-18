import React from 'react';
import { Check, AlertTriangle, ArrowRight } from 'lucide-react';
import type { MappedRow } from '../../lib/leads-csv';

/**
 * Which column in the file is which field.
 *
 * Automatic, but shown and editable, because the automatic answer being wrong is
 * the difference between a clean list and a ruined one: mapping "email status" to
 * the email field sends a column of the words "verified" and "invalid" to a
 * provider as if they were addresses.
 *
 * Required means something different per mode, which is why the requirement is
 * computed here rather than baked in: verifying addresses needs an email,
 * refinding needs something to look up.
 */

export type FieldKey = keyof Omit<MappedRow, 'extra'>;

/**
 * What each field needs for a row to be workable at all.
 *
 * `domain` alone is enough because the company step can go from a bare domain.
 * A name alone is not, because there is nothing to match it against — which is
 * why the unusable count from dedupe exists.
 */
export const FIELD_LABEL: Record<FieldKey, string> = {
  person_name: 'Name',
  first_name: 'First name',
  last_name: 'Last name',
  company_name: 'Company',
  domain: 'Domain',
  website: 'Website',
  title: 'Title',
  email: 'Email',
  linkedin_url: 'LinkedIn',
};

const ORDER: FieldKey[] = [
  'person_name',
  'first_name',
  'last_name',
  'title',
  'company_name',
  'domain',
  'website',
  'email',
  'linkedin_url',
];

export type CleanMode = 'free_import' | 'verify_only' | 'verify_refind' | 'full_enrich';

/** What has to be present before the mode can run at all. */
function requirements(mode: CleanMode): { need: FieldKey[]; needOneOf: FieldKey[][] } {
  switch (mode) {
    case 'free_import':
      // Any record with a name, email, company or domain can be imported
      return { need: [], needOneOf: [['email'], ['person_name'], ['first_name'], ['company_name'], ['domain']] };
    case 'verify_only':
      // Verifying an address you already hold needs the address.
      return { need: ['email'], needOneOf: [] };
    case 'verify_refind':
      // Has to be able to look the person up: an address, or a name with
      // something to match the name against.
      return { need: [], needOneOf: [['email'], ['person_name', 'domain'], ['first_name', 'last_name', 'domain']] };
    case 'full_enrich':
      return { need: [], needOneOf: [['email'], ['domain'], ['company_name']] };
  }
}

export function checkMapping(
  mapping: Partial<Record<FieldKey, string>>,
  mode: CleanMode,
): { ok: boolean; missing: string[] } {
  const { need, needOneOf } = requirements(mode);
  const missing: string[] = [];

  for (const f of need) {
    if (!mapping[f]) missing.push(FIELD_LABEL[f]);
  }

  for (const group of needOneOf) {
    const satisfied = group.every((f) => mapping[f]);
    if (!satisfied) {
      // Reported as the first field of the first unmet group, which is the one
      // worth naming. Listing all three alternatives reads as a requirements
      // list the file has failed rather than as one thing to fix.
      missing.push(group.map((f) => FIELD_LABEL[f]).join(' + '));
      break;
    }
  }

  return { ok: missing.length === 0, missing };
}

interface ColumnMapperProps {
  headers: string[];
  sample: Record<string, string>[];
  mapping: Partial<Record<FieldKey, string>>;
  onChange: (mapping: Partial<Record<FieldKey, string>>) => void;
  mode: CleanMode;
}

/** First non-empty value in the sample, so the preview is not all blanks. */
function sampleValue(rows: Record<string, string>[], col: string | undefined): string {
  if (!col) return '';
  for (const r of rows) {
    const v = r[col];
    if (v !== undefined && String(v).trim() !== '') return String(v);
  }
  return '';
}

export const ColumnMapper: React.FC<ColumnMapperProps> = ({
  headers,
  sample,
  mapping,
  onChange,
  mode,
}) => {
  const { ok, missing } = checkMapping(mapping, mode);

  // Which columns are already spoken for, so the dropdown can grey them out
  // rather than silently producing a file where "Email" feeds two fields.
  const claimedBy = new Map<string, FieldKey>();
  for (const [field, col] of Object.entries(mapping)) {
    if (col) claimedBy.set(col, field as FieldKey);
  }

  const mapped = new Set(Object.values(mapping).filter(Boolean) as string[]);
  const passthrough = headers.filter((h) => !mapped.has(h));

  const set = (field: FieldKey, col: string) => {
    const next = { ...mapping };
    if (col === '') {
      delete next[field];
    } else {
      // Take the column off whichever field had it, so one column cannot feed
      // two fields. The last assignment wins, which is what a person adjusting
      // a form expects.
      for (const [f, c] of Object.entries(next)) {
        if (c === col && f !== field) delete next[f as FieldKey];
      }
      next[field] = col;
    }
    onChange(next);
  };

  return (
    <div className="bg-white border border-line">
      <div className="px-4 py-3 border-b border-line flex items-center gap-3">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted">
          Match your columns
        </span>
        <span className="text-[10px] font-mono text-faint">
          {mapped.size} of {headers.length} mapped
        </span>
        {!ok && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-mono text-warn">
            <AlertTriangle className="w-3 h-3" />
            needs {missing[0]}
          </span>
        )}
      </div>

      <div className="divide-y divide-line-soft">
        {ORDER.map((field) => {
          const current = mapping[field];

          return (
            <div key={field} className="flex items-center gap-3 px-4 h-11">
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted w-32 shrink-0">
                {FIELD_LABEL[field]}
              </span>

              <ArrowRight className="w-3 h-3 text-line shrink-0" />

              <select
                value={current ?? ''}
                onChange={(e) => set(field, e.target.value)}
                className="bg-transparent text-[11px] font-mono text-ink focus:outline-none focus:ring-0 cursor-pointer w-40 shrink-0"
              >
                <option value="">— not mapped —</option>
                {headers.map((h) => (
                  // A column already feeding another field is offered rather than
                  // disabled, and marked. Disabling it would leave somebody who
                  // genuinely wants the override staring at a dead control; the
                  // suffix says what will happen instead.
                  <option key={h} value={h}>
                    {h}
                    {claimedBy.get(h) && claimedBy.get(h) !== field ? ' · in use' : ''}
                  </option>
                ))}
              </select>

              {/* A live value from the file, so a wrong mapping is visible before
                  the run rather than after it. */}
              <span className="text-[10px] font-mono text-muted truncate flex-1 min-w-0">
                {current ? sampleValue(sample, current) : <span className="text-line-strong">no column chosen</span>}
              </span>

              {current && (
                <Check className="w-3 h-3 text-ok shrink-0" aria-hidden="true" />
              )}
            </div>
          );
        })}
      </div>

      {passthrough.length > 0 && (
        <div className="px-4 py-3 border-t border-line bg-surface-2">
          <p className="text-[10px] font-mono text-muted leading-relaxed">
            Kept as-is in the export:{' '}
            <span className="text-ink-2">{passthrough.join(', ')}</span>
          </p>
        </div>
      )}
    </div>
  );
};