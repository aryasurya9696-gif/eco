/**
 * Where a row goes when another row is expanded.
 *
 * The leads table is virtualised: every row is absolutely positioned at the
 * offset the virtualizer computed for it, and the virtualizer assumes every row
 * is the same fixed height. An expanded row's detail panel is not one of those
 * rows, so nothing in the virtualizer's arithmetic knows it exists.
 *
 * The panel used to be positioned below its own row and the rows beneath it left
 * exactly where they were, which drew the panel on top of them - and since they
 * come later in the document they painted on top of the panel. A row's whole
 * attempt history ended up interleaved with three unrelated companies, which is
 * what it looks like in the screenshot this was written for.
 *
 * Pure, so the arithmetic can be tested without a browser. The bug was a
 * rendering bug and untested rendering arithmetic is how it came back twice.
 */

/**
 * How far down the row at `index` is drawn from the virtualizer's own offset.
 *
 * `expandedIndex` is the index of the open row, or -1 when nothing is open.
 * `panelHeight` is the measured height of its panel, which is not known until it
 * has rendered and which changes when its content arrives.
 *
 * Returns 0 for the open row itself: its panel is positioned relative to the
 * row rather than to whatever comes after it.
 */
export function rowShift(index: number, expandedIndex: number, panelHeight: number): number {
  if (expandedIndex < 0) return 0;
  if (index === expandedIndex) return 0;
  if (index < expandedIndex) return 0;
  return panelHeight > 0 ? panelHeight : 0;
}

/**
 * The extra scrollable height an open row adds below the last row.
 *
 * Without it the final row of the list cannot be scrolled far enough to read
 * its own panel - the virtualizer thinks the content ends at the last row and
 * the panel is drawn past the end of the scroll range.
 */
export function extraScrollHeight(expandedIndex: number, panelHeight: number): number {
  return expandedIndex >= 0 && panelHeight > 0 ? panelHeight : 0;
}