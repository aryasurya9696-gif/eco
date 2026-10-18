/**
 * The bits of a lead segment that are arithmetic rather than markup.
 *
 * Separated out because both of these were bugs and neither is visible on the
 * screen: a company size that becomes NaN, and a save that drops the other
 * segments. Putting them behind functions that a test can call is the only way
 * they get tested at all.
 *
 * No React in here. Everything in this file is a pure function of what it is
 * given, which is the whole point.
 */

export type EmployeeRange = [number, number] | null | undefined;

/**
 * The company-size bands, as numbers.
 *
 * These used to be strings — '1-10', '1000+' — parsed back into a pair at the
 * point of use. '1000+' has no hyphen in it, so the parse produced
 * [NaN, NaN], and that NaN was written into the saved profile. The run then
 * refused to start, with a message about the profile, when the real fault was
 * one chip in this file.
 *
 * The bounds are the data now and the label is the presentation, so there is no
 * parse to get wrong.
 */
export const SIZE_BANDS: Array<{ label: string; lo: number; hi: number }> = [
  { label: '1–10', lo: 1, hi: 10 },
  { label: '11–50', lo: 11, hi: 50 },
  { label: '51–200', lo: 51, hi: 200 },
  { label: '201–1000', lo: 201, hi: 1000 },
  // Starts at 1001, not 1000, because 201–1000 already ends at 1000.
  //
  // The overlap is not a cosmetic problem: a company of exactly 1000 staff
  // matched two bands, so `sizeLabelOf` depended on which one it found first,
  // and the one it did not find left the chip row with nothing selected on a
  // profile that plainly had a size. Relabelled rather than made to overlap,
  // because a band called "1000+" that starts at 1001 is a lie in the same
  // direction as the band that starts at 1000 and is quietly wrong about the
  // same company.
  { label: '1001+', lo: 1001, hi: 999999 },
];

/**
 * The band a range falls in, or null.
 *
 * Tolerates the junk an older profile can hold — a pair of nulls, a missing
 * half, a pair of strings, NaN — by refusing to answer rather than guessing. A
 * stored [5, 25] has no band, and returning null is what lets the caller say so
 * on screen instead of showing nothing selected and leaving the user to wonder
 * whether their filter is being applied.
 */
export function sizeLabelOf(range: EmployeeRange): string | null {
  if (!Array.isArray(range) || range.length !== 2) return null;

  const lo = Number(range[0]);
  const hi = Number(range[1]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;

  const band = SIZE_BANDS.find((b) => b.lo === lo && b.hi === hi);
  if (band) return band.label;

  // A band from the previous build. The open-ended one is the only one that can
  // land here in practice, because it is the one that was stored under a label
  // the current bands no longer use - and without this the user opens a profile
  // they set up last week and the size they chose is simply not there, with
  // nothing to say so.
  for (const [label, legacy] of Object.entries(SIZES_LEGACY)) {
    if (legacy.lo === lo && legacy.hi === hi) return label;
  }

  return null;
}

/**
 * The bounds for a band label, or the default when the label is not one.
 *
 * Falls back rather than returning null because every caller has to produce a
 * range: the form always shows a size, and a missing one would mean searching
 * with a filter the user never chose.
 */
export function sizeBoundsOf(label: string): [number, number] {
  const band = SIZE_BANDS.find((b) => b.label === label);
  if (band) return [band.lo, band.hi];

  // The old label is accepted so a profile saved by the previous build still
  // resolves. '1000+' is the case that motivated this, and it is the one that
  // used to produce NaN.
  const legacy = SIZES_LEGACY[label];
  return legacy ? [legacy.lo, legacy.hi] : [11, 50];
}

// Declared below sizeLabelOf on purpose: that function reads it, and a const
// used before its declaration throws rather than being undefined.
const SIZES_LEGACY: Record<string, { lo: number; hi: number }> = {
  '1–10': { lo: 1, hi: 10 },
  '1-10': { lo: 1, hi: 10 },
  '11–50': { lo: 11, hi: 50 },
  '11-50': { lo: 11, hi: 50 },
  '51–200': { lo: 51, hi: 200 },
  '51-200': { lo: 51, hi: 200 },
  '201–1000': { lo: 201, hi: 1000 },
  '201-1000': { lo: 201, hi: 1000 },
  // Both spellings of the open-ended band. The '1000+' one is what the previous
  // build stored, and it is the band that could never be read back: the label
  // claims 1000 while the range it held started at 1001, so a profile using it
  // showed no selection at all.
  '1000+': { lo: 1000, hi: 999999 },
  '1001+': { lo: 1001, hi: 999999 },
};

/**
 * Whether a range is a number at all.
 *
 * The backend refuses a run whose company size is not a number rather than
 * dropping the filter, because a profile that reads "1000 or more" and a
 * profile that reads "NaN" are indistinguishable once they are both in the
 * database, and silently dropping the filter would search every company instead
 * of the large ones.
 */
export function sizeIsJunk(range: unknown): boolean {
  if (range === null || range === undefined) return false;
  if (!Array.isArray(range) || range.length !== 2) return true;

  // Checked before the coercion rather than after it. Number(null) is 0 and
  // Number('') is 0, both of which are finite, so a profile stored with a null
  // bound passed this check and was sent to the provider as "zero employees and
  // up" - which matches nothing, silently.
  //
  // Typed unknown rather than EmployeeRange because narrowing to
  // [number, number] is exactly what this function exists to doubt. The type
  // says what we write; this checks what was actually written.
  for (const v of range) {
    if (v === null || v === undefined || v === '') return true;
    if (typeof v === 'string' && v.trim() === '') return true;
    if (typeof v === 'number' && !Number.isFinite(v)) return true;
    if (typeof v !== 'number' && typeof v !== 'string') return true;
    if (!Number.isFinite(Number(v))) return true;
  }

  const lo = Number(range[0]);
  const hi = Number(range[1]);
  // Inverted is junk too. It parses, it is finite, and it is not a size.
  return lo > hi;
}

/**
 * What the search will actually be asked for, in the user's words.
 *
 * Shown on the button as a check that the form says what they think it says,
 * because the query that goes to the provider is not the same string as any one
 * field: keywords and industries are joined, and the name stands in only when
 * there is nothing else. Showing the field the user filled in is a different
 * claim from showing what will be searched.
 */
export function searchTextOf(segment: {
  name?: string | null;
  industries?: string[] | null;
  keywords?: string[] | null;
}): string {
  const keywords = (segment.keywords ?? []).filter((k) => k && k.trim());
  const industries = (segment.industries ?? []).filter((i) => i && i.trim());
  const joined = [...keywords, ...industries].join(' ').trim();
  if (joined) return joined;
  return (segment.name ?? '').trim();
}

/** Whether this segment is worth running. Matches the backend exactly. */
export function isSearchable(segment: {
  name?: string | null;
  industries?: string[] | null;
  keywords?: string[] | null;
  employeeRange?: EmployeeRange;
}): boolean {
  if (sizeIsJunk(segment.employeeRange)) return false;
  return searchTextOf(segment).length > 0;
}

/**
 * Puts an edited segment back into a document without losing the others.
 *
 * This is the whole function. The form saves with
 *
 *   { ...doc, segments: [segment], primarySegment: 0 }
 *
 * which is correct for a document with one segment and destroys one with three.
 * Two segments of a real profile, the second one built by "find more" on the
 * first, and saving the second from this screen replaced both with the one
 * being edited — with no confirmation, no error and no way back.
 *
 * The primary index is kept rather than reset to 0, so a run started from the
 * second segment still searches the second segment.
 */
export function mergeSegment<T>(
  doc: { segments?: T[]; primarySegment?: number } | null | undefined,
  segment: T,
): { segments: T[]; primarySegment: number } {
  const existing = Array.isArray(doc?.segments) ? [...doc!.segments!] : [];
  const primary = Number(doc?.primarySegment ?? 0);
  const at = Number.isFinite(primary) && primary >= 0 ? primary : 0;

  if (existing.length === 0) {
    return { segments: [segment], primarySegment: 0 };
  }

  // Past the end rather than at a hole: a document whose primarySegment is 7
  // with three segments is malformed, and appending keeps the segment the user
  // just edited instead of losing it.
  if (at >= existing.length) {
    existing.push(segment);
    return { segments: existing, primarySegment: existing.length - 1 };
  }

  existing[at] = segment;
  return { segments: existing, primarySegment: at };
}