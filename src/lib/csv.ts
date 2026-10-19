// ============================================================================
// CSV & file download helpers
// ----------------------------------------------------------------------------
// Shared by every export surface so a company name containing a comma, a title
// containing a quote, or a non-ASCII name cannot produce a file that opens as
// one mangled column in Excel or two extra columns in a CRM import.
//
// Both helpers here exist because the previous inline versions were wrong in
// ways that only showed up in the customer's downloaded file:
//   - values were wrapped in quotes without escaping the quotes inside them,
//     so `"Acme "Global" Ltd"` terminated the field early
//   - the BOM was missing, so Excel decoded UTF-8 as the system codepage
//   - the data: URI ran through encodeURI rather than a Blob, which breaks on
//     long exports and in Safari
// ============================================================================

export type CsvCell = string | number | null | undefined;

const NEEDS_QUOTING = /[",\r\n]/;

/**
 * Values a spreadsheet would execute as a formula.
 *
 * Exported lead data comes from a third-party provider, so a company name like
 * `=HYPERLINK("http://…")` would run when the file is opened in Excel or
 * Sheets. A leading `+` or `-` followed by a digit, space or bracket is left
 * alone so phone numbers such as "+1 (415) 555-0100" survive intact.
 */
const FORMULA_PREFIX = /^(?:[=@\t\r]|[+-](?![\d\s(]))/;

/** One cell. A real quote inside a value is doubled, per RFC 4180. */
function escapeCell(value: CsvCell): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const s = FORMULA_PREFIX.test(raw) ? `'${raw}` : raw;
  return NEEDS_QUOTING.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows -> CSV text. CRLF line endings, which is what Excel expects. */
export function toCsv(rows: CsvCell[][]): string {
  return rows.map((row) => row.map(escapeCell).join(',')).join('\r\n');
}

/**
 * Triggers a browser download.
 *
 * The BOM is prepended deliberately: without it Excel on Windows assumes the
 * system codepage and turns every accented name into mojibake, which then gets
 * pasted into a CRM as corrupted data.
 */
export function downloadTextFile(filename: string, content: string, mime: string): void {
  // The BOM is only meaningful for text/CSV that Excel or a text editor will
  // open: a leading U+FEFF before the `{` of a JSON document makes it invalid
  // JSON, so the JSON export must not carry one.
  const needsBom = mime.startsWith('text/') || mime === 'text/csv';
  const blob = new Blob(needsBom ? ['\uFEFF', content] : [content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next tick rather than immediately: revoking synchronously
  // races the download in some browsers and produces an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(filename: string, rows: CsvCell[][]): void {
  downloadTextFile(filename, toCsv(rows), 'text/csv');
}

/** Strips characters that break an in-memory CSV import. */
export function safeFilenamePart(input: string): string {
  return input.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 60);
}