/**
 * Echo Leads — CSV in, CSV and Excel out
 * ----------------------------------------------------------------------------
 * The parsing, mapping and de-duplicating, kept out of the components so it can
 * be tested without a browser and so the two export formats cannot drift apart
 * in how they name a column.
 *
 * Two rules shape everything here.
 *
 * Unmapped columns are never dropped. A user who imported a list with a "Notes"
 * or "Last contacted" column gets those back in the export, because a clean that
 * silently deletes their own data is a clean they will not trust.
 *
 * De-duplication happens in the browser, before the run exists. The database is
 * the wrong place for it: the same file uploaded twice should not cost the user
 * two rows' worth of verification.
 */

import Papa from 'papaparse';

// ---------------------------------------------------------------------------
// What the function accepts
// ---------------------------------------------------------------------------

export interface MappedRow {
  person_name?: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  domain?: string;
  website?: string;
  title?: string;
  email?: string;
  linkedin_url?: string;
  /** Anything the file had that Echo does not model. Carried to the export. */
  extra: Record<string, string>;
}

export interface MappedRun {
  rows: MappedRow[];
  /** Columns the file had that are not on the map. Kept in every row's extra. */
  passthroughColumns: string[];
}

/** Header spellings actually seen in the wild, not the ones we wished for. */
const HEADER_ALIASES: Record<keyof Omit<MappedRow, 'extra'>, string[]> = {
  person_name: ['person_name', 'person name', 'full name', 'fullname', 'name', 'contact', 'contact name'],
  first_name: ['first_name', 'first name', 'firstname', 'given name'],
  last_name: ['last_name', 'last name', 'lastname', 'surname', 'family name'],
  company_name: ['company_name', 'company name', 'company', 'organisation', 'organization', 'org', 'business', 'account'],
  domain: ['domain', 'website domain', 'site', 'url', 'web site', 'website'],
  website: ['website', 'web site', 'site', 'url', 'homepage'],
  title: ['title', 'job title', 'role', 'position', 'seniority'],
  email: ['email', 'e-mail', 'email address', 'emailaddress', 'work email', 'business email'],
  linkedin_url: ['linkedin_url', 'linkedin', 'linkedin url', 'linkedin profile', 'li url'],
};

const norm = (s: string): string => s.trim().toLowerCase().replace(/[\s_-]+/g, ' ');

/**
 * Works out which column is which from the header row.
 *
 * Exact header matches win over contains-matches, because "email" is inside
 * "work email address" and inside "email status", and taking the first contains
 * hit would map the wrong one depending on column order.
 */
export function autoMap(headers: string[]): {
  mapping: Partial<Record<keyof Omit<MappedRow, 'extra'>, string>>;
  unmapped: string[];
} {
  const normalised = headers.map((h) => ({ raw: h, key: norm(h) }));
  const claimed = new Set<string>();
  const mapping: Partial<Record<keyof Omit<MappedRow, 'extra'>, string>> = {};

  // Pass 1: exact matches.
  for (const field of Object.keys(HEADER_ALIASES) as Array<keyof typeof HEADER_ALIASES>) {
    for (const { raw, key } of normalised) {
      if (claimed.has(raw)) continue;
      if (HEADER_ALIASES[field].includes(key)) {
        mapping[field] = raw;
        claimed.add(raw);
        break;
      }
    }
  }

  // Pass 2: substring, only for what is still unmapped. "email status" would be
  // claimed here if the file had no plain email column, which is a better answer
  // than nothing.
  //
  // Best match, not first match. A file with "email status" before "work email
  // address" matched the shorter needle first and mapped the address column to
  // "email status", because nothing matched exactly and the loop walked columns
  // in file order. Columns arrive in whatever order the exporting tool wrote
  // them, so first match makes the mapping a property of the file's layout
  // rather than of what the headers mean.
  //
  // Scored by the longest needle a header contains, so "work email address"
  // (contains "email address", 13 characters) beats "email status" (contains
  // "email", 5). Ties go to the earlier column, which is arbitrary but stable.
  for (const field of Object.keys(HEADER_ALIASES) as Array<keyof typeof HEADER_ALIASES>) {
    if (mapping[field]) continue;

    const needles = HEADER_ALIASES[field];

    // Collected first, then reduced. Assigning to a `let` inside the callback and
    // reading it after would be the same logic, but TypeScript narrows the
    // variable to `null` at the point of the read because it cannot see an
    // assignment that happened inside a closure — so `best` narrows to `never`
    // and the code fails to compile while being correct.
    const candidates = normalised
      .map(({ raw: col, key }, order) => {
        if (claimed.has(col)) return null;
        let score = 0;
        for (const n of needles) if (key.includes(n) && n.length > score) score = n.length;
        return score === 0 ? null : { col, score, order };
      })
      .filter((c): c is { col: string; score: number; order: number } => c !== null);

    if (candidates.length > 0) {
      const best = candidates.reduce((a, b) => (b.score > a.score ? b : a));
      mapping[field] = best.col;
      claimed.add(best.col);
    }
  }

  return {
    mapping,
    unmapped: headers.filter((h) => !claimed.has(h)),
  };
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export interface ParseResult {
  headers: string[];
  rows: Record<string, string>[];
  /** Rows the parser could not read, reported rather than silently skipped. */
  malformed: number;
}

export function parseCsv(file: File): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      // Everything stays a string. Casting "007" or a long account number to a
      // number here would round it before Echo ever sees it, and the export
      // would hand back something the user never uploaded.
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim(),
      complete: (results) => {
        const headers = results.meta.fields ?? [];
        const rows = results.data.filter(
          (r) => Object.values(r).some((v) => String(v ?? '').trim() !== ''),
        );
        resolve({
          headers,
          rows,
          malformed: results.errors.filter((e) => e.code !== 'TooFewFields').length,
        });
      },
      error: (err) => reject(err),
    });
  });
}

// ---------------------------------------------------------------------------
// Apply the mapping
// ---------------------------------------------------------------------------

const pick = (row: Record<string, string>, col?: string): string | undefined => {
  if (!col) return undefined;
  const v = row[col];
  if (v === undefined || v === null) return undefined;
  const t = String(v).trim();
  return t === '' ? undefined : t;
};

/**
 * Pulls a bare domain out of anything that looks like a URL or an address.
 *
 * "https://acme.com/pricing" and "ACME.COM" and "acme.com" have to reduce to the
 * same thing, because a domain is what the provider lookups key on and three
 * spellings of one company is three companies.
 */
export function normaliseDomain(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '');
  s = s.split('/')[0];
  s = s.split('?')[0];
  s = s.split('@').pop() ?? s;
  s = s.split(':')[0];
  if (!s.includes('.') || s.endsWith('.')) return undefined;
  return s;
}

/** Only an address that will send mail, not one that will bounce in the face of a domain. */
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;

export function normaliseEmail(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim().toLowerCase();
  return EMAIL_RE.test(t) ? t : undefined;
}

export function applyMapping(
  rows: Record<string, string>[],
  mapping: Partial<Record<keyof Omit<MappedRow, 'extra'>, string>>,
  unmapped: string[],
): MappedRun {
  const out: MappedRow[] = [];

  for (const row of rows) {
    const email = normaliseEmail(pick(row, mapping.email));
    const first = pick(row, mapping.first_name);
    const last = pick(row, mapping.last_name);
    const named = pick(row, mapping.person_name);
    const person = named ?? (first || last ? [first, last].filter(Boolean).join(' ') : undefined);

    const domain =
      normaliseDomain(pick(row, mapping.domain)) ?? normaliseDomain(pick(row, mapping.website));

    // Everything the map did not claim, kept under its own header. Replaced on
    // import if the same key comes back twice, so the last wins rather than
    // producing an object that stringifies to [object Object].
    const extra: Record<string, string> = {};
    for (const col of unmapped) {
      const v = pick(row, col);
      if (v !== undefined) extra[col] = v;
    }

    out.push({
      ...(person ? { person_name: person } : {}),
      ...(first ? { first_name: first } : {}),
      ...(last ? { last_name: last } : {}),
      ...(pick(row, mapping.company_name) ? { company_name: pick(row, mapping.company_name)! } : {}),
      ...(domain ? { domain } : {}),
      ...(pick(row, mapping.website) ? { website: pick(row, mapping.website)! } : {}),
      ...(pick(row, mapping.title) ? { title: pick(row, mapping.title)! } : {}),
      ...(email ? { email } : {}),
      ...(pick(row, mapping.linkedin_url) ? { linkedin_url: pick(row, mapping.linkedin_url)! } : {}),
      extra,
    });
  }

  return { rows: out, passthroughColumns: unmapped };
}

// ---------------------------------------------------------------------------
// De-duplicate
// ---------------------------------------------------------------------------

export interface DedupeResult {
  rows: MappedRow[];
  /** How many were dropped, and why, so the count is not just a number. */
  removed: number;
  /** Rows with neither an email nor a name+domain, which cannot be worked. */
  unusable: number;
}

/**
 * Collapses rows that would produce the same person twice.
 *
 * Keyed on the email when there is one, otherwise on name plus domain. Not
 * domain alone: three people at one company are three leads, and merging on
 * domain would delete two of them.
 *
 * A row with neither an email nor a company is not a duplicate, it is
 * unusable — it has nothing to look anyone up with. Those are counted separately
 * and kept, because dropping a row the user can see is worse than keeping one
 * that will fail.
 */
export function dedupe(rows: MappedRow[]): DedupeResult {
  const seenEmail = new Set<string>();
  const seenPerson = new Set<string>();
  const out: MappedRow[] = [];
  let removed = 0;
  let unusable = 0;

  for (const row of rows) {
    const email = row.email?.toLowerCase();
    const personKey =
      !email && row.person_name && row.domain
        ? `${norm(row.person_name)}|${row.domain}`
        : null;

    if (!email && !personKey) {
      unusable++;
      out.push(row);
      continue;
    }

    if (email) {
      if (seenEmail.has(email)) {
        removed++;
        continue;
      }
      seenEmail.add(email);
    } else if (personKey) {
      if (seenPerson.has(personKey)) {
        removed++;
        continue;
      }
      seenPerson.add(personKey);
    }

    out.push(row);
  }

  return { rows: out, removed, unusable };
}

// ---------------------------------------------------------------------------
// Out
// ---------------------------------------------------------------------------

export interface ExportColumn {
  header: string;
  value: (row: any) => string | number | null | undefined;
}

/**
 * Writes rows as CSV.
 *
 * Formulas are neutralised. A cell beginning with =, +, - or @ is executable in
 * Excel and Sheets, and a lead list is exactly the kind of data that arrives
 * from outside, so a value like `=HYPERLINK("http://evil","click")` in a Notes
 * column would otherwise run when the user opened their own export.
 */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: ExportColumn[], rows: any[]): string {
  const head = columns.map((c) => csvCell(c.header)).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(c.value(r))).join(','));
  return [head, ...body].join('\r\n');
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoked on the next tick rather than immediately: Safari cancels the
  // download if the object URL disappears in the same turn as the click.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(columns: ExportColumn[], rows: any[], filename: string): void {
  downloadBlob(new Blob(['﻿' + toCsv(columns, rows)], { type: 'text/csv;charset=utf-8' }), filename);
}

/**
 * Writes rows as a real .xlsx.
 *
 * From SheetJS's own CDN build rather than npm, which is still pinned at 0.18.5
 * with two known advisories — prototype pollution and ReDoS — and this file
 * handles data that came in from outside.
 */
export async function downloadXlsx(
  columns: ExportColumn[],
  rows: any[],
  filename: string,
  sheetName = 'Leads',
): Promise<void> {
  const XLSX = await import('xlsx');

  const aoa = [
    columns.map((c) => c.header),
    ...rows.map((r) => columns.map((c) => c.value(r) ?? '')),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}

/** run-<id>-<n>leads.csv — a filename that sorts and says what it is. */
export function exportFilename(runId: string, rows: number, ext: 'csv' | 'xlsx'): string {
  return `leads-${runId.slice(0, 8)}-${rows}-${new Date().toISOString().slice(0, 10)}.${ext}`;
}
